"use client";

import { create } from "zustand";
import { ApiError, api, type TwinContext } from "@/lib/api/client";
import type { CaptureResult, EventEnvelope, HistoryItem, InspectionReport, MissionRecord, SystemStatus } from "@/lib/api/types";
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
  latencyMs?: number;
  durationMs?: number;
}

interface MissionStore {
  backend: BackendState;
  system: SystemStatus | null;
  instruction: string;
  voice: VoiceState;
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

  setBackend: (b: BackendState) => void;
  refreshStatus: () => Promise<void>;
  onEvent: (e: EventEnvelope) => void;
  setInstruction: (s: string) => void;
  startVoice: () => Promise<void>;
  stopVoice: () => Promise<void>;
  interpret: (offline?: boolean) => Promise<MissionRecord | null>;
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
  system: null,
  instruction: "",
  voice: { state: "IDLE" },
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

  setBackend: (backend) => set({ backend }),

  refreshStatus: async () => {
    try {
      set({ system: await api.status(), backend: "ONLINE" });
    } catch {
      set({ backend: "OFFLINE" });
    }
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
      const r = await api.transcribe(wav);
      set({ instruction: r.transcript, voice: { state: "IDLE", latencyMs: r.latencyMs, durationMs: r.audioDurationMs } });
    } catch (e) {
      recorder.cancel();
      set({ voice: { state: "ERROR", error: msg(e) } });
    }
  },

  interpret: async (offline = false) => {
    const text = get().instruction.trim();
    if (text.length < 3) {
      set({ interpretError: "Describe the inspection first." });
      return null;
    }
    set({ interpreting: true, interpretError: null, canFallBack: false, actionError: null });
    try {
      const r = await api.interpret(text, twinContext(), offline);
      set({ mission: r.mission, interpreting: false });
      return r.mission;
    } catch (e) {
      const live = get().system?.providers.spark.status === "LIVE";
      set({ interpreting: false, interpretError: msg(e), canFallBack: live && !offline && e instanceof ApiError && e.status !== 0 });
      return null;
    }
  },

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
}));
