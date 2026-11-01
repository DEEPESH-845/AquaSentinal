// Physical dimensions and the gantry -> world mapping. Migrated from HydraLoom lib/sim/constants.ts.
// Gantry travel, motion limits and camera optics come from shared/geometry.json, which the Python backend reads too,
// so the browser twin and the backend back-projection can never disagree. Units: cm for gantry space, metres for world space.
import geometry from "../../shared/geometry.json";
import perception from "../../shared/perception.json";

const GEO_G = geometry.gantry;
const GEO_C = geometry.camera;
const [ORIGIN_X, ORIGIN_Y] = GEO_G.originOffsetCm;

export const TANK = {
  length: 1.2, // world X, m
  width: 0.6, // world Z, m
  height: 0.6, // glass height, m
  waterLevel: 0.5, // m above sand
  glass: 0.01,
  sandDepth: 0.03,
} as const;

export const GANTRY = {
  travelX: GEO_G.travelXCm, // cm
  travelY: GEO_G.travelYCm, // cm
  maxSpeed: GEO_G.maxSpeedCmS, // cm/s at gantrySpeed = 1
  accel: GEO_G.accelCmS2, // cm/s^2
  stepCm: 5, // one RL action
  railHeight: 0.7, // world Y of the X rails
  frameHeight: 0.6, // world Y of tank rim
  arriveTolerance: 0.15, // cm
} as const;

export const CAMERA = {
  lensHeight: GEO_C.lensHeightM, // world Y of the lens, 8 cm below the surface
  hfovDeg: GEO_C.hfovDeg, // effective underwater horizontal FOV
  aspect: GEO_C.aspect,
  captureWidth: GEO_C.captureWidthPx,
  captureHeight: GEO_C.captureHeightPx,
  fps: 30,
  resolution: "1280x960 (simulated)",
} as const;

export const DETECTION = {
  hz: 10,
  lockSeconds: 0.6,
  classifyThreshold: 0.65, // below this the reported class degrades
  // Geometry penalties are additive; light and water are multiplicative, so no light sees nothing
  // and fully silted water sees nothing at the default threshold. Calibrated in docs/BLUEPRINT.md 4.2.
  centeringWeight: 0.3,
  burialWeight: 0.15,
  turbidityK: 1.1, // exp(-k * turbidity^2 * distance / lensHeight)
  lightingGamma: 0.3, // lighting^gamma
  minVisibleFraction: 0.3, // of the projected box inside the frame
  jitter: 0.01,
} as const;

export const RL = {
  maxSteps: 40,
  holdToFinish: 3,
  epsilonStart: 0.15,
  epsilonDecayEpisodes: 20,
  stepCost: 0.05,
  holdBonus: 1.0,
  confidenceWeight: 0.5,
} as const;

export const TEST = {
  scanWaypoints: [
    [15, 10],
    [50, 10],
    [85, 10],
    [85, 30],
    [50, 30],
    [15, 30],
  ] as ReadonlyArray<readonly [number, number]>,
  dwellSeconds: 1.2,
  coverageGrid: [12, 5] as const,
  coverageCenteringMin: 0.95, // a cell counts only inside the detection-grade frame centre
  seed: 1337,
} as const;

/** Adaptive perception thresholds. docs/PERCEPTION_PIPELINE.md. */
export const PERCEPTION = {
  degradedVisibility: perception.degradedVisibility,
  unsafeVisibility: perception.unsafeVisibility,
  reducedSpeedFraction: perception.reducedSpeedFraction,
  resumeAfterS: perception.resumeAfterS,
  operatorTimeoutS: perception.operatorTimeoutS,
  maxReobservations: perception.maxReobservations,
  reobserveRadiusCm: perception.reobserveRadiusCm,
  captureDwellS: 1.0,
  reobserveDwellS: 1.2,
} as const;

/** Gantry cm -> world metres (sand surface is world Y = 0). */
export function gantryToWorld(xCm: number, yCm: number): [number, number] {
  return [(xCm - ORIGIN_X) / 100, (yCm - ORIGIN_Y) / 100];
}

/** World metres -> gantry cm. */
export function worldToGantry(wx: number, wz: number): [number, number] {
  return [wx * 100 + ORIGIN_X, wz * 100 + ORIGIN_Y];
}

/** NaN and Infinity collapse to the lower bound so bad input can never poison the engine. */
export const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);
