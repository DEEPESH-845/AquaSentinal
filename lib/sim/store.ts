import { create } from "zustand";
import { SimEngine } from "./engine";
import { defaultScenario, presetScenario, type PresetId } from "./scenario";
import type { Detection, EngineMode, MissionPlan, MissionResult, MissionSnapshot, RLState, RunEvent, RunPhase, Scenario, Telemetry, TestResult } from "./types";

export type SceneId = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type CameraPreset = "A" | "B" | "C" | "D" | "E";

/** Component ids for scene 02 highlighting. Must match the ids used by the 3D components. */
export type ComponentId = "gantry" | "camera" | "aquarium" | "raspberry-pi" | "arduino" | "test-objects";

/** DOM id of the camera feed container. The 3D feed renderer measures this element. */
export const FEED_ELEMENT_ID = "gantry-camera-feed";

// Scenario edits object XY, so it gets the top-down map like the gantry scenes. Mission control watches the whole tank.
export const SCENE_CAMERA: Record<SceneId, CameraPreset> = { 1: "A", 2: "A", 3: "D", 4: "B", 5: "A", 6: "B", 7: "A" };

export interface DemoState {
  active: boolean;
  paused: boolean;
  /** seconds into the script */
  t: number;
  /** index into DEMO_PHASES */
  phase: number;
  /** increments on every start so the driver restarts its director even mid-demo */
  run: number;
  /** the backend's plan for the demo instruction, once it has arrived */
  plan: MissionPlan | null;
  /** true when the director fell back to the contract fixture plan because the backend never answered */
  usedFixture: boolean;
}

/** Snapshot of the engine published to React at ~20 Hz. Hot 3D reads go through `engine` directly. */
export interface SimSnapshot {
  telemetry: Telemetry;
  detections: Detection[];
  rl: RLState;
  mode: EngineMode;
  phase: RunPhase;
  result: TestResult | null;
  previousResult: TestResult | null;
  events: RunEvent[];
  scenario: Scenario;
  mission: MissionSnapshot | null;
  missionResult: MissionResult | null;
  previousMissionResult: MissionResult | null;
  /** the plan the twin is executing or last executed, for the path overlay */
  plan: MissionPlan | null;
}

interface SimStore extends SimSnapshot {
  engine: SimEngine;
  scene: SceneId;
  cameraPreset: CameraPreset;
  highlight: ComponentId | null;
  selectedObjectId: string | null;
  demo: DemoState;
  /** set by the UI when the user wants to see the "simulation to field" closing moment */
  showVision: boolean;

  publish: () => void;
  setScene: (scene: SceneId) => void;
  setCameraPreset: (p: CameraPreset) => void;
  setHighlight: (id: ComponentId | null) => void;
  selectObject: (id: string | null) => void;
  moveGantryTo: (x: number, y: number) => void;
  trackObject: (id: string) => void;
  startEpisode: (id: string) => void;
  runTest: () => void;
  replayTest: () => void;
  stop: () => void;
  reset: () => void;
  setScenario: (patch: Partial<Omit<Scenario, "objects">>) => void;
  moveObject: (id: string, x: number, y: number) => void;
  startDemo: () => void;
  pauseDemo: (paused: boolean) => void;
  exitDemo: () => void;
  setDemoTime: (t: number) => void;
  setDemoPhase: (phase: number) => void;
  setDemoPlan: (plan: MissionPlan | null) => void;
  setDemoUsedFixture: (v: boolean) => void;
  setShowVision: (v: boolean) => void;
  preset: PresetId | null;
  applyPreset: (id: PresetId | null) => void;
  runMission: (plan: MissionPlan, adaptive?: boolean) => boolean;
  pauseMission: () => void;
  resumeMission: () => boolean;
  stopMission: () => void;
  emergencyStop: () => void;
  clearEstop: () => void;
}

function snapshot(engine: SimEngine): SimSnapshot {
  return {
    telemetry: engine.telemetry(),
    detections: engine.detections,
    rl: { ...engine.rl },
    mode: engine.mode,
    phase: engine.phase,
    result: engine.result,
    previousResult: engine.previousResult,
    events: engine.events,
    scenario: engine.scenario,
    mission: engine.missionSnapshot(),
    missionResult: engine.missionResult,
    previousMissionResult: engine.previousMissionResult,
    plan: engine.mission?.plan ?? null,
  };
}

export const useSimStore = create<SimStore>((set, get) => {
  const engine = new SimEngine();
  const publish = () => set(snapshot(engine));
  return {
    engine,
    ...snapshot(engine),
    scene: 1,
    cameraPreset: "A",
    highlight: null,
    selectedObjectId: null,
    demo: { active: false, paused: false, t: 0, phase: 0, run: 0, plan: null, usedFixture: false },
    showVision: false,

    publish,
    setScene: (scene) => set({ scene, cameraPreset: SCENE_CAMERA[scene], highlight: null }),
    setCameraPreset: (cameraPreset) => set({ cameraPreset }),
    setHighlight: (highlight) => set({ highlight }),
    selectObject: (selectedObjectId) => set({ selectedObjectId }),
    moveGantryTo: (x, y) => {
      engine.moveTo(x, y);
      publish();
    },
    trackObject: (id) => {
      engine.track(id);
      set({ selectedObjectId: id });
      publish();
    },
    startEpisode: (id) => {
      engine.startEpisode(id);
      set({ selectedObjectId: id });
      publish();
    },
    runTest: () => {
      engine.runTest();
      set({ selectedObjectId: null });
      publish();
    },
    replayTest: () => {
      // Deterministic re-run with the same seed. Same inputs, same result.
      engine.runTest();
      set({ selectedObjectId: null, scene: 4, cameraPreset: SCENE_CAMERA[4] });
      publish();
    },
    stop: () => {
      engine.stopAuto();
      publish();
    },
    // Reset restores the lab (engine defaults, PARK, no history) and clears every UI selection.
    // scene and cameraPreset stay: the rail is navigation, not lab state, and the user pressed RESET from a card they expect to keep.
    // demo.run is a restart counter for the driver and is deliberately preserved.
    reset: () => {
      engine.reset();
      set({ preset: null, selectedObjectId: null, highlight: null, showVision: false, demo: { active: false, paused: false, t: 0, phase: 0, run: get().demo.run, plan: null, usedFixture: false } });
      publish();
    },
    setScenario: (patch) => {
      engine.setScenario(patch);
      publish();
    },
    moveObject: (id, x, y) => {
      engine.moveObject(id, x, y);
      publish();
    },
    // The demo always runs scenario E (turbidity increase) so the adaptive behaviour is part of the story.
    startDemo: () => {
      engine.reset();
      engine.loadScenario(presetScenario("E"));
      set({ preset: "E", demo: { active: true, paused: false, t: 0, phase: 0, run: get().demo.run + 1, plan: null, usedFixture: false }, scene: 1, cameraPreset: "A", selectedObjectId: null, showVision: false });
      publish();
    },
    pauseDemo: (paused) => set({ demo: { ...get().demo, paused } }),
    exitDemo: () => {
      engine.stopAuto();
      set({ demo: { active: false, paused: false, t: 0, phase: 0, run: get().demo.run, plan: null, usedFixture: false } });
      publish();
    },
    setDemoTime: (t) => set({ demo: { ...get().demo, t } }),
    setDemoPhase: (phase) => set({ demo: { ...get().demo, phase } }),
    setDemoPlan: (plan) => set({ demo: { ...get().demo, plan } }),
    setDemoUsedFixture: (usedFixture) => set({ demo: { ...get().demo, usedFixture } }),
    setShowVision: (showVision) => set({ showVision }),
    preset: null,
    applyPreset: (id) => {
      // null restores the default layout; loadScenario is refused while a mission owns the water.
      engine.loadScenario(id ? presetScenario(id) : defaultScenario());
      set({ preset: id, selectedObjectId: null });
      publish();
    },
    runMission: (plan, adaptive = true) => {
      const ok = engine.runMission(plan, adaptive);
      set({ selectedObjectId: null });
      publish();
      return ok;
    },
    pauseMission: () => {
      engine.pauseMission();
      publish();
    },
    resumeMission: () => {
      const ok = engine.resumeMission();
      publish();
      return ok;
    },
    stopMission: () => {
      engine.stopMission();
      publish();
    },
    // The emergency stop never waits for React or the network: it acts on the engine synchronously, then publishes.
    emergencyStop: () => {
      engine.emergencyStop();
      if (get().demo.active) set({ demo: { ...get().demo, active: false, paused: false } });
      publish();
    },
    clearEstop: () => {
      engine.clearEstop();
      publish();
    },
  };
});
