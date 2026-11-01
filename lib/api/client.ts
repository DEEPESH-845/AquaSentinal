/**
 * Typed client for the AquaSentinal backend. The browser never talks to Meta: every model call goes through these routes.
 */
import type { CaptureResult, HistoryItem, InspectionReport, InterpretResponse, MissionRecord, SystemStatus, TranscriptResult } from "./types";

export const BACKEND_URL = (process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 20_000);
  try {
    const res = await fetch(BACKEND_URL + path, { ...init, signal: init.signal ?? ctrl.signal });
    const text = await res.text();
    const body = text ? safeJson(text) : null;
    if (!res.ok) {
      const b = body as { error?: string; detail?: unknown } | null;
      const msg = typeof b?.error === "string" ? b.error : typeof b?.detail === "string" ? b.detail : `HTTP ${res.status}`;
      throw new ApiError(msg, res.status, b?.detail);
    }
    return body as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if ((e as Error).name === "AbortError") throw new ApiError("backend request timed out", 0);
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

const post = <T>(path: string, body?: unknown, timeoutMs?: number) =>
  request<T>(path, { method: "POST", headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs });

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
  status: () => request<SystemStatus>("/api/system/status", { timeoutMs: 4000 }),
  interpret: (instruction: string, context: TwinContext, offline = false) => post<InterpretResponse>(`/api/ai/interpret${offline ? "?offline=true" : ""}`, { instruction, context }, 90_000),
  start: (id: string) => post<MissionRecord>(`/api/missions/${encodeURIComponent(id)}/start`, { executor: "TWIN" }),
  pause: (id: string) => post<MissionRecord>(`/api/missions/${encodeURIComponent(id)}/pause`),
  resume: (id: string) => post<MissionRecord>(`/api/missions/${encodeURIComponent(id)}/resume`),
  stop: (id: string) => post<MissionRecord>(`/api/missions/${encodeURIComponent(id)}/stop`),
  complete: (id: string, result: unknown) => post<MissionRecord>(`/api/missions/${encodeURIComponent(id)}/complete`, result),
  capture: (form: FormData) => request<CaptureResult>("/api/inspection/capture", { method: "POST", body: form, timeoutMs: 120_000 }),
  report: (id: string) => request<InspectionReport>(`/api/inspection/${encodeURIComponent(id)}/report`),
  history: () => request<HistoryItem[]>("/api/inspection/history"),
  transcribe: (wav: Blob) => {
    const form = new FormData();
    form.append("audio", wav, "command.wav");
    return request<TranscriptResult>("/api/voice/transcribe", { method: "POST", body: form, timeoutMs: 60_000 });
  },
  command: (type: "ESTOP" | "CLEAR_ESTOP" | "STOP") =>
    post<{ ok: boolean; error?: string }>("/api/gantry/command", { v: 1, id: `ui-${Date.now()}`, command: { type } }, 3000),
  reportMarkdownUrl: (id: string) => `${BACKEND_URL}/api/inspection/${encodeURIComponent(id)}/report?format=md`,
  frameUrl: (captureId: string) => `${BACKEND_URL}/api/inspection/frames/${encodeURIComponent(captureId)}`,
};
