import { CAMERA, DETECTION, clamp, gantryToWorld, worldToGantry } from "./constants";
import { hash01 } from "./rng";
import type { Detection, DetectionState, Scenario, TestObject } from "./types";

const tanH = Math.tan((CAMERA.hfovDeg * Math.PI) / 360);
const tanV = tanH / CAMERA.aspect;

/**
 * Pinhole camera at (cx, lensHeight, cz) looking straight down.
 * Feed right = +world X, feed down = +world Z, so image coordinates grow with
 * gantry x and gantry y. This must match the Three camera in the feed renderer,
 * which uses up = (0, 0, -1).
 */
export function projectToFeed(
  camX: number,
  camZ: number,
  wx: number,
  wy: number,
  wz: number,
): { u: number; v: number; h: number } {
  const h = CAMERA.lensHeight - wy;
  if (h <= 0.001) return { u: NaN, v: NaN, h };
  const ndcX = (wx - camX) / (h * tanH);
  const ndcY = -(wz - camZ) / (h * tanV);
  return { u: (ndcX + 1) / 2, v: (1 - ndcY) / 2, h };
}

/** Rotated footprint corners of an object, projected into the feed. */
function projectBounds(camX: number, camZ: number, o: TestObject) {
  const [ox, oz] = gantryToWorld(o.x, o.y);
  const [hx, hy, hz] = o.halfExtents;
  const r = (o.rotation * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  let minU = Infinity,
    minV = Infinity,
    maxU = -Infinity,
    maxV = -Infinity;
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      for (const sy of [-1, 1]) {
        const lx = sx * hx;
        const lz = sz * hz;
        // same handedness as Three's rotation.y, which TestObjects applies to the meshes
        const wx = ox + lx * c + lz * s;
        const wz = oz - lx * s + lz * c;
        const wy = Math.max(0, o.z - o.burial * hy + sy * hy); // sunk into sand, never below it
        const p = projectToFeed(camX, camZ, wx, wy, wz);
        minU = Math.min(minU, p.u);
        maxU = Math.max(maxU, p.u);
        minV = Math.min(minV, p.v);
        maxV = Math.max(maxV, p.v);
      }
  return { minU, minV, maxU, maxV };
}

/** Once detected, an object stays detected until it drops this far below the threshold. */
export const HYSTERESIS = 0.05;

export interface DetectionInput {
  gantryX: number;
  gantryY: number;
  scenario: Scenario;
  time: number;
  /** previous detections keyed by object id, for lock ageing */
  previous: Map<string, Detection>;
  dt: number;
}

/** Deterministic detection pass. docs/BLUEPRINT.md section 4.2. */
export interface DetectionOutput {
  detections: Detection[];
  /** objects whose projected box is in the frame, detected or not */
  inFrame: number;
}

export function runDetection(input: DetectionInput): DetectionOutput {
  const { scenario, time, previous, dt } = input;
  const [camX, camZ] = gantryToWorld(input.gantryX, input.gantryY);
  const out: Detection[] = [];
  let inFrame = 0;
  const tick = Math.floor(time * DETECTION.hz);

  for (let i = 0; i < scenario.objects.length; i++) {
    const o = scenario.objects[i];
    const [ox, oz] = gantryToWorld(o.x, o.y);

    // Visibility is judged on the projected box, so a large object half in frame still counts.
    const b = projectBounds(camX, camZ, o);
    const u = clamp(b.minU, 0, 1);
    const v = clamp(b.minV, 0, 1);
    const w = clamp(b.maxU, 0, 1) - u;
    const hh = clamp(b.maxV, 0, 1) - v;
    const fullArea = (b.maxU - b.minU) * (b.maxV - b.minV);
    if (!(fullArea > 0) || (w * hh) / fullArea < DETECTION.minVisibleFraction) continue;
    inFrame += 1;

    const cu = u + w / 2;
    const cv = v + hh / 2;
    const ndcX = cu * 2 - 1;
    const ndcY = 1 - cv * 2;
    const rSq = ndcX * ndcX + ndcY * ndcY;

    const lateral = Math.hypot(ox - camX, oz - camZ);
    const distance = Math.hypot(lateral, CAMERA.lensHeight - o.z);
    const geometry = 1 - DETECTION.centeringWeight * rSq - DETECTION.burialWeight * o.burial;
    const water = Math.exp((-DETECTION.turbidityK * scenario.turbidity * scenario.turbidity * distance) / CAMERA.lensHeight);
    const light = Math.pow(clamp(scenario.lighting, 0, 1), DETECTION.lightingGamma);
    const jitter = (hash01(i + 1, tick, scenario.seed) - 0.5) * 2 * DETECTION.jitter;
    const confidence = clamp(o.detectability * geometry * water * light + jitter, 0, 0.995);

    const prev = previous.get(o.id);
    const gate = prev ? scenario.threshold - HYSTERESIS : scenario.threshold;
    if (confidence < gate) continue;

    let cls: Detection["class"] = o.type;
    if (confidence < DETECTION.classifyThreshold) cls = o.confusableAs ?? "UNKNOWN";

    // Estimated position: back-project the feed centre of the box onto the sand plane.
    const estWX = camX + (cu * 2 - 1) * CAMERA.lensHeight * tanH;
    const estWZ = camZ + (cv * 2 - 1) * CAMERA.lensHeight * tanV;
    const [estX, estY] = worldToGantry(estWX, estWZ);

    const age = prev ? prev.age + dt : 0;
    const state: DetectionState = age >= DETECTION.lockSeconds ? "LOCKED" : "DETECTED";

    out.push({
      objectId: o.id,
      trueType: o.type,
      class: cls,
      confidence,
      correct: cls === o.type,
      bbox: [u, v, w, hh],
      estX,
      estY,
      distance,
      state,
      age,
      timestamp: time,
    });
  }
  return { detections: out, inFrame };
}
