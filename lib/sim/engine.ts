import { CAMERA, DETECTION, GANTRY, PERCEPTION, RL, TEST, clamp } from "./constants";
import { runDetection } from "./detection";
import { createGantry, gantryAtTarget, setGantryTarget, stepGantry } from "./gantry";
import { estimateVisibility, environmentAt, visibilityBand } from "./perception";
import { applyAction, decide, onTarget, reward } from "./policy";
import { mulberry32 } from "./rng";
import { defaultScenario } from "./scenario";
import type {
  Action,
  CaptureRequest,
  Detection,
  EngineMode,
  GantryState,
  MissionOutcome,
  MissionPlan,
  MissionResult,
  MissionSnapshot,
  MissionStatus,
  PerceptionState,
  RLObservation,
  RLState,
  RunEvent,
  RunPhase,
  Scenario,
  Telemetry,
  TestResult,
} from "./types";

const FIXED_DT = 1 / 120;
const finite = (v: number | undefined, fallback: number) => (Number.isFinite(v) ? (v as number) : fallback);
const OBSERVE_DWELL = 0.3;
const DECIDE_DWELL = 0.3;
/** Headless missions give up after this much simulated time (a scenario that never clears stays paused forever). */
export const MISSION_TIME_CAP_S = 600;

/** Live state of a mission run. Everything here is derived from the plan, the scenario and the clock. */
interface MissionRuntime {
  plan: MissionPlan;
  adaptive: boolean;
  status: MissionStatus;
  perception: PerceptionState;
  visibility: number;
  minVisibility: number;
  cameraOnline: boolean;
  speedFraction: number;
  waypointIndex: number;
  visited: number;
  dwell: number;
  captured: boolean;
  /** re-centre target while re-observing an uncertain detection */
  reobserve: { x: number; y: number; objectId: string } | null;
  reobservedAt: Array<[number, number]>;
  reobservations: number;
  captures: number;
  unreliableCaptures: number;
  pauses: number;
  pausedFor: number;
  recoverFor: number;
  pauseCause: "VISIBILITY" | "CAMERA" | "OPERATOR" | null;
  reason: string;
  base: { turbidity: number; lighting: number };
  seen: Map<string, Detection>;
}

/** Idle controller state. Position fields mirror the gantry, the single source of truth; target stays 0 until an episode names one. */
function freshRL(g: GantryState): RLState {
  return {
    active: false,
    done: false,
    episode: 0,
    step: 0,
    targetId: null,
    observation: { x: g.x.pos, y: g.y.pos, targetX: 0, targetY: 0, confidence: 0, prevAction: "HOLD" },
    action: "HOLD",
    reward: 0,
    episodeReward: 0,
    policyConfidence: 0,
    exploring: false,
    nextX: g.x.pos,
    nextY: g.y.pos,
    holdCount: 0,
    phase: "OBSERVE",
  };
}

/**
 * The whole simulation in one deterministic object.
 * tick(dt) advances gantry motion, detection, the control loop and the test runner.
 * docs/BLUEPRINT.md section 4.
 */
export class SimEngine {
  scenario: Scenario;
  gantry: GantryState = createGantry();
  detections: Detection[] = [];
  rl: RLState;
  mode: EngineMode = "IDLE";
  phase: RunPhase = "IDLE";
  time = 0;
  frame = 0;
  events: RunEvent[] = [];
  result: TestResult | null = null;
  /** the run before this one, so a changed scenario can be compared */
  previousResult: TestResult | null = null;
  /** objects in the camera frame regardless of threshold */
  inFrame = 0;
  /** latched by emergencyStop(); every motion command is refused until clearEstop() or reset() */
  estop = false;
  mission: MissionRuntime | null = null;
  missionResult: MissionResult | null = null;
  previousMissionResult: MissionResult | null = null;
  /** frames the twin wants captured, newest last; the canvas layer consumes them by seq */
  captureQueue: CaptureRequest[] = [];
  private captureSeq = 0;
  /** counts manual episodes between resets so exploration visibly decays; restarts on every test run */
  private episodeCounter = 0;
  private rand = mulberry32(TEST.seed);
  private accumulator = 0;
  private detectAccumulator = 0;
  private detectionMap = new Map<string, Detection>();
  private trackTargetId: string | null = null;
  private rlPhaseTimer = 0;
  // test runner
  private waypointIndex = 0;
  private dwell = 0;
  private seen = new Map<string, Detection>();
  private covered = new Set<number>();
  private falsePositiveIds = new Set<string>();

  /** The scenario factory defaults to the inspection layout; sim:check passes referenceScenario to keep HydraLoom's calibration. */
  constructor(private readonly scenarioFactory: () => Scenario = defaultScenario) {
    this.scenario = scenarioFactory();
    this.rl = freshRL(this.gantry);
  }

  // ---------- public commands ----------

  /** Full reset: default scenario, home position, no history, emergency stop cleared. */
  reset(): void {
    this.restoreMissionEnvironment();
    this.scenario = this.scenarioFactory();
    this.gantry = createGantry();
    this.previousResult = null;
    this.result = null;
    this.mission = null;
    this.missionResult = null;
    this.previousMissionResult = null;
    this.captureQueue = [];
    this.estop = false;
    this.resetRun();
  }

  /** Replaces the whole scenario (a preset). Refused while a mission runs, since disturbances own the water then. */
  loadScenario(next: Scenario): void {
    if (this.mode === "MISSION") return;
    this.scenario = { ...next, objects: next.objects.map((o) => ({ ...o })), disturbances: next.disturbances.map((d) => ({ ...d })) };
    this.setScenario({});
  }

  /** Clears run state but keeps the user's scenario so a test runs with their settings. */
  private resetRun(): void {
    // Replay must be a pure function of scenario + seed, so the episode index restarts too.
    this.episodeCounter = 0;
    this.detections = [];
    this.detectionMap.clear();
    this.rl = freshRL(this.gantry);
    this.mode = "IDLE";
    this.phase = "IDLE";
    this.time = 0;
    this.frame = 0;
    this.events = [];
    this.rand = mulberry32(this.scenario.seed);
    this.detectAccumulator = 0;
    this.trackTargetId = null;
    this.covered.clear();
    this.seen.clear();
    this.falsePositiveIds.clear();
  }

  /** Non-finite fields are ignored, not collapsed to a bound: a bad input never darkens the tank. */
  setScenario(patch: Partial<Omit<Scenario, "objects">>): void {
    const s = this.scenario;
    this.scenario = {
      ...s,
      turbidity: clamp(finite(patch.turbidity, s.turbidity), 0, 1),
      lighting: clamp(finite(patch.lighting, s.lighting), 0, 1),
      threshold: clamp(finite(patch.threshold, s.threshold), 0.3, 0.95),
      gantrySpeed: clamp(finite(patch.gantrySpeed, s.gantrySpeed), 0.2, 1),
      seed: finite(patch.seed, s.seed) >>> 0,
      disturbances: patch.disturbances ?? s.disturbances,
      perceptionFault: patch.perceptionFault ?? s.perceptionFault,
    };
  }

  moveObject(id: string, x: number, y: number): void {
    const o = this.scenario.objects.find((obj) => obj.id === id);
    if (!o) return;
    o.x = clamp(finite(x, o.x), 3, GANTRY.travelX - 3);
    o.y = clamp(finite(y, o.y), 3, GANTRY.travelY - 3);
  }

  moveTo(x: number, y: number): void {
    if (this.estop) return;
    this.stopAuto();
    this.mode = "MANUAL";
    setGantryTarget(this.gantry, x, y);
  }

  track(objectId: string): void {
    const o = this.scenario.objects.find((obj) => obj.id === objectId);
    if (!o || this.estop) return;
    this.stopAuto();
    this.mode = "TRACK";
    this.trackTargetId = objectId;
    this.log("TARGET", `TRACK ${objectId}: coarse position from overhead camera (${o.x.toFixed(0)}, ${o.y.toFixed(0)})`);
    setGantryTarget(this.gantry, o.x, o.y);
  }

  startEpisode(objectId: string): void {
    if (!this.scenario.objects.some((obj) => obj.id === objectId) || this.estop) return;
    this.stopAuto();
    this.mode = "EPISODE";
    this.beginEpisode(objectId);
  }

  /**
   * Starts a test. The carriage first drives home physically (HOMING); the clock,
   * seed and log restart on arrival so the scan is always the same pure function
   * of scenario + seed regardless of where the carriage was.
   */
  runTest(): void {
    if (this.estop) return;
    this.stopAuto();
    this.resetRun();
    this.mode = "TEST";
    this.phase = "HOMING";
    this.waypointIndex = 0;
    setGantryTarget(this.gantry, 0, 0);
  }

  private beginScan(): void {
    // Anything observed while driving home is not part of the test. The previous
    // result survives until here so an aborted homing does not lose it.
    this.resetRun();
    if (this.result) this.previousResult = this.result;
    this.result = null;
    this.mode = "TEST";
    this.phase = "SCANNING";
    this.log("PHASE", `TEST START seed ${this.scenario.seed}`);
    this.gotoWaypoint();
  }

  stopAuto(): void {
    if (this.mode === "MISSION" && this.mission) this.finishMission("ABORTED_BY_OPERATOR");
    this.mode = "IDLE";
    this.phase = "IDLE";
    this.rl.active = false;
    this.trackTargetId = null;
    this.gantry.x.target = this.gantry.x.pos;
    this.gantry.y.target = this.gantry.y.pos;
    this.syncIdleRL();
  }

  /**
   * With no episode running the controller readout mirrors the gantry (STATE and NEXT STATE
   * equal the carriage position) so the card never shows 0,0 beside a carriage at PARK.
   * The observation object is replaced, never mutated, so published snapshots stay frozen.
   */
  private syncIdleRL(): void {
    const rl = this.rl;
    if (rl.active) return;
    const x = this.gantry.x.pos;
    const y = this.gantry.y.pos;
    if (rl.observation.x === x && rl.observation.y === y && rl.nextX === x && rl.nextY === y) return;
    rl.observation = { ...rl.observation, x, y };
    rl.nextX = x;
    rl.nextY = y;
  }

  // ---------- main loop ----------

  tick(dt: number): void {
    if (!(dt > 0)) return; // NaN or negative would freeze the accumulator for good
    this.accumulator += Math.min(dt, 0.25);
    while (this.accumulator >= FIXED_DT) {
      this.substep(FIXED_DT);
      this.accumulator -= FIXED_DT;
    }
  }

  private substep(dt: number): void {
    this.time += dt;
    this.frame = Math.floor(this.time * CAMERA.fps);
    // A mission commands its own speed (the plan's, or the reduced speed while visibility is degraded).
    const speed = this.mode === "MISSION" && this.mission ? this.mission.speedFraction : this.scenario.gantrySpeed;
    stepGantry(this.gantry, dt, speed);

    this.detectAccumulator += dt;
    if (this.detectAccumulator >= 1 / DETECTION.hz) {
      const step = this.detectAccumulator;
      this.detectAccumulator = 0;
      const pass = runDetection({
        gantryX: this.gantry.x.pos,
        gantryY: this.gantry.y.pos,
        scenario: this.scenario,
        time: this.time,
        previous: this.detectionMap,
        dt: step,
      });
      // A dropped camera produces no frames, so nothing can be detected until it returns.
      const blind = this.mode === "MISSION" && this.mission !== null && !this.mission.cameraOnline;
      this.detections = blind ? [] : pass.detections;
      this.inFrame = blind ? 0 : pass.inFrame;
      this.detectionMap = new Map(this.detections.map((d) => [d.objectId, d]));
      if ((this.mode === "TEST" || this.mode === "MISSION") && this.phase !== "HOMING") this.recordCoverage();
    }

    switch (this.mode) {
      case "TRACK":
        this.tickTrack();
        break;
      case "EPISODE":
        this.tickEpisode(dt);
        if (this.rl.done) this.mode = "IDLE";
        break;
      case "TEST":
        this.tickTest(dt);
        break;
      case "MISSION":
        this.tickMission(dt);
        break;
      default:
        break;
    }
    this.syncIdleRL();
  }

  // ---------- track ----------

  private tickTrack(): void {
    if (!this.trackTargetId) return;
    const d = this.detectionMap.get(this.trackTargetId);
    // Refine the coarse target with the vision estimate once the object is in the feed.
    if (d && d.state === "LOCKED") setGantryTarget(this.gantry, d.estX, d.estY);
  }

  // ---------- RL episode ----------

  private targetFor(objectId: string): [number, number] {
    const d = this.detectionMap.get(objectId);
    if (d) return [d.estX, d.estY];
    const o = this.scenario.objects.find((obj) => obj.id === objectId)!;
    return [o.x, o.y];
  }

  private beginEpisode(objectId: string): void {
    this.episodeCounter += 1;
    const [tx, ty] = this.targetFor(objectId);
    const d = this.detectionMap.get(objectId);
    this.rl = {
      ...freshRL(this.gantry),
      active: true,
      episode: this.episodeCounter,
      targetId: objectId,
      observation: {
        x: this.gantry.x.pos,
        y: this.gantry.y.pos,
        targetX: tx,
        targetY: ty,
        confidence: d?.confidence ?? 0,
        prevAction: "HOLD",
      },
      nextX: this.gantry.x.pos,
      nextY: this.gantry.y.pos,
      phase: "OBSERVE",
    };
    this.rlPhaseTimer = 0;
    this.log("RL", `EPISODE ${this.episodeCounter} target ${objectId} (${tx.toFixed(1)}, ${ty.toFixed(1)})`);
  }

  private tickEpisode(dt: number): void {
    const rl = this.rl;
    if (!rl.active || rl.done || !rl.targetId) return;
    this.rlPhaseTimer += dt;

    if (rl.phase === "OBSERVE") {
      if (this.rlPhaseTimer < OBSERVE_DWELL) return;
      const [tx, ty] = this.targetFor(rl.targetId);
      const d = this.detectionMap.get(rl.targetId);
      rl.observation = {
        x: this.gantry.x.pos,
        y: this.gantry.y.pos,
        targetX: tx,
        targetY: ty,
        confidence: d?.confidence ?? 0,
        prevAction: rl.action,
      };
      rl.phase = "DECIDE";
      this.rlPhaseTimer = 0;
      return;
    }

    if (rl.phase === "DECIDE") {
      if (this.rlPhaseTimer < DECIDE_DWELL) return;
      const decision = decide(rl.observation, rl.episode, this.rand);
      const [nx, ny] = applyAction(rl.observation, decision.action);
      rl.action = decision.action;
      rl.policyConfidence = decision.policyConfidence;
      rl.exploring = decision.exploring;
      rl.nextX = nx;
      rl.nextY = ny;
      rl.step += 1;
      setGantryTarget(this.gantry, nx, ny);
      rl.phase = "MOVE";
      this.rlPhaseTimer = 0;
      return;
    }

    // MOVE: wait for the gantry to physically arrive, then score the transition.
    if (!gantryAtTarget(this.gantry)) return;
    const d = this.detectionMap.get(rl.targetId);
    const [tx, ty] = this.targetFor(rl.targetId);
    const next: RLObservation = {
      x: this.gantry.x.pos,
      y: this.gantry.y.pos,
      targetX: tx,
      targetY: ty,
      confidence: d?.confidence ?? 0,
      prevAction: rl.action,
    };
    rl.reward = reward(rl.observation, next, rl.action);
    rl.episodeReward = Math.round((rl.episodeReward + rl.reward) * 100) / 100;
    rl.holdCount = rl.action === "HOLD" && onTarget(next) ? rl.holdCount + 1 : 0;
    this.log(
      "RL",
      `step ${rl.step} ${rl.action}${rl.exploring ? " (explore)" : ""} r=${rl.reward >= 0 ? "+" : ""}${rl.reward.toFixed(2)} pos=(${next.x.toFixed(1)}, ${next.y.toFixed(1)})`,
    );
    if (rl.holdCount >= RL.holdToFinish || rl.step >= RL.maxSteps) {
      rl.done = true;
      rl.active = false;
      this.log("RL", `EPISODE ${rl.episode} done, reward ${rl.episodeReward >= 0 ? "+" : ""}${rl.episodeReward.toFixed(2)}`);
      return;
    }
    rl.phase = "OBSERVE";
    this.rlPhaseTimer = 0;
  }

  // ---------- test runner ----------

  private gotoWaypoint(): void {
    const [x, y] = TEST.scanWaypoints[this.waypointIndex];
    setGantryTarget(this.gantry, x, y);
    this.log("WAYPOINT", `scan ${this.waypointIndex + 1}/${TEST.scanWaypoints.length} -> (${x}, ${y})`);
  }

  private recordCoverage(): void {
    // A floor cell counts as covered when it sits inside the well-centred part of the frustum.
    const [cols, rows] = TEST.coverageGrid;
    const tanH = Math.tan((CAMERA.hfovDeg * Math.PI) / 360);
    const rMax = Math.sqrt((1 - TEST.coverageCenteringMin) / DETECTION.centeringWeight);
    const halfW = CAMERA.lensHeight * tanH * rMax * 100;
    const halfH = halfW / CAMERA.aspect;
    for (let c = 0; c < cols; c++)
      for (let r = 0; r < rows; r++) {
        const cx = ((c + 0.5) / cols) * GANTRY.travelX;
        const cy = ((r + 0.5) / rows) * GANTRY.travelY;
        if (Math.abs(cx - this.gantry.x.pos) <= halfW && Math.abs(cy - this.gantry.y.pos) <= halfH)
          this.covered.add(c * rows + r);
      }
  }

  private tickTest(dt: number): void {
    if (this.phase === "HOMING") {
      if (gantryAtTarget(this.gantry)) this.beginScan();
      return;
    }

    if (this.phase === "SCANNING") {
      if (!gantryAtTarget(this.gantry)) return;
      this.phase = "DETECTING";
      this.dwell = 0;
      return;
    }

    if (this.phase === "DETECTING") {
      this.dwell += dt;
      for (const d of this.detections) {
        const prev = this.seen.get(d.objectId);
        if (!prev || d.confidence > prev.confidence) this.seen.set(d.objectId, d);
        if (!d.correct && d.class !== "UNKNOWN") this.falsePositiveIds.add(d.objectId);
        if (!prev || (d.confidence > prev.confidence && d.class !== prev.class))
          this.log("DETECT", `${d.class} ${(d.confidence * 100).toFixed(1)}% at (${d.estX.toFixed(1)}, ${d.estY.toFixed(1)})`);
      }
      if (this.dwell < TEST.dwellSeconds) return;
      this.waypointIndex += 1;
      if (this.waypointIndex < TEST.scanWaypoints.length) {
        this.phase = "SCANNING";
        this.gotoWaypoint();
        return;
      }
      // Scan complete: choose the best correct-class detection as the tracking target.
      let best: Detection | null = null;
      for (const d of this.seen.values()) if (d.correct && (!best || d.confidence > best.confidence)) best = d;
      if (!best) {
        this.finishTest(null);
        return;
      }
      this.phase = "TRACKING";
      this.log("TARGET", `best target ${best.objectId} ${best.class} ${(best.confidence * 100).toFixed(1)}%`);
      this.beginEpisode(best.objectId);
      return;
    }

    if (this.phase === "TRACKING") {
      this.tickEpisode(dt);
      if (this.rl.done) this.finishTest(this.rl.targetId);
    }
  }

  private finishTest(targetId: string | null): void {
    const seen = [...this.seen.values()];
    const [cols, rows] = TEST.coverageGrid;
    const avg = seen.length ? seen.reduce((s, d) => s + d.confidence, 0) / seen.length : 0;
    this.result = {
      objectsDetected: seen.length,
      successfulDetections: seen.filter((d) => d.correct).length,
      falsePositives: this.falsePositiveIds.size,
      avgConfidence: avg,
      coverage: this.covered.size / (cols * rows),
      episodeReward: this.rl.episodeReward,
      durationS: this.time, // the clock restarts when the scan begins
      targetId,
      turbidity: this.scenario.turbidity,
      lighting: this.scenario.lighting,
      threshold: this.scenario.threshold,
    };
    this.phase = "COMPLETE";
    this.mode = "IDLE";
    this.log("RESULT", `TEST COMPLETE ${seen.length} detected, ${this.falsePositiveIds.size} false positive, coverage ${(this.result.coverage * 100).toFixed(0)}%`);
  }

  // ---------- emergency stop ----------

  /**
   * Latching emergency stop, independent of any mission logic or model output. Steppers stop dead (both axes zeroed
   * this substep), a running mission ends with EMERGENCY_STOP, and every motion command is refused until clearEstop().
   */
  emergencyStop(): void {
    if (this.mode === "MISSION" && this.mission) this.finishMission("EMERGENCY_STOP");
    for (const a of [this.gantry.x, this.gantry.y]) {
      a.vel = 0;
      a.target = a.pos;
    }
    this.gantry.moving = false;
    this.mode = "IDLE";
    this.phase = "IDLE";
    this.rl.active = false;
    this.trackTargetId = null;
    this.estop = true;
    this.log("PHASE", "EMERGENCY STOP latched");
  }

  clearEstop(): void {
    if (!this.estop) return;
    this.estop = false;
    this.log("PHASE", "emergency stop cleared by operator");
  }

  // ---------- missions ----------

  /**
   * Executes a backend-compiled plan. Like a test it first drives home physically, then the clock restarts so a mission
   * is a pure function of plan + scenario + seed. adaptive = false runs the same plan with the visibility policy ignored,
   * which is the fixed-strategy baseline for comparisons. Returns false when the plan is refused.
   */
  runMission(plan: MissionPlan, adaptive = true): boolean {
    if (this.estop || plan.waypoints.length === 0) return false;
    if (plan.waypoints.some((w) => !Number.isFinite(w.x) || !Number.isFinite(w.y))) return false;
    this.stopAuto();
    this.resetRun();
    this.mode = "MISSION";
    this.phase = "HOMING";
    this.mission = {
      plan: { ...plan, waypoints: plan.waypoints.map((w) => ({ x: clamp(w.x, 0, GANTRY.travelX), y: clamp(w.y, 0, GANTRY.travelY), capture: w.capture })) },
      adaptive,
      status: "HOMING",
      perception: "NORMAL_VISIBILITY",
      visibility: estimateVisibility(this.scenario.turbidity, this.scenario.lighting, true),
      minVisibility: 1,
      cameraOnline: true,
      speedFraction: clamp(plan.speedFraction, 0.2, 1),
      waypointIndex: 0,
      visited: 0,
      dwell: 0,
      captured: false,
      reobserve: null,
      reobservedAt: [],
      reobservations: 0,
      captures: 0,
      unreliableCaptures: 0,
      pauses: 0,
      pausedFor: 0,
      recoverFor: 0,
      pauseCause: null,
      reason: "driving home",
      base: { turbidity: this.scenario.turbidity, lighting: this.scenario.lighting },
      seen: new Map(),
    };
    setGantryTarget(this.gantry, 0, 0);
    return true;
  }

  /** Operator pause. Holds position until resumeMission(). */
  pauseMission(): void {
    const m = this.mission;
    if (this.mode !== "MISSION" || !m || m.status !== "RUNNING") return;
    this.enterPause("OPERATOR", "paused by operator");
  }

  /** Operator resume. Refused while visibility is unsafe or the camera is offline: the safety policy outranks the operator. */
  resumeMission(): boolean {
    const m = this.mission;
    if (this.mode !== "MISSION" || !m || m.status !== "PAUSED" || this.estop) return false;
    if (!m.cameraOnline || m.visibility < m.plan.policy.unsafeVisibility) return false;
    this.leavePause("resumed by operator");
    return true;
  }

  stopMission(): void {
    const m = this.mission;
    if (this.mode !== "MISSION" || !m) return;
    this.finishMission(m.status === "PAUSED" && m.pauseCause !== "OPERATOR" ? "STOPPED_UNSAFE_VISIBILITY" : "ABORTED_BY_OPERATOR");
    this.mode = "IDLE";
    this.phase = "IDLE";
    this.gantry.x.target = this.gantry.x.pos;
    this.gantry.y.target = this.gantry.y.pos;
  }

  /** A one-off frame request from the operator (AI Perception scene). Works in any mode except while e-stopped. */
  requestCapture(): CaptureRequest | null {
    if (this.estop) return null;
    return this.emitCapture("MANUAL", this.mission?.plan.missionId ?? "manual", -1);
  }

  missionSnapshot(): MissionSnapshot | null {
    const m = this.mission;
    if (!m) return null;
    return {
      missionId: m.plan.missionId,
      adaptive: m.adaptive,
      status: m.status,
      perception: m.perception,
      visibility: m.visibility,
      speedFraction: m.speedFraction,
      waypointIndex: m.waypointIndex,
      waypointsPlanned: m.plan.waypoints.length,
      cameraOnline: m.cameraOnline,
      pausedForS: m.pausedFor,
      reason: m.reason,
    };
  }

  private emitCapture(reason: CaptureRequest["reason"], missionId: string, waypointIndex: number): CaptureRequest {
    const m = this.mission;
    const cameraOnline = m ? m.cameraOnline : true;
    const req: CaptureRequest = {
      seq: ++this.captureSeq,
      missionId,
      waypointIndex,
      reason,
      gantryX: this.gantry.x.pos,
      gantryY: this.gantry.y.pos,
      time: this.time,
      visibility: m ? m.visibility : estimateVisibility(this.scenario.turbidity, this.scenario.lighting, true),
      turbidity: this.scenario.turbidity,
      lighting: this.scenario.lighting,
      perception: m ? m.perception : "NORMAL_VISIBILITY",
      detections: cameraOnline ? this.detections : [],
      cameraOnline,
    };
    this.captureQueue = [...this.captureQueue.slice(-49), req];
    return req;
  }

  /** Decelerate at the axis limit to the nearest point the carriage can stop at, rather than snapping the target. */
  private controlledStop(): void {
    for (const [a, limit] of [
      [this.gantry.x, GANTRY.travelX],
      [this.gantry.y, GANTRY.travelY],
    ] as const) {
      const stopDist = (a.vel * a.vel) / (2 * GANTRY.accel);
      a.target = clamp(a.pos + Math.sign(a.vel) * stopDist, 0, limit);
    }
  }

  private enterPause(cause: NonNullable<MissionRuntime["pauseCause"]>, reason: string): void {
    const m = this.mission!;
    m.status = "PAUSED";
    m.perception = "INSPECTION_PAUSED";
    m.pauseCause = cause;
    m.pausedFor = 0;
    m.recoverFor = 0;
    m.pauses += 1;
    m.reason = reason;
    this.phase = "PAUSED";
    this.controlledStop();
    this.log("PHASE", `PAUSED: ${reason}`);
  }

  private leavePause(reason: string): void {
    const m = this.mission!;
    m.status = "RUNNING";
    m.pauseCause = null;
    m.reason = reason;
    m.dwell = 0;
    m.captured = false;
    this.log("PHASE", `RESUMED: ${reason}`);
    // Re-approach whatever was interrupted: the re-observation point, or the current plan waypoint.
    if (m.reobserve) {
      this.phase = "REOBSERVING";
      setGantryTarget(this.gantry, m.reobserve.x, m.reobserve.y);
    } else {
      this.phase = "SCANNING";
      const w = m.plan.waypoints[m.waypointIndex];
      setGantryTarget(this.gantry, w.x, w.y);
    }
  }

  private gotoMissionWaypoint(): void {
    const m = this.mission!;
    const w = m.plan.waypoints[m.waypointIndex];
    this.phase = "SCANNING";
    m.dwell = 0;
    m.captured = false;
    setGantryTarget(this.gantry, w.x, w.y);
    this.log("WAYPOINT", `waypoint ${m.waypointIndex + 1}/${m.plan.waypoints.length} -> (${w.x.toFixed(1)}, ${w.y.toFixed(1)})${w.capture ? " capture" : ""}`);
  }

  private advanceWaypoint(): void {
    const m = this.mission!;
    m.waypointIndex += 1;
    if (m.waypointIndex >= m.plan.waypoints.length) {
      this.finishMission("COMPLETED");
      this.mode = "IDLE";
      return;
    }
    this.gotoMissionWaypoint();
  }

  /** Keeps the best observation per object; a centred re-observation outranks the off-axis one it re-checks. */
  private recordSeen(prefer = false): void {
    const m = this.mission!;
    if (!m.cameraOnline) return;
    for (const d of this.detections) {
      const prev = m.seen.get(d.objectId);
      if (!prev || d.confidence > prev.confidence || (prefer && m.reobserve?.objectId === d.objectId)) {
        if (!prev || prev.class !== d.class) this.log("DETECT", `${d.class} ${(d.confidence * 100).toFixed(1)}% at (${d.estX.toFixed(1)}, ${d.estY.toFixed(1)})`);
        m.seen.set(d.objectId, d);
      }
    }
  }

  /** A detection is uncertain when its class has degraded (UNKNOWN or a confusable class below the classify threshold). */
  private reobservationCandidate(): Detection | null {
    const m = this.mission!;
    if (!m.adaptive || m.reobservations >= PERCEPTION.maxReobservations) return null;
    const r = PERCEPTION.reobserveRadiusCm;
    for (const d of this.detections) {
      if (d.confidence >= DETECTION.classifyThreshold) continue;
      if (m.reobservedAt.some(([x, y]) => Math.hypot(x - d.estX, y - d.estY) < r)) continue;
      // Already confirmed from a better viewpoint: association is by estimated position, as it would be on real hardware.
      let confirmed = false;
      for (const seen of m.seen.values())
        if (seen.confidence >= DETECTION.classifyThreshold && Math.hypot(seen.estX - d.estX, seen.estY - d.estY) < 2 * r) confirmed = true;
      if (confirmed) continue;
      return d;
    }
    return null;
  }

  private captureHere(reason: CaptureRequest["reason"]): void {
    const m = this.mission!;
    m.captured = true;
    if (!m.cameraOnline) {
      this.log("PHASE", `capture skipped at waypoint ${m.waypointIndex + 1}: camera offline`);
      return;
    }
    m.captures += 1;
    if (m.visibility < m.plan.policy.unsafeVisibility) m.unreliableCaptures += 1;
    this.emitCapture(reason, m.plan.missionId, m.waypointIndex);
  }

  private tickMission(dt: number): void {
    const m = this.mission;
    if (!m) return;

    if (m.status === "HOMING") {
      if (!gantryAtTarget(this.gantry)) return;
      // Same rule as a test: the clock and the log restart on arrival, the mission state survives.
      const keep = this.mission;
      this.resetRun();
      this.mission = keep;
      this.mode = "MISSION";
      m.status = "RUNNING";
      m.reason = "scanning";
      this.log("PHASE", `MISSION ${m.plan.missionId} START ${m.adaptive ? "adaptive" : "fixed"} strategy, seed ${this.scenario.seed}`);
      this.gotoMissionWaypoint();
      return;
    }

    // Water and camera follow the scripted disturbances on the mission clock.
    const env = environmentAt(m.base, this.scenario.disturbances, this.time);
    this.scenario.turbidity = env.turbidity;
    this.scenario.lighting = env.lighting;
    if (env.cameraOnline !== m.cameraOnline) this.log("PHASE", env.cameraOnline ? "camera back online" : "camera offline");
    m.cameraOnline = env.cameraOnline;
    if (!m.cameraOnline && this.detections.length) {
      this.detections = [];
      this.inFrame = 0;
      this.detectionMap.clear();
    }
    m.visibility = estimateVisibility(env.turbidity, env.lighting, env.cameraOnline);
    m.minVisibility = Math.min(m.minVisibility, m.visibility);
    const policy = m.plan.policy;
    const band = visibilityBand(m.visibility, policy);

    if (this.time > MISSION_TIME_CAP_S) {
      this.stopMission();
      return;
    }

    if (m.status === "PAUSED") {
      m.pausedFor += dt;
      if (m.pauseCause !== "OPERATOR") {
        m.recoverFor = band === "NORMAL" ? m.recoverFor + dt : 0;
        if (m.recoverFor >= PERCEPTION.resumeAfterS) {
          this.leavePause(`visibility ${(m.visibility * 100).toFixed(0)}% recovered`);
          return;
        }
        if (m.pausedFor >= PERCEPTION.operatorTimeoutS && m.perception !== "OPERATOR_INTERVENTION_REQUIRED") {
          m.perception = "OPERATOR_INTERVENTION_REQUIRED";
          m.reason = `paused ${PERCEPTION.operatorTimeoutS.toFixed(0)} s without recovery`;
          this.log("PHASE", "OPERATOR INTERVENTION REQUIRED");
        }
      }
      return;
    }

    // RUNNING. The safety policy is checked before anything else, every substep.
    if (m.adaptive && policy.stopOnUnsafeVisibility && (band === "UNSAFE" || !m.cameraOnline)) {
      this.enterPause(m.cameraOnline ? "VISIBILITY" : "CAMERA", m.cameraOnline ? `visibility ${(m.visibility * 100).toFixed(0)}% below the ${(policy.unsafeVisibility * 100).toFixed(0)}% limit` : "camera offline");
      return;
    }
    const slow = m.adaptive && policy.reduceSpeedOnDegradation && band !== "NORMAL";
    m.speedFraction = slow ? Math.min(policy.reducedSpeedFraction, m.plan.speedFraction) : m.plan.speedFraction;
    if (m.perception !== "LOW_CONFIDENCE" && m.perception !== "REOBSERVATION_REQUIRED") m.perception = band === "NORMAL" ? "NORMAL_VISIBILITY" : "REDUCED_VISIBILITY";

    if (this.phase === "SCANNING") {
      if (!gantryAtTarget(this.gantry)) return;
      m.visited = Math.max(m.visited, m.waypointIndex + 1);
      if (!m.plan.waypoints[m.waypointIndex].capture) {
        this.advanceWaypoint();
        return;
      }
      this.phase = "DETECTING";
      m.dwell = 0;
      m.captured = false;
      return;
    }

    if (this.phase === "DETECTING") {
      m.dwell += dt;
      this.recordSeen();
      if (m.dwell < PERCEPTION.captureDwellS) return;
      if (!m.captured) this.captureHere("SCAN");
      const doubt = m.cameraOnline ? this.reobservationCandidate() : null;
      if (doubt) {
        m.perception = "LOW_CONFIDENCE";
        m.reobserve = { x: clamp(doubt.estX, 0, GANTRY.travelX), y: clamp(doubt.estY, 0, GANTRY.travelY), objectId: doubt.objectId };
        m.reobservedAt.push([doubt.estX, doubt.estY]);
        m.reobservations += 1;
        m.dwell = 0;
        m.captured = false;
        this.phase = "REOBSERVING";
        m.reason = `${doubt.class} at ${(doubt.confidence * 100).toFixed(0)}%: re-centring to re-observe`;
        this.log("PHASE", `LOW CONFIDENCE ${doubt.class} ${(doubt.confidence * 100).toFixed(1)}%: re-observe at (${doubt.estX.toFixed(1)}, ${doubt.estY.toFixed(1)})`);
        setGantryTarget(this.gantry, m.reobserve.x, m.reobserve.y);
        return;
      }
      this.advanceWaypoint();
      return;
    }

    if (this.phase === "REOBSERVING" && m.reobserve) {
      if (!gantryAtTarget(this.gantry)) return;
      m.perception = "REOBSERVATION_REQUIRED";
      m.dwell += dt;
      this.recordSeen(true);
      if (m.dwell < PERCEPTION.reobserveDwellS) return;
      this.captureHere("REOBSERVE");
      m.reobserve = null;
      m.perception = band === "NORMAL" ? "NORMAL_VISIBILITY" : "REDUCED_VISIBILITY";
      m.reason = "scanning";
      this.advanceWaypoint();
    }
  }

  /** Puts the water back the way the operator set it before the disturbances ran. */
  private restoreMissionEnvironment(): void {
    const m = this.mission;
    if (!m) return;
    this.scenario.turbidity = m.base.turbidity;
    this.scenario.lighting = m.base.lighting;
  }

  private finishMission(outcome: MissionOutcome): void {
    const m = this.mission;
    if (!m || m.status === "COMPLETE" || m.status === "ABORTED") return;
    const best = [...m.seen.values()];
    const targets = new Set(m.plan.targets);
    const { xMin, xMax, yMin, yMax } = m.plan.region;
    const [cols, rows] = TEST.coverageGrid;
    let regionCells = 0;
    let covered = 0;
    for (let c = 0; c < cols; c++)
      for (let r = 0; r < rows; r++) {
        const cx = ((c + 0.5) / cols) * GANTRY.travelX;
        const cy = ((r + 0.5) / rows) * GANTRY.travelY;
        if (cx < xMin || cx > xMax || cy < yMin || cy > yMax) continue;
        regionCells += 1;
        if (this.covered.has(c * rows + r)) covered += 1;
      }
    const result: MissionResult = {
      missionId: m.plan.missionId,
      adaptive: m.adaptive,
      outcome,
      waypointsVisited: m.visited,
      waypointsPlanned: m.plan.waypoints.length,
      captures: m.captures,
      unreliableCaptures: m.unreliableCaptures,
      reobservations: m.reobservations,
      pauses: m.pauses,
      confirmedTargets: best.filter((d) => d.correct && targets.has(d.trueType)).length,
      // judged on each object's best observation, so a re-observation that corrects the class removes the false positive
      falsePositives: best.filter((d) => !d.correct && d.class !== "UNKNOWN").length,
      avgConfidence: best.length ? best.reduce((s, d) => s + d.confidence, 0) / best.length : 0,
      coverage: regionCells ? covered / regionCells : 0,
      minVisibility: m.minVisibility,
      durationS: this.time,
    };
    this.restoreMissionEnvironment();
    m.status = outcome === "COMPLETED" ? "COMPLETE" : "ABORTED";
    m.reason = outcome.toLowerCase().replace(/_/g, " ");
    this.phase = outcome === "COMPLETED" ? "COMPLETE" : "IDLE";
    if (this.missionResult) this.previousMissionResult = this.missionResult;
    this.missionResult = result;
    this.log("RESULT", `MISSION ${outcome}: ${result.confirmedTargets} targets confirmed, ${result.falsePositives} false positive, ${result.captures} captures, coverage ${(result.coverage * 100).toFixed(0)}%`);
  }

  // ---------- telemetry ----------

  private log(kind: RunEvent["kind"], text: string): void {
    // New array each time so store subscribers see appends.
    this.events = [...this.events.slice(-199), { t: this.time, kind, text }];
  }

  telemetry(): Telemetry {
    const best = this.detections.reduce((m, d) => Math.max(m, d.confidence), 0);
    return {
      gantry: {
        x: this.gantry.x.pos,
        y: this.gantry.y.pos,
        vx: this.gantry.x.vel,
        vy: this.gantry.y.vel,
        moving: this.gantry.moving,
        atHome: !this.gantry.moving && this.gantry.x.pos === 0 && this.gantry.y.pos === 0,
      },
      camera: { fps: CAMERA.fps, resolution: CAMERA.resolution, frame: this.frame },
      vision: { count: this.detections.length, inFrame: this.inFrame, bestConfidence: best, hz: DETECTION.hz },
      environment: {
        turbidity: this.scenario.turbidity,
        lighting: this.scenario.lighting,
        visibility: this.mission && this.mode === "MISSION" ? this.mission.visibility : estimateVisibility(this.scenario.turbidity, this.scenario.lighting, true),
        source: "SIMULATED",
      },
      system: { arduino: "SIMULATED", raspberryPi: "SIMULATED", camera: "SIMULATED", source: "SIMULATED" },
      time: this.time,
      estop: this.estop,
    };
  }

  lastAction(): Action {
    return this.rl.action;
  }
}
