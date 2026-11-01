import { GANTRY, clamp } from "./constants";
import type { AxisState, GantryState } from "./types";

/** Parked over the middle of the tank so the camera and its footprint read at a glance. */
export const PARK: readonly [number, number] = [50, 20];

export function createGantry(): GantryState {
  return {
    x: { pos: PARK[0], vel: 0, target: PARK[0] },
    y: { pos: PARK[1], vel: 0, target: PARK[1] },
    moving: false,
  };
}

/**
 * One axis of a trapezoidal move: accelerate toward the target, decelerate so
 * the axis stops exactly on it, never exceed vmax, never leave the rail.
 */
function stepAxis(a: AxisState, dt: number, vmax: number, accel: number, limit: number): void {
  a.target = clamp(a.target, 0, limit);
  const err = a.target - a.pos;
  const dist = Math.abs(err);

  if (dist < GANTRY.arriveTolerance && Math.abs(a.vel) < accel * dt * 1.5) {
    a.pos = a.target;
    a.vel = 0;
    return;
  }

  const dir = Math.sign(err);
  // Speed at which we can still stop in the remaining distance.
  const stopSpeed = Math.sqrt(2 * accel * dist);
  const desired = dir * Math.min(vmax, stopSpeed);
  const dv = clamp(desired - a.vel, -accel * dt, accel * dt);
  a.vel += dv;
  a.pos = clamp(a.pos + a.vel * dt, 0, limit);
}

export function stepGantry(g: GantryState, dt: number, speedFraction: number): void {
  const vmax = GANTRY.maxSpeed * clamp(speedFraction, 0.2, 1);
  stepAxis(g.x, dt, vmax, GANTRY.accel, GANTRY.travelX);
  stepAxis(g.y, dt, vmax, GANTRY.accel, GANTRY.travelY);
  g.moving = g.x.vel !== 0 || g.y.vel !== 0;
}

export function gantryAtTarget(g: GantryState): boolean {
  return !g.moving && g.x.pos === g.x.target && g.y.pos === g.y.target;
}

/** A non-finite coordinate is dropped (that axis keeps its target) rather than sent to a rail end. */
export function setGantryTarget(g: GantryState, x: number, y: number): void {
  if (Number.isFinite(x)) g.x.target = clamp(x, 0, GANTRY.travelX);
  if (Number.isFinite(y)) g.y.target = clamp(y, 0, GANTRY.travelY);
}
