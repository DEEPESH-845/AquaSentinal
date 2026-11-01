import { GANTRY, RL, clamp } from "./constants";
import { ACTIONS, type Action, type RLObservation } from "./types";

/**
 * RL-inspired greedy controller with decaying epsilon exploration.
 * docs/BLUEPRINT.md section 4.3. This is not a trained network; the UI labels it as such.
 */

/** Within this radius the controller treats the target as reached. */
export const ON_TARGET_CM = 1.0;

export interface PolicyDecision {
  action: Action;
  policyConfidence: number;
  exploring: boolean;
}

function actionScores(obs: RLObservation): Record<Action, number> {
  const dist = Math.hypot(obs.targetX - obs.x, obs.targetY - obs.y);
  // Score = distance gained by the (clipped) step. HOLD is only worth anything on target.
  const gain = (a: Action) => {
    const [nx, ny] = applyAction(obs, a);
    return dist - Math.hypot(obs.targetX - nx, obs.targetY - ny);
  };
  return {
    "MOVE_X+": gain("MOVE_X+"),
    "MOVE_X-": gain("MOVE_X-"),
    "MOVE_Y+": gain("MOVE_Y+"),
    "MOVE_Y-": gain("MOVE_Y-"),
    HOLD: dist < ON_TARGET_CM ? GANTRY.stepCm : 0,
  };
}

export function epsilonFor(episode: number): number {
  return RL.epsilonStart * clamp(1 - episode / RL.epsilonDecayEpisodes, 0, 1);
}

export function decide(obs: RLObservation, episode: number, rand: () => number): PolicyDecision {
  const scores = actionScores(obs);
  const temperature = 1.5;
  const exps = ACTIONS.map((a) => Math.exp(scores[a] / temperature));
  const sum = exps.reduce((s, e) => s + e, 0);

  let best: Action = "HOLD";
  for (const a of ACTIONS) if (scores[a] > scores[best]) best = a;

  const eps = epsilonFor(episode);
  const exploring = rand() < eps;
  let action = best;
  if (exploring) {
    const others = ACTIONS.filter((a) => a !== best);
    action = others[Math.floor(rand() * others.length)];
  }
  const policyConfidence = exps[ACTIONS.indexOf(action)] / sum;
  return { action, policyConfidence, exploring };
}

/**
 * A step is 5 cm, except that a step in the direction of the target is clipped
 * to the residual error, the way a real controller commands the remaining distance.
 */
export function applyAction(obs: RLObservation, action: Action): [number, number] {
  const s = GANTRY.stepCm;
  const { x, y } = obs;
  const dx = obs.targetX - x;
  const dy = obs.targetY - y;
  const toward = (err: number, dir: number) => (Math.sign(err) === dir ? Math.min(s, Math.abs(err)) : s);
  switch (action) {
    case "MOVE_X+":
      return [clamp(x + toward(dx, 1), 0, GANTRY.travelX), y];
    case "MOVE_X-":
      return [clamp(x - toward(dx, -1), 0, GANTRY.travelX), y];
    case "MOVE_Y+":
      return [x, clamp(y + toward(dy, 1), 0, GANTRY.travelY)];
    case "MOVE_Y-":
      return [x, clamp(y - toward(dy, -1), 0, GANTRY.travelY)];
    default:
      return [x, y];
  }
}

export function reward(prev: RLObservation, next: RLObservation, action: Action): number {
  const dPrev = Math.hypot(prev.targetX - prev.x, prev.targetY - prev.y);
  const dNext = Math.hypot(next.targetX - next.x, next.targetY - next.y);
  let r = (dPrev - dNext) / GANTRY.stepCm - RL.stepCost;
  r += RL.confidenceWeight * next.confidence;
  if (action === "HOLD" && dNext < ON_TARGET_CM) r += RL.holdBonus;
  return Math.round(r * 100) / 100;
}

export function onTarget(obs: RLObservation): boolean {
  return Math.hypot(obs.targetX - obs.x, obs.targetY - obs.y) < ON_TARGET_CM;
}
