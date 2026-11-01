import type { SceneId } from "./store";
import type { SimEngine } from "./engine";
import type { MissionPlan } from "./types";
import fixturePlan from "../../shared/fixtures/pipeline-plan.json";

/**
 * Autonomous demo director, adapted from HydraLoom's. Called every frame with the demo clock.
 * Phases advance on real engine state with minimum durations so the narration always matches the machine.
 * The plan comes from the backend (Muse Spark, or the labelled offline parser); if the backend never answers, the demo
 * runs the contract fixture plan and says so in the caption.
 */

export type DemoPhaseId = "OVERVIEW" | "COMMAND" | "PLAN" | "SCAN" | "PERCEIVE" | "ADAPT" | "REPORT";

/** The brief's primary demonstration instruction. */
export const DEMO_INSTRUCTION =
  "Inspect the submerged pipeline from left to right. Identify loose cables and foreign objects. Track any relevant objects and record their coordinates. Reduce scanning speed when visibility deteriorates and stop if visibility becomes unreliable.";

export interface DemoPhase {
  id: DemoPhaseId;
  title: string;
  caption: string;
  scene: SceneId;
  minSeconds: number;
  /** wall-clock exit for phases gated on engine or network state, so REPORT is always reached */
  maxSeconds?: number;
}

export const DEMO_PHASES: DemoPhase[] = [
  { id: "OVERVIEW", title: "Inspection lab", caption: "A pipeline on the floor of a tank, an XY gantry with a downward camera, and a scripted rise in silt.", scene: 1, minSeconds: 7 },
  { id: "COMMAND", title: "Operator instruction", caption: "The operator describes the inspection in plain language. The backend turns it into a validated mission.", scene: 5, minSeconds: 6, maxSeconds: 25 },
  { id: "PLAN", title: "Plan approved", caption: "Every waypoint is inside the soft travel limits; speeds and visibility thresholds are bounded before anything moves.", scene: 5, minSeconds: 5 },
  { id: "SCAN", title: "Gantry scans", caption: "The carriage drives home, then follows the plan left to right, capturing a frame at each waypoint.", scene: 4, minSeconds: 8, maxSeconds: 40 },
  { id: "PERCEIVE", title: "Frames analysed", caption: "Each capture goes to the perception pipeline: image quality, segmentation, track association.", scene: 3, minSeconds: 8, maxSeconds: 40 },
  { id: "ADAPT", title: "Visibility drops", caption: "Silt rises. The controller slows the scan, then pauses until the water clears, instead of recording unreliable frames.", scene: 6, minSeconds: 8, maxSeconds: 90 },
  { id: "REPORT", title: "Inspection report", caption: "Observed objects, coordinates, conditions and uninspected areas, with every unverified finding marked as such.", scene: 7, minSeconds: 12 },
];

export interface DemoDirectorState {
  phaseIndex: number;
  phaseStart: number;
  missionStarted: boolean;
  usedFixture: boolean;
}

export function createDemoDirector(): DemoDirectorState {
  return { phaseIndex: 0, phaseStart: 0, missionStarted: false, usedFixture: false };
}

export const DEMO_FIXTURE_PLAN = fixturePlan as unknown as MissionPlan;

/** Advance the director. `plan` is the backend's plan for DEMO_INSTRUCTION once it has arrived. Returns the phase index. */
export function stepDemo(d: DemoDirectorState, t: number, engine: SimEngine, plan: MissionPlan | null): number {
  const phase = DEMO_PHASES[d.phaseIndex];
  const elapsed = t - d.phaseStart;
  const next = () => {
    d.phaseIndex = Math.min(d.phaseIndex + 1, DEMO_PHASES.length - 1);
    d.phaseStart = t;
  };
  if (phase.maxSeconds !== undefined && elapsed >= phase.maxSeconds) {
    next();
    return d.phaseIndex;
  }
  const m = engine.mission;
  switch (phase.id) {
    case "OVERVIEW":
    case "PLAN":
      if (elapsed >= phase.minSeconds) {
        if (phase.id === "PLAN" && !d.missionStarted) {
          d.usedFixture = !plan;
          d.missionStarted = engine.runMission(plan ?? DEMO_FIXTURE_PLAN, true);
        }
        next();
      }
      break;
    case "COMMAND":
      if (elapsed >= phase.minSeconds && plan) next();
      break;
    case "SCAN":
      if (elapsed >= phase.minSeconds && m && m.status === "RUNNING" && m.captures > 0) next();
      break;
    case "PERCEIVE":
      if (elapsed >= phase.minSeconds && m && (m.perception !== "NORMAL_VISIBILITY" || m.status !== "RUNNING")) next();
      break;
    case "ADAPT":
      if (elapsed >= phase.minSeconds && (!m || m.status === "COMPLETE" || m.status === "ABORTED")) next();
      break;
    case "REPORT":
      break;
  }
  return d.phaseIndex;
}
