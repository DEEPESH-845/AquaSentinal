"use client";

import { OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import gsap from "gsap";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { CAMERA, GANTRY, TANK, gantryToWorld } from "@/lib/sim/constants";
import { useSimStore, type CameraPreset } from "@/lib/sim/store";
import { SHELF } from "./Electronics";
import { FOOT_HALF_H, FOOT_HALF_W } from "./Overlays";
import { freeRect, observeOverlay, refreshFreeRect } from "./util";

type V3 = [number, number, number];

/** Vertical FOV of the main camera, degrees. */
export const MAIN_FOV = 40;

/** Fraction of the fit rect the subject may fill; the rest is breathing room and keeps the perspective gentle. */
const FILL = 0.8;

/**
 * A preset is a view direction (from the subject toward the camera) plus the world points that must stay in the
 * free rect. Follow presets give points relative to the carriage reference point and move with it.
 */
interface Preset {
  dir: V3;
  points: V3[];
  follow?: boolean;
  /** never closer than this, so a low outside-the-glass shot cannot end up inside the tank */
  minDist?: number;
}

const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): V3[] => [
  [x0, y0, z0],
  [x1, y0, z0],
  [x0, y1, z0],
  [x1, y1, z0],
  [x0, y0, z1],
  [x1, y0, z1],
  [x0, y1, z1],
  [x1, y1, z1],
];

const FRAME_TOP = GANTRY.railHeight + 0.12; // beam, Y motor and chains sit under this
const TABLE_TOP = -TANK.sandDepth - TANK.glass - 0.04;
const HOUSING_R = 0.03;

const PRESETS: Record<CameraPreset, Preset> = {
  // three-quarter overview from front right, about 21 degrees above the rim: tank on its table, gantry frame, electronics shelf
  A: { dir: [1.78, 0.95, 1.7], points: box(-0.66, SHELF.x1 + 0.01, TABLE_TOP, FRAME_TOP, -0.36, 0.37) },
  // top-down, camera just off the +Z side so screen right = +X and screen down = +Z like the feed
  B: { dir: [0, 1, 0.012], points: box(-0.66, 0.66, 0, FRAME_TOP, -0.37, 0.37) },
  // underwater side view through the +Z glass: the water volume
  C: { dir: [-0.35, 0.18, 1], points: box(-TANK.length / 2, TANK.length / 2, 0, TANK.waterLevel, -TANK.width / 2, TANK.width / 2) },
  // detection camera context: footprint, housing and carriage seen from the +Z side, steep enough to clear the
  // X cable chain and the +Z rail, with screen right = +world X exactly as in the feed
  D: {
    dir: [0, 1.35, 0.25],
    follow: true,
    points: [
      ...box(-FOOT_HALF_W, FOOT_HALF_W, 0, 0, -FOOT_HALF_H, FOOT_HALF_H),
      ...box(-HOUSING_R, HOUSING_R, CAMERA.lensHeight, CAMERA.lensHeight + 0.1, -HOUSING_R, HOUSING_R),
      ...box(-0.06, 0.03, GANTRY.railHeight + 0.09, GANTRY.railHeight + 0.09, -0.06, 0.06),
    ],
  },
  // just under the waterline outside the -Z glass: housing and the mirrored surface underside
  E: { dir: [0.42, -0.18, -0.55], follow: true, minDist: 0.72, points: box(-0.12, 0.12, CAMERA.lensHeight - 0.08, TANK.waterLevel + 0.1, -0.12, 0.12) },
};
export const INITIAL_CAMERA: V3 = [1.9, 1.35, 1.7];

// Camera moves are wall-clock: without this a slow frame makes GSAP step 33 ms per frame and a 1.4 s
// preset move can take tens of seconds on a struggling GPU.
gsap.ticker.lagSmoothing(0);

/** Carriage reference point: the lens, on the mast axis. */
function carriagePoint(out: THREE.Vector3) {
  const g = useSimStore.getState().engine.gantry;
  const [wx, wz] = gantryToWorld(g.x.pos, g.y.pos);
  return out.set(wx, CAMERA.lensHeight, wz);
}

const fitCam = new THREE.PerspectiveCamera(MAIN_FOV, 1, 0.02, 40);
const fv = new THREE.Vector3();
const fRight = new THREE.Vector3();
const fUp = new THREE.Vector3();

/**
 * Screen rect the subject is fitted into: centred on the frame horizontally (the model reads as the hero of the
 * page), centred vertically in the band between the header and the bottom card, and never wider than the nearest
 * side obstruction (scene rail, right column) allows. The card therefore never covers the subject.
 */
function fitRect(width: number, height: number) {
  const r = freeRect(width, height);
  const cx = width / 2;
  const cy = (r.y0 + r.y1) / 2;
  const hw = Math.min(cx - r.x0, r.x1 - cx);
  const hh = (r.y1 - r.y0) / 2;
  return { x0: cx - hw, x1: cx + hw, y0: cy - hh, y1: cy + hh };
}

/**
 * Places the camera along `dir` from `target` so every point projects inside the free rect, centred on it.
 * A few fixed-point iterations: shift the target by the bbox centre error, scale the distance by the
 * bbox size error. Deterministic for a given viewport, so a preset always ends in the same pose.
 */
function fit(preset: Preset, origin: THREE.Vector3 | null, width: number, height: number, outPos: THREE.Vector3, outTarget: THREE.Vector3) {
  const rect = fitRect(width, height);
  const cx = (rect.x0 + rect.x1) / width - 1;
  const cy = 1 - (rect.y0 + rect.y1) / height;
  const hw = ((rect.x1 - rect.x0) / width) * FILL;
  const hh = ((rect.y1 - rect.y0) / height) * FILL;
  const dir = fv.set(...preset.dir).normalize().clone();
  const sx = origin && origin.x < 0 ? -1 : 1; // follow shots stand on the outer X side of the carriage
  dir.x *= sx;
  const pts = preset.points.map(([x, y, z]) => (origin ? new THREE.Vector3(origin.x + x * sx, y, origin.z + z) : new THREE.Vector3(x, y, z)));

  outTarget.set(0, 0, 0);
  for (const p of pts) outTarget.add(p);
  outTarget.divideScalar(pts.length);
  let dist = 1;
  fitCam.aspect = width / height;
  fitCam.updateProjectionMatrix();
  const tanHalf = Math.tan((MAIN_FOV * Math.PI) / 360);
  for (let i = 0; i < 8; i++) {
    fitCam.position.copy(outTarget).addScaledVector(dir, dist);
    fitCam.lookAt(outTarget);
    fitCam.updateMatrixWorld();
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (const p of pts) {
      fv.copy(p).project(fitCam);
      minX = Math.min(minX, fv.x);
      maxX = Math.max(maxX, fv.x);
      minY = Math.min(minY, fv.y);
      maxY = Math.max(maxY, fv.y);
    }
    const halfH = dist * tanHalf;
    fRight.setFromMatrixColumn(fitCam.matrixWorld, 0);
    fUp.setFromMatrixColumn(fitCam.matrixWorld, 1);
    outTarget.addScaledVector(fRight, ((minX + maxX) / 2 - cx) * halfH * fitCam.aspect).addScaledVector(fUp, ((minY + maxY) / 2 - cy) * halfH);
    dist = Math.max(preset.minDist ?? 0.25, dist * Math.max((maxX - minX) / 2 / hw, (maxY - minY) / 2 / hh));
  }
  outPos.copy(outTarget).addScaledVector(dir, dist);
}

export function CameraRig() {
  const controls = useRef<OrbitControlsImpl>(null);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const preset = useSimStore((s) => s.cameraPreset);
  // bumps whenever the DOM overlay leaves a materially different free area (scene card height, compact layout, resize)
  const [layout, setLayout] = useState(0);
  useEffect(() => observeOverlay(() => setLayout((n) => n + 1)), []);
  const tween = useRef<gsap.core.Tween | null>(null);
  const following = useRef(false);
  const userMoved = useRef(false);
  const tmp = useMemo(
    () => ({
      anchor: new THREE.Vector3(),
      now: new THREE.Vector3(),
      delta: new THREE.Vector3(),
      fromPos: new THREE.Vector3(),
      fromTarget: new THREE.Vector3(),
      relPos: new THREE.Vector3(),
      relTarget: new THREE.Vector3(),
      endPos: new THREE.Vector3(),
      endTarget: new THREE.Vector3(),
    }),
    [],
  );

  useEffect(() => {
    camera.layers.enable(1); // mast and housing
    camera.layers.enable(2); // HUD overlays
  }, [camera]);

  // Dev only: lets browser tests read the live camera pose and orbit target.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const w = window as unknown as { __labCamera?: { camera: THREE.Camera; controls: OrbitControlsImpl | null; tweening: () => boolean; presets: typeof PRESETS } };
    w.__labCamera = { camera, controls: controls.current, tweening: () => tween.current !== null, presets: PRESETS };
  }, [camera]);

  const lastPreset = useRef<CameraPreset | null>(null);
  const mountedAt = useRef(0);
  useEffect(() => {
    mountedAt.current = performance.now();
  }, []);
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const { width: W, height: H } = size;
    refreshFreeRect();
    // A resize or a card height change refits the preset unless the user has taken the camera; a preset change always does.
    if (preset === lastPreset.current && userMoved.current) return;
    // the first fit, and any layout settling in the first second after mount, snaps instead of tweening
    const instant = lastPreset.current === null || performance.now() - mountedAt.current < 1000;
    lastPreset.current = preset;
    userMoved.current = false;
    tween.current?.kill();
    const p = PRESETS[preset];
    following.current = !!p.follow;
    const origin = p.follow ? carriagePoint(tmp.anchor) : null;
    fit(p, origin, W, H, tmp.endPos, tmp.endTarget);
    if (origin) {
      tmp.relPos.subVectors(tmp.endPos, origin);
      tmp.relTarget.subVectors(tmp.endTarget, origin);
    }
    if (instant) {
      camera.position.copy(tmp.endPos);
      c.target.copy(tmp.endTarget);
      return;
    }
    tmp.fromPos.copy(camera.position);
    tmp.fromTarget.copy(c.target);
    const s = { t: 0 };
    // Follow shots re-read the carriage on every step, so the camera lands attached even if it moved mid-tween.
    const tl = gsap.to(s, {
      t: 1,
      duration: 1.4,
      ease: "power2.inOut",
      onUpdate: () => {
        if (origin) {
          carriagePoint(tmp.anchor);
          tmp.endPos.addVectors(tmp.anchor, tmp.relPos);
          tmp.endTarget.addVectors(tmp.anchor, tmp.relTarget);
        }
        camera.position.lerpVectors(tmp.fromPos, tmp.endPos, s.t);
        c.target.lerpVectors(tmp.fromTarget, tmp.endTarget, s.t);
      },
      onComplete: () => (tween.current = null),
    });
    tween.current = tl;
    return () => {
      tl.kill();
      tween.current = null;
    };
  }, [preset, layout, camera, tmp, size]);

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const onStart = () => {
      tween.current?.kill();
      tween.current = null;
      userMoved.current = true;
    };
    c.addEventListener("start", onStart);
    return () => c.removeEventListener("start", onStart);
  }, []);

  // While a follow preset is active, translate the rig with the carriage. Orbiting still works.
  useFrame(() => {
    const c = controls.current;
    if (!c || !following.current) return;
    carriagePoint(tmp.now);
    tmp.delta.subVectors(tmp.now, tmp.anchor);
    tmp.anchor.copy(tmp.now);
    if (tween.current) return;
    if (tmp.delta.lengthSq() === 0) return;
    camera.position.add(tmp.delta);
    c.target.add(tmp.delta);
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.08}
      target={[0.12, 0.2, 0]}
      minDistance={0.08}
      maxDistance={14}
      minPolarAngle={0}
      maxPolarAngle={Math.PI}
      enablePan
      panSpeed={0.6}
      rotateSpeed={0.7}
      zoomSpeed={0.8}
    />
  );
}
