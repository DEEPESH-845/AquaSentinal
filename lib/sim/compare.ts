import { MISSION_TIME_CAP_S, SimEngine } from "./engine";
import type { MissionPlan, MissionResult, Scenario } from "./types";

const STEP = 1 / 60;

/** Runs a plan to completion on a private engine. Pure: same scenario + plan + strategy, same result. */
export function runHeadlessMission(scenario: Scenario, plan: MissionPlan, adaptive: boolean): MissionResult {
  const e = new SimEngine(() => ({ ...scenario, objects: scenario.objects.map((o) => ({ ...o })), disturbances: scenario.disturbances.map((d) => ({ ...d })) }));
  if (!e.runMission(plan, adaptive)) throw new Error("plan refused by the engine");
  // homing can take up to ~10 s on top of the mission cap
  for (let t = 0; e.mode === "MISSION" && t < MISSION_TIME_CAP_S + 30; t += STEP) e.tick(STEP);
  if (e.mode === "MISSION") e.stopMission();
  return e.missionResult!;
}

/** The comparison shown in the Environment scene: the same plan with and without the visibility policy. */
export function compareStrategies(scenario: Scenario, plan: MissionPlan): { adaptive: MissionResult; fixed: MissionResult } {
  return { adaptive: runHeadlessMission(scenario, plan, true), fixed: runHeadlessMission(scenario, plan, false) };
}
