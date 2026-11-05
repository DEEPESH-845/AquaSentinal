/**
 * Typed client for the AquaSentinal backend. The browser never talks to Meta: every model call goes through these routes.
 */
import type { CaptureResult, ExecutionLog, HistoryItem, InspectionReport, InterpretResponse, Language, MissionRecord, Preflight, SystemStatus, TranscriptResult, VoiceInputSource } from "./types";

export const BACKEND_URL = (process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
    /** seconds the backend asked the caller to wait (429 Retry-After), when it said */
    readonly retryAfterS?: number,
  ) {
    super(message);
  }
}

/**
 * The live-mode passcode. Kept in sessionStorage so it survives a reload of this tab only, never in the URL or localStorage.
 * The in-memory copy keeps a session working where storage is blocked (private windows, cleared site data).
 */
const PASSCODE_KEY = "aqua.passcode";
let held: string | null | undefined; // undefined: storage not read yet

export function getPasscode(): string | null {
  if (typeof window === "undefined") return null;
  if (held === undefined) {
    try {
      held = sessionStorage.getItem(PASSCODE_KEY);
    } catch {
      held = null;
    }
  }
  return held;
}

export function setPasscode(code: string | null) {
  held = code;
  try {
    if (code) sessionStorage.setItem(PASSCODE_KEY, code);
    else sessionStorage.removeItem(PASSCODE_KEY);
  } catch {
    /* storage blocked: the in-memory copy still serves this page */
  }
}

/**
 * The backend counts a wrong passcode header as a failed attempt on /api/system/status and on the Meta-calling routes (the
 * `live_access` dependency: 10 a minute per address, 30 global); other routes ignore the header. So a rejected passcode is
 * forgotten the moment a response shows it was refused, and is never sent again. `refresh`: the response did not carry fresh
 * status, so the store should re-read it.
 */
let onRejected: ((why: string, refresh: boolean) => void) | null = null;
export const setRejectedHandler = (fn: typeof onRejected) => {
  onRejected = fn;
};

function forget(sent: string | null, why: string, refresh: boolean) {
  if (!sent || getPasscode() !== sent) return; // nothing was sent, or a newer passcode has replaced it since
  setPasscode(null);
  onRejected?.(why, refresh);
}

async function request<T>(path: string, init: RequestInit & { timeoutMs?: number; anonymous?: boolean } = {}): Promise<T> {
  const sent = init.anonymous ? null : getPasscode();
  const headers = new Headers(init.headers);
  if (sent) headers.set("X-Aqua-Passcode", sent);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 20_000);
  // a caller's signal (operator cancel) aborts the same request; the timeout still applies
  init.signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
  try {
    const res = await fetch(BACKEND_URL + path, { ...init, headers, signal: ctrl.signal });
    const text = await res.text();
    const body = text ? safeJson(text) : null;
    if (!res.ok) {
      const b = body as { error?: string; detail?: unknown } | null;
      const msg = typeof b?.error === "string" ? b.error : typeof b?.detail === "string" ? b.detail : `HTTP ${res.status}`;
      // Only the unlock route answers 429 for the passcode throttle (and it is sent anonymously). Any other 429 is Meta rate limiting the
      // backend, not a verdict on the passcode; a throttled address shows up in the status poll as locked, which forgets it there.
      if (res.status === 403 && msg === "live mode locked") forget(sent, "The saved passcode was refused by the backend and has been forgotten.", true);
      const wait = Number(res.headers.get("Retry-After"));
      throw new ApiError(msg, res.status, b?.detail, Number.isFinite(wait) && wait > 0 ? wait : undefined);
    }
    return body as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if ((e as Error).name === "AbortError") throw new ApiError(init.signal?.aborted ? "cancelled by the operator" : "backend request timed out", 0);
    throw new ApiError("backend unreachable", 0);
  } finally {
    clearTimeout(timer);
  }
}

const safeJson = (t: string): unknown => {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};

const post = <T>(path: string, body?: unknown, timeoutMs?: number, signal?: AbortSignal) =>
  request<T>(path, { method: "POST", headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs, signal });

export interface TwinContext {
  gantryX: number;
  gantryY: number;
  moving: boolean;
  turbidity: number;
  lighting: number;
  visibility: number;
  cameraOnline: boolean;
  estop: boolean;
}

export const api = {
  health: () => request<{ status: string; version: string }>("/api/health", { timeoutMs: 3000 }),
  status: async () => {
    const sent = getPasscode();
    const status = await request<SystemStatus>("/api/system/status", { timeoutMs: 4000 });
    // the backend has a lock and did not accept what was sent: it was wrong or changed, so stop sending it
    // (`live` is optional at runtime: a backend from before the credit governor does not send it)
    if (status.live?.lockEnabled && !status.live.unlocked) forget(sent, "The saved passcode no longer works and has been forgotten.", false);
    return status;
  },
  /** Checks a passcode. Sent anonymously: an old stored passcode must not ride along and count as a second failed attempt. */
  unlock: (passcode: string) => request<{ unlocked: boolean }>("/api/system/unlock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passcode }), timeoutMs: 6000, anonymous: true }),
  interpret: (instruction: string, context: TwinContext, offline = false, signal?: AbortSignal, language: Language = "en") =>
    post<InterpretResponse>(`/api/ai/interpret${offline ? "?offline=true" : ""}`, { instruction, context, language }, 90_000, signal),
  start: (id: string) => post<MissionRecord>(`/api/missions/${encodeURIComponent(id)}/start`, { executor: "TWIN" }),
  pause: (id: string) => post<MissionRecord>(`/api/missions/${encodeURIComponent(id)}/pause`),
  resume: (id: string) => post<MissionRecord>(`/api/missions/${encodeURIComponent(id)}/resume`),
  stop: (id: string) => post<MissionRecord>(`/api/missions/${encodeURIComponent(id)}/stop`),
  complete: (id: string, result: unknown) => post<MissionRecord>(`/api/missions/${encodeURIComponent(id)}/complete`, result),
  capture: (form: FormData) => request<CaptureResult>("/api/inspection/capture", { method: "POST", body: form, timeoutMs: 120_000 }),
  report: (id: string) => request<InspectionReport>(`/api/inspection/${encodeURIComponent(id)}/report`),
  history: () => request<HistoryItem[]>("/api/inspection/history"),
  preflight: () => request<Preflight>("/api/system/preflight", { timeoutMs: 4000 }),
  executions: (limit = 50) => request<ExecutionLog>(`/api/evidence/model-executions?limit=${limit}`, { timeoutMs: 4000 }),
  transcribe: (wav: Blob, inputSource: VoiceInputSource = "LIVE_MICROPHONE", language: Language = "en") => {
    const form = new FormData();
    form.append("audio", wav, "command.wav");
    form.append("inputSource", inputSource);
    form.append("language", language);
    return request<TranscriptResult>("/api/voice/transcribe", { method: "POST", body: form, timeoutMs: 60_000 });
  },
  command: (type: "ESTOP" | "CLEAR_ESTOP" | "STOP") =>
    post<{ ok: boolean; error?: string }>("/api/gantry/command", { v: 1, id: `ui-${Date.now()}`, command: { type } }, 3000),
  reportMarkdownUrl: (id: string) => `${BACKEND_URL}/api/inspection/${encodeURIComponent(id)}/report?format=md`,
  frameUrl: (captureId: string) => `${BACKEND_URL}/api/inspection/frames/${encodeURIComponent(captureId)}`,
};
