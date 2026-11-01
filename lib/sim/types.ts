/**
 * Object classes. The inspection classes are AquaSentinal's; SHIPWRECK and MINE survive only in the
 * HydraLoom reference scenario that keeps the original calibration under test (lib/sim/scenario.ts).
 */
export type ObjectType =
  | "PIPE_SEGMENT"
  | "PIPE_JOINT"
  | "VALVE"
  | "LOOSE_CABLE"
  | "FOREIGN_OBJECT"
  | "INSPECTION_PANEL"
  | "DEBRIS"
  | "SHIPWRECK"
  | "MINE";
export type DetectedClass = ObjectType | "UNKNOWN";

/** Which mesh the 3D scene draws for an object. Independent of class so two classes can share a model. */
export type ModelKind =
  | "pipe-segment"
  | "pipe-joint"
  | "valve"
  | "cable"
  | "rope"
  | "crate"
  | "wrench"
  | "panel"
  | "rocks"
  | "bracket"
  | "wreck"
  | "mine"
  | "pipe";

export interface TestObject {
  id: string;
  type: ObjectType;
  model: ModelKind;
  label: string;
  /** gantry cm */
  x: number;
  y: number;
  /** world metres, centre height above sand */
  z: number;
  /** world metres, half extents along world X, Y(up), Z */
  halfExtents: [number, number, number];
  /** yaw degrees around world Y */
  rotation: number;
  /** 0..1 base detectability of the printed model */
  detectability: number;
  /** 0..1 fraction buried in sand */
  burial: number;
  /** Deterministic false-positive path: reported class at low confidence */
  confusableAs?: DetectedClass;
}

export type DetectionState = "SCAN" | "DETECTED" | "LOCKED";

export interface Detection {
  objectId: string;
  trueType: ObjectType;
  class: DetectedClass;
  confidence: number;
  correct: boolean;
  /** normalised feed coords from top-left: u, v, w, h in 0..1 */
  bbox: [number, number, number, number];
  /** estimated gantry cm of the object, from the feed centre */
  estX: number;
  estY: number;
  /** metres from lens to object centre */
  distance: number;
  state: DetectionState;
  /** seconds continuously detected */
  age: number;
  timestamp: number;
}

export type Action = "MOVE_X+" | "MOVE_X-" | "MOVE_Y+" | "MOVE_Y-" | "HOLD";
export const ACTIONS: Action[] = ["MOVE_X+", "MOVE_X-", "MOVE_Y+", "MOVE_Y-", "HOLD"];

export interface AxisState {
  pos: number;
  vel: number;
  target: number;
}

export interface GantryState {
  x: AxisState;
  y: AxisState;
  moving: boolean;
}

export interface RLObservation {
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  confidence: number;
  prevAction: Action;
}

export interface RLState {
  active: boolean;
  done: boolean;
  episode: number;
  step: number;
  targetId: string | null;
  observation: RLObservation;
  action: Action;
  reward: number;
  episodeReward: number;
  /** softmax of action scores for the chosen action */
  policyConfidence: number;
  exploring: boolean;
  /** last chosen next state, for the STATE -> ACTION -> NEXT STATE readout */
  nextX: number;
  nextY: number;
  holdCount: number;
  /** seconds since the last step, for the OBSERVE -> DECIDE -> MOVE phase readout */
  phase: "OBSERVE" | "DECIDE" | "MOVE";
}

/** A scripted change to the water or the camera during a mission, in seconds from the start of the scan. */
export interface Disturbance {
  kind: "TURBIDITY" | "LIGHTING" | "CAMERA_DROPOUT";
  atS: number;
  /** target value for TURBIDITY and LIGHTING, reached linearly over rampS */
  value?: number;
  rampS?: number;
  /** CAMERA_DROPOUT length */
  durationS?: number;
}

export interface Scenario {
  objects: TestObject[];
  /** 0..1 */
  turbidity: number;
  /** 0..1 */
  lighting: number;
  /** 0..1 */
  threshold: number;
  /** 0.2..1 fraction of max gantry speed */
  gantrySpeed: number;
  seed: number;
  /** scripted disturbances applied while a mission runs; restored when it ends */
  disturbances: Disturbance[];
  /** test fixture forwarded to the backend with captures: makes the offline segmentation provider fail */
  perceptionFault: "NONE" | "SEGMENTATION_FAILURE";
}

export type RunPhase = "IDLE" | "HOMING" | "SCANNING" | "DETECTING" | "TRACKING" | "REOBSERVING" | "PAUSED" | "COMPLETE";

export interface TestResult {
  objectsDetected: number;
  successfulDetections: number;
  falsePositives: number;
  avgConfidence: number;
  coverage: number;
  episodeReward: number;
  durationS: number;
  targetId: string | null;
  /** scenario parameters the run used */
  turbidity: number;
  lighting: number;
  threshold: number;
}

export interface RunEvent {
  t: number;
  kind: "PHASE" | "WAYPOINT" | "DETECT" | "TARGET" | "RL" | "RESULT";
  text: string;
}

export type EngineMode = "IDLE" | "MANUAL" | "TRACK" | "EPISODE" | "TEST" | "MISSION";

// ---------------------------------------------------------------- missions

/** The six adaptive perception states. docs/PERCEPTION_PIPELINE.md. */
export type PerceptionState =
  | "NORMAL_VISIBILITY"
  | "REDUCED_VISIBILITY"
  | "LOW_CONFIDENCE"
  | "REOBSERVATION_REQUIRED"
  | "INSPECTION_PAUSED"
  | "OPERATOR_INTERVENTION_REQUIRED";

export interface VisibilityPolicy {
  reduceSpeedOnDegradation: boolean;
  stopOnUnsafeVisibility: boolean;
  degradedVisibility: number;
  unsafeVisibility: number;
  reducedSpeedFraction: number;
}

export interface PlanWaypoint {
  x: number;
  y: number;
  capture: boolean;
}

/**
 * An executable plan. It is compiled and validated by the backend from a mission spec
 * (backend/app/mission/compiler.py); the twin only executes it. Mirrors schemas.MissionPlan.
 */
export interface MissionPlan {
  missionId: string;
  waypoints: PlanWaypoint[];
  speedFraction: number;
  /** ObjectTypes the mission looks for; drives re-observation and the result */
  targets: ObjectType[];
  policy: VisibilityPolicy;
  /** bounding region in gantry cm, for coverage */
  region: { xMin: number; xMax: number; yMin: number; yMax: number };
}

export type MissionStatus = "HOMING" | "RUNNING" | "PAUSED" | "COMPLETE" | "ABORTED";

export type MissionOutcome = "COMPLETED" | "ABORTED_BY_OPERATOR" | "EMERGENCY_STOP" | "STOPPED_UNSAFE_VISIBILITY";

/** A frame the twin wants captured. The canvas layer renders it and sends it to the backend. */
export interface CaptureRequest {
  seq: number;
  missionId: string;
  waypointIndex: number;
  /** "SCAN" at a planned waypoint, "REOBSERVE" when the controller re-centred on an uncertain detection */
  reason: "SCAN" | "REOBSERVE" | "MANUAL";
  gantryX: number;
  gantryY: number;
  time: number;
  visibility: number;
  turbidity: number;
  lighting: number;
  perception: PerceptionState;
  detections: Detection[];
  cameraOnline: boolean;
}

export interface MissionResult {
  missionId: string;
  adaptive: boolean;
  outcome: MissionOutcome;
  waypointsVisited: number;
  waypointsPlanned: number;
  captures: number;
  /** frames captured while visibility was below the unsafe threshold */
  unreliableCaptures: number;
  reobservations: number;
  pauses: number;
  /** distinct target-class objects detected with the correct class */
  confirmedTargets: number;
  falsePositives: number;
  avgConfidence: number;
  coverage: number;
  minVisibility: number;
  durationS: number;
}

export interface MissionSnapshot {
  missionId: string;
  adaptive: boolean;
  status: MissionStatus;
  perception: PerceptionState;
  visibility: number;
  speedFraction: number;
  waypointIndex: number;
  waypointsPlanned: number;
  cameraOnline: boolean;
  pausedForS: number;
  reason: string;
}

export interface Telemetry {
  gantry: { x: number; y: number; vx: number; vy: number; moving: boolean; atHome: boolean };
  camera: { fps: number; resolution: string; frame: number };
  vision: { count: number; inFrame: number; bestConfidence: number; hz: number };
  environment: { turbidity: number; lighting: number; visibility: number; source: "SIMULATED" };
  system: { arduino: string; raspberryPi: string; camera: string; source: "SIMULATED" };
  estop: boolean;
  time: number;
}
