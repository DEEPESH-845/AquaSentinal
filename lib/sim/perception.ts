import { DETECTION, PERCEPTION, clamp } from "./constants";
import type { Disturbance, VisibilityPolicy } from "./types";

/**
 * Adaptive perception for the digital twin. docs/PERCEPTION_PIPELINE.md.
 *
 * Visibility here is a SIMULATED 0..1 estimate derived from the twin's synthetic turbidity and lighting with the same
 * water and light factors the detector uses at the nadir (distance = lens height). It is not a turbidity measurement.
 * The backend computes a separate image-derived estimate from each captured frame with OpenCV.
 */
export function estimateVisibility(turbidity: number, lighting: number, cameraOnline: boolean): number {
  if (!cameraOnline) return 0;
  const t = clamp(turbidity, 0, 1);
  const water = Math.exp(-DETECTION.turbidityK * t * t);
  const light = Math.pow(clamp(lighting, 0, 1), DETECTION.lightingGamma);
  return water * light;
}

export type VisibilityBand = "NORMAL" | "DEGRADED" | "UNSAFE";

export function visibilityBand(v: number, policy: VisibilityPolicy): VisibilityBand {
  if (v < policy.unsafeVisibility) return "UNSAFE";
  if (v < policy.degradedVisibility) return "DEGRADED";
  return "NORMAL";
}

export function defaultPolicy(): VisibilityPolicy {
  return {
    reduceSpeedOnDegradation: true,
    stopOnUnsafeVisibility: true,
    degradedVisibility: PERCEPTION.degradedVisibility,
    unsafeVisibility: PERCEPTION.unsafeVisibility,
    reducedSpeedFraction: PERCEPTION.reducedSpeedFraction,
  };
}

export interface Environment {
  turbidity: number;
  lighting: number;
  cameraOnline: boolean;
}

/**
 * Water and camera state at mission time t. Disturbances apply in start order; each TURBIDITY or LIGHTING step ramps
 * linearly from the level in force when it starts to its target value, so a schedule is a pure function of t.
 */
export function environmentAt(base: { turbidity: number; lighting: number }, disturbances: readonly Disturbance[], t: number): Environment {
  let turbidity = base.turbidity;
  let lighting = base.lighting;
  let cameraOnline = true;
  const ordered = [...disturbances].sort((a, b) => a.atS - b.atS);
  for (const d of ordered) {
    if (t < d.atS) continue;
    if (d.kind === "CAMERA_DROPOUT") {
      if (t < d.atS + Math.max(0, d.durationS ?? 0)) cameraOnline = false;
      continue;
    }
    const target = clamp(d.value ?? 0, 0, 1);
    const ramp = Math.max(0, d.rampS ?? 0);
    const k = ramp > 0 ? clamp((t - d.atS) / ramp, 0, 1) : 1;
    if (d.kind === "TURBIDITY") turbidity = turbidity + (target - turbidity) * k;
    else lighting = lighting + (target - lighting) * k;
  }
  return { turbidity, lighting, cameraOnline };
}
