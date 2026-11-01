/**
 * Headless check of the simulation engine. Run with `npm run sim:check`.
 * Fails loudly if determinism, gantry constraints, the detection state machine,
 * the controller, the test runner, the store or the demo director break.
 * Every bug found in the sim becomes an assertion here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { projectionFixture, trajectoryFixture } from "./fixtures";
import { GANTRY, RL, clamp } from "./constants";
import { DEMO_FIXTURE_PLAN, DEMO_PHASES, createDemoDirector, stepDemo } from "./demo";
import { compareStrategies, runHeadlessMission } from "./compare";
import { MISSION_TIME_CAP_S } from "./engine";
import { environmentAt, estimateVisibility } from "./perception";
import { PERCEPTION } from "./constants";
import { SCENARIO_PRESETS, presetScenario } from "./scenario";
import type { MissionPlan } from "./types";
import { runDetection } from "./detection";
import { SimEngine } from "./engine";
import { PARK } from "./gantry";
import { epsilonFor, reward } from "./policy";
import { defaultScenario as inspectionScenario, referenceScenario as defaultScenario } from "./scenario";
import { useSimStore } from "./store";
import type { Detection, RLObservation } from "./types";

const SUB = 1 / 120;
const onRail = (e: SimEngine) => e.gantry.x.pos >= 0 && e.gantry.x.pos <= GANTRY.travelX && e.gantry.y.pos >= 0 && e.gantry.y.pos <= GANTRY.travelY;

/** Advances one substep at a time and checks the physical and numeric invariants after each. */
function checkedTick(e: SimEngine, seconds: number): void {
  const n = Math.round(seconds / SUB);
  for (let i = 0; i < n; i++) {
    e.tick(SUB);
    const vmax = GANTRY.maxSpeed * clamp(e.scenario.gantrySpeed, 0.2, 1) + 1e-9;
    assert.ok(onRail(e), `left the rail at (${e.gantry.x.pos}, ${e.gantry.y.pos})`);
    assert.ok(Math.abs(e.gantry.x.vel) <= vmax && Math.abs(e.gantry.y.vel) <= vmax, `over speed (${e.gantry.x.vel}, ${e.gantry.y.vel})`);
    assert.ok(Number.isFinite(e.gantry.x.target) && Number.isFinite(e.gantry.y.target), "non-finite target");
    const rl = e.rl;
    const o = rl.observation;
    for (const v of [rl.reward, rl.episodeReward, rl.policyConfidence, rl.nextX, rl.nextY, o.x, o.y, o.targetX, o.targetY, o.confidence])
      assert.ok(Number.isFinite(v), "non-finite controller value");
    assert.ok(rl.step <= RL.maxSteps, "episode exceeded maxSteps");
    if (!rl.active) assert.ok(o.x === e.gantry.x.pos && o.y === e.gantry.y.pos && rl.nextX === o.x && rl.nextY === o.y, "idle controller state not the gantry position");
    for (const d of e.detections) {
      const [u, v, w, h] = d.bbox;
      assert.ok(u >= 0 && v >= 0 && w >= 0 && h >= 0 && u + w <= 1 + 1e-9 && v + h <= 1 + 1e-9, `bbox outside the feed ${d.bbox}`);
      assert.ok(d.estX >= 0 && d.estX <= GANTRY.travelX && d.estY >= 0 && d.estY <= GANTRY.travelY, `estimate off the floor (${d.estX}, ${d.estY})`);
      assert.ok(d.state === "DETECTED" || d.state === "LOCKED", `impossible detection state ${d.state}`);
    }
  }
}

/** Runs until pred holds or maxSeconds elapse; returns whether pred held. */
function runUntil(e: SimEngine, pred: () => boolean, maxSeconds: number): boolean {
  for (let t = 0; t < maxSeconds && !pred(); t += SUB) checkedTick(e, SUB);
  return pred();
}
const settle = (e: SimEngine) => assert.ok(runUntil(e, () => !e.gantry.moving && e.gantry.x.pos === e.gantry.x.target && e.gantry.y.pos === e.gantry.y.target, 60), "did not settle");
const complete = (e: SimEngine) => assert.ok(runUntil(e, () => e.phase === "COMPLETE", 600), "test never completed");
const at = (e: SimEngine, x: number, y: number) => e.gantry.x.pos === x && e.gantry.y.pos === y;
/** Reads through a call so TypeScript does not narrow mode and phase across engine mutations. */
const idle = (e: SimEngine) => e.mode === "IDLE" && e.phase === "IDLE";
const idleState = (e: SimEngine) => JSON.stringify({ g: e.gantry, m: e.mode, p: e.phase, rl: e.rl, ev: e.events, sc: e.scenario, t: e.time });

function runFullTest(e = new SimEngine(defaultScenario)): SimEngine {
  e.runTest();
  complete(e);
  return e;
}

// ---------------------------------------------------------------- golden run

const a = runFullTest();
const b = runFullTest();
assert.ok(a.result && b.result);
assert.deepEqual(a.result, b.result, "replay is not deterministic");
assert.deepEqual(a.events, b.events, "replay event logs differ");
// Calibration in docs/BLUEPRINT.md 4.2 and docs/HANDOFF.md 4. Change these only with the docs.
assert.equal(a.result.objectsDetected, 5);
assert.equal(a.result.successfulDetections, 3);
assert.equal(a.result.falsePositives, 1);
assert.equal(a.result.coverage, 0.9);
assert.equal(a.result.episodeReward, 15.64);
assert.equal(a.result.targetId, "wreck-01");
assert.ok(Math.abs(a.result.avgConfidence - 0.7137) < 0.001, `avg confidence drifted ${a.result.avgConfidence}`);
assert.ok(Math.abs(a.result.durationS - 43.4) < 0.1, `duration drifted ${a.result.durationS}`);
assert.ok(a.rl.done && a.rl.step > 0, "episode did not run");

// Replay on the same engine must be bit-identical, wherever the carriage was.
const r1 = { ...a.result };
const ev1 = a.events;
a.moveTo(90, 35);
settle(a);
a.runTest();
complete(a);
assert.deepEqual(a.result, r1, "replay on the same engine diverged");
assert.deepEqual(a.events, ev1, "replay on the same engine has a different log");
assert.deepEqual(a.previousResult, r1, "previousResult should be the run before");

// The wall-clock cadence must not matter: the substep sequence is the same at 60, 120 or 10 Hz.
for (const dt of [1 / 60, 0.1]) {
  const e = new SimEngine(defaultScenario);
  e.runTest();
  let g = 0;
  while (e.phase !== "COMPLETE" && g++ < 120 * 600) e.tick(dt);
  assert.deepEqual(e.result, r1, `result depends on tick cadence ${dt}`);
  assert.deepEqual(e.events, ev1, `log depends on tick cadence ${dt}`);
}

// Harder scenario: high turbidity should lower confidence and detections.
const c = new SimEngine(defaultScenario);
c.setScenario({ turbidity: 0.9, lighting: 0.3 });
runFullTest(c);
assert.ok(c.result!.avgConfidence < a.result.avgConfidence, "turbidity did not reduce confidence");

// ---------------------------------------------------------------- gantry

{
  const m = new SimEngine(defaultScenario);
  assert.ok(at(m, PARK[0], PARK[1]) && !m.gantry.moving, "not parked at construction");
  assert.ok(m.rl.observation.x === PARK[0] && m.rl.observation.y === PARK[1] && m.rl.nextX === PARK[0] && m.rl.nextY === PARK[1], "idle controller state is not PARK");

  for (const [x, y, ex, ey] of [
    [0, 0, 0, 0],
    [100, 40, 100, 40],
    [-5, 500, 0, 40],
    [-0, -0, 0, 0],
  ]) {
    m.moveTo(x, y);
    settle(m);
    assert.ok(at(m, ex, ey), `moveTo(${x}, ${y}) ended at (${m.gantry.x.pos}, ${m.gantry.y.pos})`);
  }

  // Garbage coordinates are dropped per axis; the carriage stays where it is.
  m.moveTo(50, 20);
  settle(m);
  for (const bad of [NaN, Infinity, -Infinity, null, undefined]) {
    m.moveTo(bad as unknown as number, bad as unknown as number);
    checkedTick(m, 1);
    assert.ok(at(m, 50, 20) && !m.gantry.moving, `moveTo(${bad}) moved the carriage`);
  }
  m.moveTo(NaN, 30);
  settle(m);
  assert.ok(at(m, 50, 30), "one bad axis should not block the other");

  // Zero movement and repeated identical commands.
  m.moveTo(50, 30);
  checkedTick(m, 0.5);
  assert.ok(at(m, 50, 30) && !m.gantry.moving && m.mode === "MANUAL");
  for (let i = 0; i < 200; i++) {
    m.moveTo(80, 10);
    checkedTick(m, SUB);
  }
  settle(m);
  assert.ok(at(m, 80, 10));

  // Rapid alternating commands every substep, then release: still settles exactly.
  for (let i = 0; i < 120 * 10; i++) {
    m.moveTo(i % 2 ? 0 : 100, i % 2 ? 40 : 0);
    checkedTick(m, SUB);
  }
  settle(m);
  assert.ok(at(m, m.gantry.x.target, m.gantry.y.target));

  // Settling: once on target it stays there (no oscillation), and it arrives within the trapezoid bound.
  for (const speed of [0.2, 0.65, 1])
    for (const [sx, sy, tx, ty] of [
      [0, 0, 100, 40],
      [100, 40, 0, 0],
      [50, 20, 50.1, 20.1],
      [50, 20, 50.2, 19.8],
      [3, 3, 97, 37],
      [12.34, 5.67, 88.76, 33.21],
    ]) {
      const e = new SimEngine(defaultScenario);
      e.setScenario({ gantrySpeed: speed });
      e.gantry.x.pos = sx;
      e.gantry.y.pos = sy;
      e.moveTo(tx, ty);
      const vmax = GANTRY.maxSpeed * speed;
      const bound = Math.max(Math.abs(tx - sx), Math.abs(ty - sy)) / vmax + (2 * vmax) / GANTRY.accel + 1;
      let arrived = -1;
      for (let t = 0; t < bound; t += SUB) {
        checkedTick(e, SUB);
        const here = at(e, tx, ty) && !e.gantry.moving;
        if (arrived < 0 && here) arrived = t;
        if (arrived >= 0) assert.ok(here, `oscillated after arriving at speed ${speed} (${sx},${sy})->(${tx},${ty})`);
      }
      assert.ok(arrived >= 0, `did not arrive within ${bound.toFixed(1)} s at speed ${speed} (${sx},${sy})->(${tx},${ty})`);
    }

  // gantrySpeed clamp and every scenario field against NaN, Infinity, negatives.
  const s = new SimEngine(defaultScenario);
  const base = { ...defaultScenario() };
  delete (base as Partial<typeof base>).objects;
  for (const key of ["turbidity", "lighting", "threshold", "gantrySpeed", "seed"] as const) {
    for (const bad of [NaN, Infinity, -Infinity, undefined]) {
      s.setScenario({ [key]: bad });
      assert.equal(s.scenario[key], base[key], `${key} changed on ${bad}`);
    }
  }
  s.setScenario({ turbidity: -1, lighting: -1, threshold: -1, gantrySpeed: -1 });
  assert.deepEqual([s.scenario.turbidity, s.scenario.lighting, s.scenario.threshold, s.scenario.gantrySpeed], [0, 0, 0.3, 0.2]);
  s.setScenario({ turbidity: 9, lighting: 9, threshold: 9, gantrySpeed: 9 });
  assert.deepEqual([s.scenario.turbidity, s.scenario.lighting, s.scenario.threshold, s.scenario.gantrySpeed], [1, 1, 0.95, 1]);
  s.setScenario({ seed: -1 });
  assert.equal(s.scenario.seed, 4294967295, "negative seed wraps to uint32");
  s.setScenario({ seed: 1.5 });
  assert.equal(s.scenario.seed, 1, "fractional seed truncates");
  s.setScenario({ gantrySpeed: 5 });
  s.moveTo(0, 0);
  checkedTick(s, 1);
  assert.ok(Math.abs(s.gantry.x.vel) <= GANTRY.maxSpeed, "speed clamp");

  // moveObject: bad values ignored, out of range clamped to the floor margin, unknown id ignored.
  const wreck = () => s.scenario.objects.find((o) => o.id === "wreck-01")!;
  const [ox, oy] = [wreck().x, wreck().y];
  s.moveObject("wreck-01", NaN, Infinity);
  assert.ok(wreck().x === ox && wreck().y === oy, "moveObject applied a non-finite value");
  s.moveObject("wreck-01", -50, 500);
  assert.deepEqual([wreck().x, wreck().y], [3, GANTRY.travelY - 3]);
  s.moveObject("nope", 10, 10);
}

// ---------------------------------------------------------------- detection

{
  // SCAN -> DETECTED -> LOCKED, never absent -> LOCKED, never LOCKED -> DETECTED while in view.
  const e = new SimEngine(defaultScenario);
  e.moveTo(0, 0);
  settle(e);
  checkedTick(e, 0.3);
  assert.ok(!e.detections.some((d) => d.objectId === "wreck-01"), "wreck visible from home");
  e.moveTo(60, 26);
  let prev: Detection | undefined;
  let sawDetected = false;
  let sawLocked = false;
  for (let t = 0; t < 12; t += SUB) {
    checkedTick(e, SUB);
    const d = e.detections.find((x) => x.objectId === "wreck-01");
    if (!d) {
      assert.ok(!prev, "wreck dropped out while approaching its centre");
      continue;
    }
    if (!prev) assert.ok(d.state === "DETECTED" && d.age === 0, "first detection must be DETECTED with age 0");
    else if (prev.state === "LOCKED") assert.equal(d.state, "LOCKED", "LOCKED fell back to DETECTED while in view");
    if (d.state === "LOCKED") assert.ok(d.age >= 0.6, "LOCKED before lockSeconds");
    sawDetected ||= d.state === "DETECTED";
    sawLocked ||= d.state === "LOCKED";
    prev = d;
  }
  assert.ok(sawDetected && sawLocked && at(e, 60, 26), "state machine did not pass through DETECTED and LOCKED");
  // Leaving the frame resets the age; coming back starts at DETECTED again.
  e.moveTo(0, 0);
  settle(e);
  checkedTick(e, 0.3);
  assert.ok(!e.detections.some((d) => d.objectId === "wreck-01"), "wreck still detected from the far corner");
  e.moveTo(60, 26);
  assert.ok(runUntil(e, () => e.detections.some((d) => d.objectId === "wreck-01"), 5), "wreck never reappeared");
  const back = e.detections.find((d) => d.objectId === "wreck-01")!;
  assert.ok(back.state === "DETECTED" && back.age === 0, "age did not reset after leaving the frame");

  // Hysteresis: the centred wreck reads 0.847 +- 0.01, so 0.86 only holds it through the 0.05 band.
  settle(e);
  e.setScenario({ threshold: 0.95 });
  checkedTick(e, 0.3);
  assert.ok(!e.detections.some((d) => d.objectId === "wreck-01"), "wreck above 0.95");
  e.setScenario({ threshold: 0.88 });
  checkedTick(e, 0.3);
  assert.ok(!e.detections.some((d) => d.objectId === "wreck-01"), "wreck above 0.88 with no prior detection");
  e.setScenario({ threshold: 0.82 });
  checkedTick(e, 0.3);
  assert.ok(e.detections.some((d) => d.objectId === "wreck-01"), "wreck below 0.82");
  e.setScenario({ threshold: 0.86 });
  checkedTick(e, 0.3);
  assert.ok(e.detections.some((d) => d.objectId === "wreck-01"), "hysteresis should hold the detection 0.05 below threshold");
  e.setScenario({ threshold: 0.95 });
  checkedTick(e, 0.3);
  assert.ok(!e.detections.some((d) => d.objectId === "wreck-01"), "detection survived far above the gate");

  // Geometry over the whole floor with everything visible: bbox in [0,1], estimates on the floor.
  const wide = defaultScenario();
  wide.turbidity = 0;
  wide.lighting = 1;
  wide.threshold = 0.3;
  for (let gx = 0; gx <= GANTRY.travelX; gx += 2.5)
    for (let gy = 0; gy <= GANTRY.travelY; gy += 2.5) {
      const out = runDetection({ gantryX: gx, gantryY: gy, scenario: wide, time: 0, previous: new Map(), dt: 0.1 });
      for (const d of out.detections) {
        const [u, v, w, h] = d.bbox;
        assert.ok(u >= 0 && v >= 0 && w >= 0 && h >= 0 && u + w <= 1 + 1e-9 && v + h <= 1 + 1e-9, `bbox ${d.bbox} at (${gx}, ${gy})`);
        assert.ok(d.estX >= 0 && d.estX <= GANTRY.travelX && d.estY >= 0 && d.estY <= GANTRY.travelY, `estimate (${d.estX}, ${d.estY}) at (${gx}, ${gy})`);
        assert.ok(d.confidence >= 0 && d.confidence <= 1);
      }
    }

  // Object counts: none, one, six, all out of frame, everything in frame at a low threshold.
  const z = new SimEngine(defaultScenario);
  z.scenario.objects = [];
  checkedTick(z, 0.5);
  assert.ok(z.detections.length === 0 && z.inFrame === 0);
  z.scenario = defaultScenario();
  z.scenario.objects = z.scenario.objects.slice(0, 1);
  z.moveTo(60, 26);
  settle(z);
  checkedTick(z, 0.2);
  assert.equal(z.detections.length, 1);
  z.scenario = defaultScenario();
  for (const o of z.scenario.objects) z.moveObject(o.id, 97, 37);
  z.moveTo(0, 0);
  settle(z);
  checkedTick(z, 0.2);
  assert.ok(z.detections.length === 0 && z.inFrame === 0, "objects in the far corner are in frame from home");
  z.scenario = defaultScenario();
  z.scenario.objects.forEach((o, i) => z.moveObject(o.id, 40 + (i % 3) * 10, 12 + Math.floor(i / 3) * 12));
  z.setScenario({ threshold: 0.3, turbidity: 0, lighting: 1 });
  z.moveTo(50, 18);
  settle(z);
  checkedTick(z, 0.2);
  assert.equal(z.inFrame, 6, "not all six objects in frame");
  assert.equal(z.detections.length, 6, "not all six objects detected at threshold 0.3");
  z.setScenario({ lighting: 0 });
  checkedTick(z, 0.3);
  assert.equal(z.detections.length, 0, "lighting 0 detected something");
  // Fully silted water: nothing at the default threshold; at the 0.3 floor a centred wreck still
  // reads about 31 percent and degrades to UNKNOWN (docs/BLUEPRINT.md 4.2).
  z.setScenario({ lighting: 0.8, turbidity: 1, threshold: 0.6 });
  checkedTick(z, 0.3);
  assert.equal(z.detections.length, 0, "turbidity 1 detected something at the default threshold");
  z.setScenario({ threshold: 0.3 });
  checkedTick(z, 0.3);
  assert.ok(z.detections.length <= 1 && z.detections.every((d) => d.class === "UNKNOWN" && d.confidence < 0.35), "turbidity 1 classified something");
}

// ---------------------------------------------------------------- controller

{
  assert.equal(epsilonFor(0), RL.epsilonStart);
  assert.equal(epsilonFor(RL.epsilonDecayEpisodes), 0);
  assert.equal(epsilonFor(RL.epsilonDecayEpisodes + 5), 0);
  for (let i = 1; i <= RL.epsilonDecayEpisodes; i++) assert.ok(epsilonFor(i) < epsilonFor(i - 1), "epsilon must decay");
  const off: RLObservation = { x: 0, y: 0, targetX: 10, targetY: 0, confidence: 0, prevAction: "HOLD" };
  const on: RLObservation = { ...off, targetX: 0 };
  assert.equal(reward(off, off, "HOLD"), -RL.stepCost, "HOLD bonus paid off target");
  assert.equal(reward(on, on, "HOLD"), Math.round((RL.holdBonus - RL.stepCost) * 100) / 100, "HOLD bonus missing on target");

  const done = (e: SimEngine) => assert.ok(runUntil(e, () => e.rl.done, 200), "episode never finished");
  // Target at the floor corners (moveObject clamps to the 3 cm margin) and at the current position.
  for (const [x, y] of [
    [0, 0],
    [100, 40],
    [50, 20],
  ]) {
    const e = new SimEngine(defaultScenario);
    e.moveObject("mine-01", x, y);
    e.startEpisode("mine-01");
    assert.ok(e.rl.active && e.mode === "EPISODE" && e.rl.episode === 1);
    done(e);
    assert.equal(e.mode, "IDLE");
    assert.ok(!e.rl.active && e.rl.holdCount >= RL.holdToFinish, `episode to (${x}, ${y}) did not end by holding`);
    assert.ok(Math.hypot(e.gantry.x.pos - e.rl.observation.targetX, e.gantry.y.pos - e.rl.observation.targetY) < 1, "did not converge");
    assert.ok(e.rl.episodeReward > 0, `reward ${e.rl.episodeReward} for target (${x}, ${y})`);
    if (x === 50 && y === 20) assert.ok(e.rl.step <= RL.holdToFinish + 2, `holding in place took ${e.rl.step} steps`);
  }

  // Episode counter, stop twice, startEpisode twice, rapid restarts, unknown id.
  const e = new SimEngine(defaultScenario);
  for (let i = 1; i <= 3; i++) {
    e.startEpisode("wreck-01");
    assert.equal(e.rl.episode, i);
    done(e);
  }
  e.startEpisode("wreck-01");
  e.startEpisode("wreck-01");
  assert.ok(e.rl.active && e.rl.step === 0 && e.rl.episode === 5);
  done(e);
  e.stopAuto();
  e.stopAuto();
  assert.ok(e.mode === "IDLE" && !e.rl.active && at(e, e.gantry.x.target, e.gantry.y.target));
  for (let i = 0; i < 10; i++) {
    e.startEpisode(i % 2 ? "mine-01" : "wreck-01");
    checkedTick(e, SUB);
  }
  done(e);
  e.moveTo(80, 10);
  checkedTick(e, 0.2);
  const before = idleState(e);
  e.startEpisode("nope");
  e.track("nope");
  assert.equal(idleState(e), before, "unknown id changed state");
  assert.equal(e.mode, "MANUAL");

  // Reset during an episode: controller cleared, carriage parked with target = pos.
  e.startEpisode("wreck-01");
  checkedTick(e, 2);
  assert.ok(e.rl.active && e.rl.step > 0);
  e.reset();
  assert.equal(e.rl.episode, 0);
  assert.ok(!e.rl.active && idle(e) && at(e, PARK[0], PARK[1]) && at(e, e.gantry.x.target, e.gantry.y.target));
  assert.ok(e.rl.observation.x === PARK[0] && e.rl.observation.y === PARK[1]);

  // maxSteps cap: a target that keeps running away never converges, so the episode ends at 40 steps.
  const cap = new SimEngine(defaultScenario);
  cap.startEpisode("mine-01");
  let flip = 0;
  assert.ok(
    runUntil(
      cap,
      () => {
        if (Math.floor(cap.time * 2) > flip) {
          flip = Math.floor(cap.time * 2);
          cap.moveObject("mine-01", flip % 2 ? 3 : 97, flip % 2 ? 3 : 37);
        }
        return cap.rl.done;
      },
      600,
    ),
  );
  assert.equal(cap.rl.step, RL.maxSteps, "episode did not stop at maxSteps");
}

// ---------------------------------------------------------------- test runner

{
  const e = runFullTest();
  const first = { ...e.result! };
  // runTest twice quickly: the second call restarts cleanly, the completed result and its predecessor stay until the scan begins.
  e.runTest();
  e.runTest();
  assert.ok(e.phase === "HOMING" && e.mode === "TEST");
  assert.deepEqual(e.result, first);
  assert.equal(e.previousResult, null);
  complete(e);
  assert.deepEqual(e.result, first);
  assert.deepEqual(e.previousResult, first);

  // Stop during HOMING keeps the result; stopping inside the scan drops the aborted run and keeps the previous one.
  e.runTest();
  checkedTick(e, 1);
  assert.equal(e.phase, "HOMING");
  e.stopAuto();
  assert.ok(idle(e));
  assert.deepEqual(e.result, first, "result lost on aborted homing");
  assert.deepEqual(e.previousResult, first);
  for (const phase of ["SCANNING", "DETECTING", "TRACKING"] as const) {
    e.runTest();
    assert.ok(runUntil(e, () => e.phase === phase, 120), `never reached ${phase}`);
    e.stopAuto();
    assert.ok(idle(e) && !e.rl.active && at(e, e.gantry.x.target, e.gantry.y.target));
    assert.equal(e.result, null, `aborted ${phase} left a result`);
    assert.deepEqual(e.previousResult, first, `previousResult changed on aborted ${phase}`);
  }

  // Reset during TRACKING.
  e.runTest();
  assert.ok(runUntil(e, () => e.phase === "TRACKING", 120));
  e.reset();
  assert.ok(idle(e) && e.result === null && e.previousResult === null && e.events.length === 0 && at(e, PARK[0], PARK[1]));

  // durationS is the engine clock at the instant of COMPLETE.
  const d = new SimEngine(defaultScenario);
  d.runTest();
  assert.ok(runUntil(d, () => d.phase === "COMPLETE", 600));
  assert.equal(d.result!.durationS, d.time);
  assert.ok(d.events.at(-1)!.kind === "RESULT" && d.events.at(-1)!.t === d.time);

  // No objects: completes with an empty result and no target.
  const z = new SimEngine(defaultScenario);
  z.scenario.objects = [];
  runFullTest(z);
  assert.deepEqual([z.result!.objectsDetected, z.result!.targetId, z.result!.episodeReward, z.result!.falsePositives], [0, null, 0, 0]);
  assert.ok(z.result!.coverage > 0.5 && !z.rl.active);

  // Scenario change mid-test applies to the next detection pass and is recorded in the result.
  const mid = new SimEngine(defaultScenario);
  mid.runTest();
  assert.ok(runUntil(mid, () => mid.phase === "DETECTING", 120));
  assert.ok(mid.detections.length > 0, "nothing detected at the first waypoint");
  mid.setScenario({ turbidity: 1 });
  checkedTick(mid, 0.2);
  assert.equal(mid.detections.length, 0, "turbidity change did not apply immediately");
  complete(mid);
  assert.ok(mid.result!.turbidity === 1 && mid.result!.objectsDetected < first.objectsDetected);
}

// ---------------------------------------------------------------- store

{
  const st = () => useSimStore.getState();
  const pick = (s = st()) => ({ telemetry: s.telemetry, detections: s.detections, rl: s.rl, mode: s.mode, phase: s.phase, result: s.result, previousResult: s.previousResult, events: s.events, scenario: s.scenario });
  const engine = st().engine;

  // The initial snapshot already shows the controller at PARK.
  assert.ok(st().rl.observation.x === PARK[0] && st().rl.observation.y === PARK[1] && st().rl.nextX === PARK[0]);

  // A published snapshot is frozen: later ticks never mutate what React holds.
  st().runTest();
  st().publish();
  const held = st();
  const frozen = structuredClone(pick(held));
  assert.ok(runUntil(engine, () => engine.phase === "TRACKING", 120));
  checkedTick(engine, 3);
  assert.deepEqual(pick(held), frozen, "a published snapshot was mutated by later ticks");
  st().publish();
  assert.notEqual(st().detections, held.detections, "detections array identity must change per pass");

  // RUN -> RESET -> RUN three times gives identical results and logs.
  const runs: { result: unknown; events: unknown }[] = [];
  for (let i = 0; i < 3; i++) {
    st().reset();
    st().runTest();
    complete(engine);
    st().publish();
    runs.push({ result: st().result, events: st().events });
  }
  assert.deepEqual(runs[1], runs[0]);
  assert.deepEqual(runs[2], runs[0]);
  // The store runs the product's inspection layout, so compare it with a bare engine on that same layout.
  assert.deepEqual(runs[0].result, runFullTest(new SimEngine(inspectionScenario)).result, "store run differs from a bare engine run");

  // reset() returns every UI field to its initial value; scene stays (see the store comment).
  st().startDemo();
  const run = st().demo.run;
  st().setScene(5);
  st().setHighlight("gantry");
  st().selectObject("mine-01");
  st().setShowVision(true);
  st().reset();
  const s = st();
  assert.equal(s.scene, 5);
  assert.deepEqual(
    [s.highlight, s.selectedObjectId, s.showVision, s.demo, s.result, s.previousResult, s.events, s.mode, s.phase, s.rl.active],
    [null, null, false, { active: false, paused: false, t: 0, phase: 0, run, plan: null, usedFixture: false }, null, null, [], "IDLE", "IDLE", false],
  );
  assert.ok(s.telemetry.gantry.x === PARK[0] && s.telemetry.gantry.y === PARK[1] && s.telemetry.time === 0);

  // Demo: start twice, scene change while active, exit mid-test stops the engine.
  st().startDemo();
  st().startDemo();
  assert.equal(st().demo.run, run + 2);
  assert.ok(st().demo.active && at(engine, PARK[0], PARK[1]));
  st().setScene(3);
  assert.equal(st().scene, 3);
  engine.runTest();
  assert.ok(runUntil(engine, () => engine.phase === "SCANNING", 120));
  st().exitDemo();
  assert.ok(!st().demo.active && engine.mode === "IDLE" && engine.phase === "IDLE" && st().mode === "IDLE");

  // Telemetry derives from engine state.
  engine.moveTo(0, 0);
  settle(engine);
  checkedTick(engine, 0.2);
  let t = engine.telemetry();
  assert.ok(t.gantry.atHome && t.gantry.x === 0 && t.gantry.y === 0 && !t.gantry.moving);
  engine.moveTo(0.1, 0);
  settle(engine);
  t = engine.telemetry();
  assert.ok(!t.gantry.atHome && t.gantry.x === 0.1, "atHome must mean exactly (0, 0)");
  engine.moveTo(50, 20); // over the gate valve in the inspection layout
  checkedTick(engine, 1);
  t = engine.telemetry();
  assert.ok(t.gantry.moving && t.gantry.vx === engine.gantry.x.vel && t.gantry.vy === engine.gantry.y.vel);
  settle(engine);
  checkedTick(engine, 0.3);
  t = engine.telemetry();
  assert.equal(t.time, engine.time);
  assert.equal(t.camera.frame, Math.floor(engine.time * 30));
  assert.equal(t.vision.count, engine.detections.length);
  assert.equal(t.vision.inFrame, engine.inFrame);
  assert.equal(t.vision.bestConfidence, Math.max(0, ...engine.detections.map((d) => d.confidence)));
  assert.ok(t.vision.count > 0 && t.vision.bestConfidence > 0.8);
}

// ---------------------------------------------------------------- demo director

{
  const bound = DEMO_PHASES.reduce((s, p) => s + (p.maxSeconds ?? p.minSeconds), 0);
  const runDemo = (mutate: (e: SimEngine, t: number) => void, plan: MissionPlan | null = null) => {
    const e = new SimEngine(() => presetScenario("E"));
    const d = createDemoDirector();
    let t = 0;
    while (DEMO_PHASES[d.phaseIndex].id !== "REPORT") {
      t += 1 / 60;
      mutate(e, t);
      stepDemo(d, t, e, plan);
      checkedTick(e, 1 / 60 + 1e-9);
      assert.ok(t <= bound + 1, `demo did not reach REPORT within ${bound} s`);
    }
    return { e, t, d };
  };
  // With a backend plan the demo waits only the minimum, runs the whole mission and ends on its result.
  const normal = runDemo(() => {}, DEMO_FIXTURE_PLAN);
  assert.ok(!normal.d.usedFixture && normal.e.missionResult?.outcome === "COMPLETED", "demo mission did not complete");
  assert.ok(normal.e.missionResult!.pauses >= 1, "demo scenario E must pause the scan");
  assert.ok(normal.t < 110, `default demo took ${normal.t.toFixed(1)} s`);
  // No backend: COMMAND falls through on its wall-clock bound and the director labels the fixture plan.
  const offline = runDemo(() => {});
  assert.ok(offline.d.usedFixture && offline.e.missionResult !== null, "offline demo must fall back to the fixture plan");
  // Water that never clears: the mission stays paused and ADAPT's bound still reaches REPORT.
  const murky = runDemo((e, t) => t > 20 && e.mission?.status === "RUNNING" && e.setScenario({ turbidity: 1 }), DEMO_FIXTURE_PLAN);
  assert.ok(murky.t <= bound, `murky demo took ${murky.t.toFixed(1)} s`);
  // Operator stops the mission mid-scan.
  const stopped = runDemo((e, t) => t > 25 && e.mode === "MISSION" && e.stopMission(), DEMO_FIXTURE_PLAN);
  assert.ok(stopped.t <= bound && stopped.e.mode === "IDLE", `stopped demo took ${stopped.t.toFixed(1)} s`);
}

// ---------------------------------------------------------------- missions

{
  const plan = DEMO_FIXTURE_PLAN;
  const runMission = (scenario = presetScenario("A"), adaptive = true, mutate?: (e: SimEngine) => void) => {
    const e = new SimEngine(() => scenario);
    assert.ok(e.runMission(plan, adaptive), "plan refused");
    assert.ok(runUntil(e, () => { mutate?.(e); return e.mode !== "MISSION"; }, MISSION_TIME_CAP_S + 30), "mission never ended");
    return e;
  };

  // Determinism: a mission is a pure function of plan + scenario + seed.
  const m1 = runMission();
  const m2 = runMission();
  assert.deepEqual(m1.missionResult, m2.missionResult, "mission replay is not deterministic");
  assert.deepEqual(m1.events, m2.events, "mission event logs differ");
  assert.deepEqual(m1.captureQueue.map((c) => [c.seq, c.gantryX, c.gantryY]), m2.captureQueue.map((c) => [c.seq, c.gantryX, c.gantryY]));
  assert.deepEqual(runHeadlessMission(presetScenario("A"), plan, true), m1.missionResult, "headless runner differs from the engine");
  const r = m1.missionResult!;
  assert.equal(r.outcome, "COMPLETED");
  assert.equal(r.waypointsVisited, plan.waypoints.length);
  assert.ok(r.captures >= plan.waypoints.length && r.captures === m1.captureQueue.length, "one capture per capture waypoint plus re-observations");
  assert.equal(r.falsePositives, 0, "clear water: re-observation should resolve the rope offcut");
  assert.ok(r.confirmedTargets >= 4 && r.coverage === 1, `clear-water mission ${JSON.stringify(r)}`);
  for (const c of m1.captureQueue) {
    assert.ok(c.cameraOnline && c.missionId === plan.missionId);
    if (c.reason === "SCAN") {
      const w = plan.waypoints[c.waypointIndex];
      assert.ok(c.gantryX === w.x && c.gantryY === w.y, `capture ${c.seq} not at its waypoint`);
    }
  }

  // Re-observation removes the confusable false positive that the fixed strategy keeps.
  for (const id of ["B", "C", "D", "J"] as const) {
    const cmp = compareStrategies(presetScenario(id), plan);
    assert.ok(cmp.adaptive.falsePositives < cmp.fixed.falsePositives, `preset ${id}: adaptive FP ${cmp.adaptive.falsePositives} vs fixed ${cmp.fixed.falsePositives}`);
    assert.ok(cmp.adaptive.reobservations > 0 && cmp.fixed.reobservations === 0);
  }

  // Turbidity increase (E): adaptive pauses and records no unreliable frame; fixed records unreliable frames.
  const cmpE = compareStrategies(presetScenario("E"), plan);
  assert.ok(cmpE.adaptive.pauses >= 1 && cmpE.adaptive.unreliableCaptures === 0, `adaptive E ${JSON.stringify(cmpE.adaptive)}`);
  assert.ok(cmpE.fixed.unreliableCaptures > 0 && cmpE.fixed.pauses === 0, `fixed E ${JSON.stringify(cmpE.fixed)}`);
  assert.ok(cmpE.adaptive.confirmedTargets > cmpE.fixed.confirmedTargets, "adaptive should confirm more targets through the silt");

  // While paused nothing moves and nothing is captured; speed is capped while visibility is degraded.
  {
    const e = new SimEngine(() => presetScenario("E"));
    e.runMission(plan, true);
    let pausedCaptures = -1;
    let sawReduced = false;
    let degradedFor = 0;
    let pausedFor = 0;
    runUntil(e, () => {
      const m = e.mission!;
      if (m.status === "PAUSED") {
        if (pausedCaptures < 0) pausedCaptures = e.captureQueue.length;
        assert.equal(e.captureQueue.length, pausedCaptures, "captured while paused");
        pausedFor += SUB;
        if (pausedFor > 3) assert.ok(!e.gantry.moving, "gantry still moving 3 s into a pause");
      } else {
        pausedCaptures = -1;
        pausedFor = 0;
      }
      if (m.status === "RUNNING" && m.perception === "REDUCED_VISIBILITY") {
        degradedFor += SUB;
        if (degradedFor > 1) {
          sawReduced = true;
          const cap = GANTRY.maxSpeed * PERCEPTION.reducedSpeedFraction + 1e-9;
          assert.ok(Math.abs(e.gantry.x.vel) <= cap && Math.abs(e.gantry.y.vel) <= cap, "over the reduced speed in degraded visibility");
        }
      } else degradedFor = 0;
      return e.mode !== "MISSION";
    }, MISSION_TIME_CAP_S);
    assert.ok(sawReduced, "scenario E never ran at reduced speed");
    assert.equal(e.scenario.turbidity, presetScenario("E").turbidity, "mission did not restore the water");
  }

  // Operator resume is refused while the water is unsafe; operator stop while paused for visibility is labelled so.
  {
    const e = new SimEngine(() => presetScenario("E"));
    e.runMission(plan, true);
    assert.ok(runUntil(e, () => e.mission!.status === "PAUSED", 120), "E never paused");
    assert.equal(e.resumeMission(), false, "resume accepted in unsafe visibility");
    assert.ok(runUntil(e, () => e.mission!.perception === "OPERATOR_INTERVENTION_REQUIRED" || e.mission!.status !== "PAUSED", 60));
    e.stopMission();
    assert.equal(e.missionResult!.outcome, "STOPPED_UNSAFE_VISIBILITY");
    assert.ok(e.mode === "IDLE");
  }

  // Camera dropout (H): the adaptive scan pauses and no capture is emitted while the camera is offline.
  {
    const e = runMission(presetScenario("H"), true, (x) => {
      if (x.mission && !x.mission.cameraOnline) assert.ok(x.detections.length === 0 && x.inFrame === 0, "detections with the camera offline");
    });
    assert.ok(e.missionResult!.pauses >= 1 && e.captureQueue.every((c) => c.cameraOnline));
    const fixed = runHeadlessMission(presetScenario("H"), plan, false);
    assert.ok(fixed.captures < plan.waypoints.length, "fixed strategy should lose captures to the dropout");
  }

  // Emergency stop: immediate, latching, and outranks every command.
  {
    const e = new SimEngine(() => presetScenario("A"));
    e.runMission(plan, true);
    assert.ok(runUntil(e, () => e.gantry.moving && e.mission!.status === "RUNNING", 60));
    e.emergencyStop();
    assert.ok(e.gantry.x.vel === 0 && e.gantry.y.vel === 0 && !e.gantry.moving, "e-stop did not zero velocity");
    assert.equal(e.missionResult!.outcome, "EMERGENCY_STOP");
    assert.ok(e.estop && e.telemetry().estop);
    const here = [e.gantry.x.pos, e.gantry.y.pos];
    e.moveTo(0, 0);
    e.runTest();
    e.track("valve-1");
    assert.equal(e.runMission(plan, true), false, "mission accepted while e-stopped");
    checkedTick(e, 2);
    assert.deepEqual([e.gantry.x.pos, e.gantry.y.pos], here, "moved while e-stopped");
    e.clearEstop();
    assert.ok(e.runMission(plan, true), "mission refused after clearing the e-stop");
  }

  // Bad plans: non-finite waypoints are refused, out-of-range ones are clamped to the rails, empty plans refused.
  {
    const e = new SimEngine(() => presetScenario("A"));
    assert.equal(e.runMission({ ...plan, waypoints: [{ x: NaN, y: 1, capture: true }] }), false);
    assert.equal(e.runMission({ ...plan, waypoints: [] }), false);
    assert.ok(e.runMission({ ...plan, waypoints: [{ x: 500, y: -20, capture: true }] }));
    assert.deepEqual(e.mission!.plan.waypoints[0], { x: GANTRY.travelX, y: 0, capture: true });
    assert.ok(runUntil(e, () => e.mode !== "MISSION", 120));
  }

  // Every preset runs to an outcome under both strategies with the per-substep invariants intact.
  for (const p of SCENARIO_PRESETS) for (const adaptive of [true, false]) runMission(presetScenario(p.id), adaptive);

  // Perception maths.
  assert.equal(estimateVisibility(0.5, 0.8, false), 0, "no camera, no visibility");
  for (let i = 0; i < 10; i++) assert.ok(estimateVisibility(i / 10, 0.8, true) > estimateVisibility((i + 1) / 10, 0.8, true), "visibility must fall with turbidity");
  for (let i = 0; i < 10; i++) assert.ok(estimateVisibility(0.2, i / 10, true) < estimateVisibility(0.2, (i + 1) / 10, true), "visibility must rise with light");
  const ramp = [{ kind: "TURBIDITY" as const, atS: 10, value: 0.9, rampS: 4 }];
  assert.equal(environmentAt({ turbidity: 0.1, lighting: 0.8 }, ramp, 9.9).turbidity, 0.1);
  assert.ok(Math.abs(environmentAt({ turbidity: 0.1, lighting: 0.8 }, ramp, 12).turbidity - 0.5) < 1e-9);
  assert.equal(environmentAt({ turbidity: 0.1, lighting: 0.8 }, ramp, 20).turbidity, 0.9);
  assert.equal(environmentAt({ turbidity: 0.1, lighting: 0.8 }, [{ kind: "CAMERA_DROPOUT", atS: 1, durationS: 2 }], 2).cameraOnline, false);
  assert.equal(environmentAt({ turbidity: 0.1, lighting: 0.8 }, [{ kind: "CAMERA_DROPOUT", atS: 1, durationS: 2 }], 3).cameraOnline, true);
}

// ---------------------------------------------------------------- cross-language fixtures

{
  const committed = (f: string) => JSON.parse(readFileSync(`shared/fixtures/${f}`, "utf8"));
  assert.deepEqual(JSON.parse(JSON.stringify(trajectoryFixture())), committed("trajectory.json"), "gantry trajectory drifted from shared/fixtures (run npm run fixtures and the backend tests)");
  assert.deepEqual(JSON.parse(JSON.stringify(projectionFixture())), committed("projection.json"), "projection drifted from shared/fixtures");
}

console.log("sim:check OK");
console.log(JSON.stringify(a.result, null, 2));
console.log(`episode ${a.rl.episode} steps ${a.rl.step} reward ${a.rl.episodeReward}`);
for (const ev of a.events) console.log(`${ev.t.toFixed(1).padStart(6)}s ${ev.kind.padEnd(8)} ${ev.text}`);
