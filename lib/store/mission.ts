"use client";

import { create } from "zustand";
import { ApiError, api, getPasscode, setPasscode, setRejectedHandler, type TwinContext } from "@/lib/api/client";
import type { CaptureResult, EventEnvelope, ExecutionLog, HistoryItem, InspectionReport, MissionRecord, Preflight, SystemStatus, TranscriptResult, VoiceInputSource } from "@/lib/api/types";
import { PushToTalk } from "@/lib/audio/wav";
import { useSimStore } from "@/lib/sim/store";
import type { CaptureRequest, MissionResult } from "@/lib/sim/types";

/**
 * Backend and AI state for the UI. The simulation store stays the twin's; this store owns everything that crosses the
 * network: system status, the planned mission, captures and their perception results, reports and history.
 */

export type BackendState = "CONNECTING" | "ONLINE" | "OFFLINE";

export interface CaptureView {
  seq: number;
  missionId: string;
  request: CaptureRequest;
  /** object URL of the frame the twin rendered, so the UI shows it before the backend answers */
  frameUrl: string;
  status: "SENDING" | "DONE" | "FAILED" | "NOT_SENT";
  result?: CaptureResult;
  error?: string;
}

interface VoiceState {
  state: "IDLE" | "RECORDING" | "TRANSCRIBING" | "ERROR";
  error?: string;
  latencyMs?: number | null;
  durationMs?: number;
}

/** The last Voice Transcribe result and where its audio came from, so the UI never shows a recorded file as a live voice. */
export type TranscriptView = TranscriptResult & { source: VoiceInputSource };

/** Prepared audio of the demo instruction (synthetic speech, macOS `say`). Always labelled RECORDED_INPUT. */
export const RECORDED_INSTRUCTION_URL = "/demo/instruction.wav";

let interpretCtrl: AbortController | null = null;
let statusInflight: { sent: string | null; done: Promise<void> } | null = null;
/** Numbers the status reads. Only the newest may write: an older read that lands last would show the state from before an unlock or re-lock. */
let statusSeq = 0;

interface MissionStore {
  backend: BackendState;
  /** null until the first successful status read, and again whenever the backend stops answering: unknown is never shown as healthy */
  system: SystemStatus | null;
  /** wall-clock ms of the last successful status read */
  lastStatusOkAt: number | null;
  instruction: string;
  voice: VoiceState;
  transcript: TranscriptView | null;
  preflight: Preflight | null;
  executionLog: ExecutionLog | null;
  interpreting: boolean;
  interpretError: string | null;
  /** the error came from Muse Spark, so the operator may choose the labelled offline parser */
  canFallBack: boolean;
  mission: MissionRecord | null;
  actionError: string | null;
  captures: CaptureView[];
  selectedCapture: number | null;
  report: InspectionReport | null;
  reportError: string | null;
  history: HistoryItem[];
  events: EventEnvelope[];
  /** the unlock dialog is open */
  unlockOpen: boolean;
  /** why a saved passcode was forgotten, shown in the unlock dialog until a passcode works */
  lockNotice: string | null;
  /** wall-clock ms until which the backend refuses passcode attempts (429 Retry-After), or null */
  unlockBlockedUntil: number | null;

  setBackend: (b: BackendState) => void;
  refreshStatus: () => Promise<void>;
  onEvent: (e: EventEnvelope) => void;
  setInstruction: (s: string) => void;
  startVoice: () => Promise<void>;
  stopVoice: () => Promise<void>;
  /** Sends the prepared recording through Voice Transcribe. Returns the transcript, or null with voice.error set. */
  transcribeRecorded: () => Promise<string | null>;
  refreshEvidence: () => Promise<void>;
  interpret: (offline?: boolean) => Promise<MissionRecord | null>;
  /** Aborts a pending planning request. The backend may still record the plan; it is not shown and cannot run unapproved. */
  cancelInterpret: () => void;
  discard: () => void;
  approve: () => Promise<boolean>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  emergencyStop: () => void;
  clearEstop: () => void;
  submitCapture: (req: CaptureRequest, jpeg: Blob, idPng: Blob, idMap: Array<{ index: number; objectId: string; type: string }>) => Promise<void>;
  selectCapture: (seq: number | null) => void;
  finishMission: (result: MissionResult) => Promise<void>;
  loadReport: (missionId: string) => Promise<void>;
  loadHistory: () => Promise<void>;
  setUnlockOpen: (open: boolean) => void;
  /** Checks a passcode with the backend and, if it works, keeps it for this tab. `error` is set when it did not; `blocked`: the attempt limit was hit, so the wait is in `unlockBlockedUntil`. */
  unlock: (passcode: string) => Promise<{ ok: boolean; error?: string; blocked?: boolean }>;
  /** Forgets this tab's passcode, so live mode is locked again for this browser. */
  relock: () => void;
}

const MAX_CAPTURES = 60;
const UPLOAD_WAIT_MS = 30_000;
const recorder = typeof window !== "undefined" ? new PushToTalk() : null;
const msg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

/** What the read-only planning tools are allowed to see. Always the twin's SIMULATED values. */
export function twinContext(): TwinContext {
  const s = useSimStore.getState();
  const t = s.engine.telemetry();
  return {
    gantryX: t.gantry.x,
    gantryY: t.gantry.y,
    moving: t.gantry.moving,
    turbidity: t.environment.turbidity,
    lighting: t.environment.lighting,
    visibility: t.environment.visibility,
    cameraOnline: s.engine.mission ? s.engine.mission.cameraOnline : true,
    estop: t.estop,
  };
}

export const useMissionStore = create<MissionStore>((set, get) => ({
  backend: "CONNECTING",
  lastStatusOkAt: null,
  system: null,
  instruction: "",
  voice: { state: "IDLE" },
  transcript: null,
  preflight: null,
  executionLog: null,
  interpreting: false,
  interpretError: null,
  canFallBack: false,
  mission: null,
  actionError: null,
  captures: [],
  selectedCapture: null,
  report: null,
  reportError: null,
  history: [],
  events: [],
  unlockOpen: false,
  lockNotice: null,
  unlockBlockedUntil: null,

  setBackend: (backend) => set({ backend }),

  refreshStatus: () => {
    // Overlapping reads (mount, socket open, poll) share one request while the passcode is the same: each one that carries a
    // rejected passcode is a failed attempt on the backend.
    const sent = getPasscode();
    if (statusInflight?.sent === sent) return statusInflight.done;
    const seq = ++statusSeq;
    const entry: NonNullable<typeof statusInflight> = { sent, done: Promise.resolve() };
    entry.done = (async () => {
      try {
        const system = await api.status();
        if (seq === statusSeq) set({ system, backend: "ONLINE", lastStatusOkAt: Date.now() });
      } catch {
        // a stale status would keep showing providers LIVE behind an unreachable backend
        if (seq === statusSeq) set({ backend: "OFFLINE", system: null });
      } finally {
        if (statusInflight === entry) statusInflight = null;
      }
    })();
    statusInflight = entry;
    return entry.done;
  },

  onEvent: (e) => {
    set({ events: [...get().events.slice(-49), e] });
    if (e.type === "report.ready") {
      const id = (e.data as { missionId?: string }).missionId;
      if (id && get().report?.mission.id === id) void get().loadReport(id);
      void get().loadHistory();
    }
  },

  setInstruction: (instruction) => set({ instruction }),

  startVoice: async () => {
    if (!recorder || !PushToTalk.supported()) {
      set({ voice: { state: "ERROR", error: "This browser cannot record audio. Type the instruction instead." } });
      return;
    }
    try {
      await recorder.start();
      set({ voice: { state: "RECORDING" } });
    } catch (e) {
      set({ voice: { state: "ERROR", error: (e as Error).name === "NotAllowedError" ? "Microphone permission was denied. Type the instruction instead." : msg(e) } });
    }
  },

  stopVoice: async () => {
    if (!recorder || get().voice.state !== "RECORDING") return;
    set({ voice: { state: "TRANSCRIBING" } });
    try {
      const wav = await recorder.stop();
      const r = await api.transcribe(wav, "LIVE_MICROPHONE");
      set({ instruction: r.transcript, transcript: { ...r, source: "LIVE_MICROPHONE" }, voice: { state: "IDLE", latencyMs: r.latencyMs, durationMs: r.audioDurationMs } });
    } catch (e) {
      recorder.cancel();
      set({ voice: { state: "ERROR", error: msg(e) } });
    }
  },

  transcribeRecorded: async () => {
    set({ voice: { state: "TRANSCRIBING" } });
    try {
      const res = await fetch(RECORDED_INSTRUCTION_URL);
      if (!res.ok) throw new Error(`recorded instruction missing (HTTP ${res.status})`);
      const r = await api.transcribe(await res.blob(), "RECORDED_INPUT");
      set({ instruction: r.transcript, transcript: { ...r, source: "RECORDED_INPUT" }, voice: { state: "IDLE", latencyMs: r.latencyMs, durationMs: r.audioDurationMs } });
      void get().refreshEvidence();
      return r.transcript;
    } catch (e) {
      set({ voice: { state: "ERROR", error: msg(e) } });
      return null;
    }
  },

  refreshEvidence: async () => {
    const [preflight, executionLog] = await Promise.all([api.preflight().catch(() => null), api.executions().catch(() => null)]);
    set({ preflight, executionLog });
  },

  interpret: async (offline = false) => {
    const text = get().instruction.trim();
    if (text.length < 3) {
      set({ interpretError: "Describe the inspection first." });
      return null;
    }
    interpretCtrl?.abort();
    const ctrl = (interpretCtrl = new AbortController());
    set({ interpreting: true, interpretError: null, canFallBack: false, actionError: null });
    try {
      const r = await api.interpret(text, twinContext(), offline, ctrl.signal);
      set({ mission: r.mission, interpreting: false });
      void get().refreshEvidence();
      return r.mission;
    } catch (e) {
      if (ctrl.signal.aborted) {
        if (interpretCtrl === ctrl) set({ interpreting: false, interpretError: "Planning cancelled. Edit the instruction and plan again." });
        return null;
      }
      const live = get().system?.providers.spark.status === "LIVE";
      set({ interpreting: false, interpretError: msg(e), canFallBack: live && !offline && e instanceof ApiError && e.status !== 0 });
      return null;
    }
  },

  cancelInterpret: () => interpretCtrl?.abort(),

  discard: () => set({ mission: null, interpretError: null, actionError: null }),

  approve: async () => {
    const m = get().mission;
    if (!m) return false;
    set({ actionError: null });
    try {
      const started = await api.start(m.id);
      const ok = useSimStore.getState().runMission(m.plan, true);
      if (!ok) {
        await api.stop(m.id).catch(() => undefined);
        set({ actionError: "The twin refused the plan (is the emergency stop latched?)." });
        return false;
      }
      set({ mission: started, report: null });
      return true;
    } catch (e) {
      // the backend motion gate can stay latched after the twin's own reset; the cure is the same button either way
      const latched = e instanceof ApiError && e.status === 409 && /emergency stop/i.test(e.message);
      set({ actionError: latched ? "The emergency stop is latched. Clear it with the Clear e-stop button in the top bar, then approve again." : msg(e) });
      return false;
    }
  },

  // Operator controls act on the twin first, synchronously; the backend record follows and a failure there is shown, not blocking.
  pause: () => {
    useSimStore.getState().pauseMission();
    const m = get().mission;
    if (m) api.pause(m.id).then((mission) => set({ mission }), (e) => set({ actionError: msg(e) }));
  },
  resume: () => {
    const ok = useSimStore.getState().resumeMission();
    if (!ok) {
      set({ actionError: "Resume refused: visibility is below the unsafe limit or the camera is offline." });
      return;
    }
    const m = get().mission;
    if (m) api.resume(m.id).then((mission) => set({ mission, actionError: null }), (e) => set({ actionError: msg(e) }));
  },
  stop: () => {
    useSimStore.getState().stopMission();
  },
  emergencyStop: () => {
    useSimStore.getState().emergencyStop();
    api.command("ESTOP").catch(() => undefined); // the backend gate latches too; the twin has already stopped
  },
  clearEstop: () => {
    useSimStore.getState().clearEstop();
    // the two latches are independent, so the button clears both and then re-reads which one the backend still holds
    api.command("CLEAR_ESTOP").then(
      () => get().refreshStatus(),
      () => undefined,
    );
  },

  submitCapture: async (req, jpeg, idPng, idMap) => {
    const view: CaptureView = { seq: req.seq, missionId: req.missionId, request: req, frameUrl: URL.createObjectURL(jpeg), status: "SENDING" };
    const prior = get().captures;
    const dropped = prior.length >= MAX_CAPTURES ? prior.slice(0, prior.length - MAX_CAPTURES + 1) : [];
    dropped.forEach((c) => URL.revokeObjectURL(c.frameUrl));
    set({ captures: [...prior.slice(dropped.length), view], selectedCapture: req.seq });
    const update = (patch: Partial<CaptureView>) => set({ captures: get().captures.map((c) => (c.seq === req.seq ? { ...c, ...patch } : c)) });
    if (get().backend === "OFFLINE") {
      update({ status: "NOT_SENT", error: "backend offline: frame kept locally only" });
      return;
    }
    const scenario = useSimStore.getState().engine.scenario;
    const mission = get().mission;
    const meta = {
      missionId: req.missionId,
      seq: req.seq,
      reason: req.reason,
      waypointIndex: req.waypointIndex,
      time: req.time,
      gantryX: req.gantryX,
      gantryY: req.gantryY,
      visibility: req.visibility,
      turbidity: req.turbidity,
      lighting: req.lighting,
      perception: req.perception,
      cameraOnline: req.cameraOnline,
      source: "DIGITAL_TWIN",
      detections: req.detections.map((d) => ({ objectId: d.objectId, trueType: d.trueType, class: d.class, confidence: d.confidence, bbox: d.bbox, estX: d.estX, estY: d.estY })),
      idMap,
      targets: mission && mission.id === req.missionId ? mission.spec.targets : ["loose_cable", "foreign_object"],
      perceptionFault: scenario.perceptionFault,
    };
    const form = new FormData();
    form.append("meta", JSON.stringify(meta));
    form.append("frame", jpeg, `frame-${req.seq}.jpg`);
    form.append("idmask", idPng, `ids-${req.seq}.png`);
    try {
      update({ status: "DONE", result: await api.capture(form) });
    } catch (e) {
      update({ status: "FAILED", error: msg(e) });
    }
    // a frame that lands after the mission closed (the wait in finishMission gave up) must still reach the shown report
    const closed = get().mission;
    if (closed && closed.id === req.missionId && (closed.status === "COMPLETED" || closed.status === "ABORTED") && get().report?.mission.id === closed.id) {
      void get().loadReport(closed.id);
    }
  },

  selectCapture: (selectedCapture) => set({ selectedCapture }),

  finishMission: async (result) => {
    const m = get().mission;
    if (!m || m.id !== result.missionId) return;
    // The twin emits its last capture and ends the mission in the same tick, so that frame is still queued for rendering or
    // uploading when the result arrives. Completing first would leave it out of the report.
    const unsettled = () => {
      const { captures } = get();
      const queued = useSimStore.getState().engine.captureQueue;
      return (
        captures.some((c) => c.missionId === m.id && c.status === "SENDING") ||
        queued.some((q) => q.missionId === m.id && q.cameraOnline && !captures.some((c) => c.seq === q.seq))
      );
    };
    const giveUp = Date.now() + UPLOAD_WAIT_MS;
    while (unsettled() && Date.now() < giveUp) await new Promise((r) => setTimeout(r, 100));
    try {
      const done = await api.complete(m.id, result);
      set({ mission: done });
      await get().loadReport(m.id);
      void get().loadHistory();
    } catch (e) {
      set({ actionError: msg(e) });
    }
  },

  loadReport: async (missionId) => {
    try {
      set({ report: await api.report(missionId), reportError: null });
    } catch (e) {
      set({ reportError: msg(e) });
    }
  },

  loadHistory: async () => {
    try {
      set({ history: await api.history() });
    } catch {
      /* history is optional; the backend state chip already says why */
    }
  },

  setUnlockOpen: (unlockOpen) => set({ unlockOpen }),

  unlock: async (passcode) => {
    try {
      const { unlocked } = await api.unlock(passcode);
      if (!unlocked) return { ok: false, error: "That passcode was not accepted." };
      setPasscode(passcode);
      // the status read proves it: if the backend still says locked, the client forgets the passcode again
      await get().refreshStatus();
      const live = get().system?.live;
      if (live?.lockEnabled && !live.unlocked) {
        set({ lockNotice: null });
        return { ok: false, error: "The backend accepted the passcode, then refused it. Enter it again." };
      }
      set({ unlockOpen: false, lockNotice: null, unlockBlockedUntil: null });
      void get().refreshEvidence();
      return { ok: true };
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) {
        const wait = e.retryAfterS ?? 60;
        set({ unlockBlockedUntil: Date.now() + wait * 1000 });
        return { ok: false, blocked: true };
      }
      return { ok: false, error: msg(e) };
    }
  },

  relock: () => {
    setPasscode(null);
    set({ unlockOpen: false, lockNotice: null });
    void get().refreshStatus();
  },
}));

// A rejected passcode is forgotten inside the API client; the store only explains it and re-reads the status.
setRejectedHandler((why, refresh) => {
  useMissionStore.setState({ lockNotice: why });
  if (refresh) void useMissionStore.getState().refreshStatus();
});
