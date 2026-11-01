"use client";

import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { CAMERA, GANTRY, TANK, gantryToWorld } from "@/lib/sim/constants";
import type { SimEngine } from "@/lib/sim/engine";
import type { ObjectType } from "@/lib/sim/types";
import { useSimStore, type ComponentId } from "@/lib/sim/store";
import { ARDUINO_POS, PI_POS } from "./Electronics";
import { AMBER, TEAL, freeRect } from "./util";

const TAN_H = Math.tan((CAMERA.hfovDeg * Math.PI) / 360);
export const FOOT_HALF_W = CAMERA.lensHeight * TAN_H;
export const FOOT_HALF_H = FOOT_HALF_W / CAMERA.aspect;
const MAX_RINGS = 8;

function lineMat(color: string, opacity: number) {
  return new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false, fog: false });
}

/* ---------- camera footprint, target ring, path line, detection rings, sand grid ---------- */

export function Overlays() {
  const res = useMemo(() => {
    const y = 0.002;
    const c = [
      [-FOOT_HALF_W, y, -FOOT_HALF_H],
      [FOOT_HALF_W, y, -FOOT_HALF_H],
      [FOOT_HALF_W, y, FOOT_HALF_H],
      [-FOOT_HALF_W, y, FOOT_HALF_H],
    ];
    const footprint = new THREE.BufferGeometry().setFromPoints(c.map((p) => new THREE.Vector3(...p)));
    const lens = new THREE.Vector3(0, CAMERA.lensHeight - 0.003, 0);
    const frustum = new THREE.BufferGeometry().setFromPoints(c.flatMap((p) => [lens, new THREE.Vector3(...p)]));

    const grid: THREE.Vector3[] = [];
    const [x0, z0] = gantryToWorld(0, 0);
    const [x1, z1] = gantryToWorld(GANTRY.travelX, GANTRY.travelY);
    for (let x = 0; x <= GANTRY.travelX; x += 10) {
      const wx = gantryToWorld(x, 0)[0];
      grid.push(new THREE.Vector3(wx, 0.011, z0), new THREE.Vector3(wx, 0.011, z1));
    }
    for (let yv = 0; yv <= GANTRY.travelY; yv += 10) {
      const wz = gantryToWorld(0, yv)[1];
      grid.push(new THREE.Vector3(x0, 0.011, wz), new THREE.Vector3(x1, 0.011, wz));
    }
    const gridGeo = new THREE.BufferGeometry().setFromPoints(grid);

    const path = new THREE.BufferGeometry();
    path.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    const footMat = lineMat(TEAL, 0.6);
    const frustumMat = lineMat(TEAL, 0.25);

    return {
      footprint,
      frustum,
      gridGeo,
      path,
      footMat,
      frustumMat,
      tintFrustum: (hi: boolean) => {
        footMat.color.set(hi ? AMBER : TEAL);
        footMat.opacity = hi ? 0.95 : 0.6;
        frustumMat.color.set(hi ? AMBER : TEAL);
        frustumMat.opacity = hi ? 0.6 : 0.25;
      },
      gridMat: lineMat("#6f8a9a", 0.14),
      pathObj: new THREE.Line(path, lineMat(AMBER, 0.55)),
      ring: new THREE.RingGeometry(0.92, 1, 40),
      targetMat: new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, fog: false }),
      detMat: new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide, fog: false }),
    };
  }, []);

  const root = useRef<THREE.Group>(null);
  const carriage = useRef<THREE.Group>(null);
  const target = useRef<THREE.Mesh>(null);

  // HUD lives on layer 2: drawn by the main camera, never by the feed camera.
  useEffect(() => {
    root.current?.traverse((o) => o.layers.set(2));
  }, []);
  const pathLine = useRef<THREE.Line>(null);
  const rings = useRef<Array<THREE.Mesh | null>>([]);

  useFrame((state) => {
    const s = useSimStore.getState();
    const g = s.engine.gantry;
    const [wx, wz] = gantryToWorld(g.x.pos, g.y.pos);
    if (carriage.current) carriage.current.position.set(wx, 0, wz);

    // Scene 02 "camera" highlight: the frustum is the visible part of the camera, so tint it too.
    const camHi = s.highlight === "camera";
    res.tintFrustum(camHi);

    const auto = s.engine.mode === "TRACK" || s.engine.mode === "EPISODE" || s.engine.mode === "TEST" || s.engine.mode === "MISSION";
    const [tx, tz] = gantryToWorld(g.x.target, g.y.target);
    if (target.current) {
      target.current.visible = auto;
      target.current.position.set(tx, 0.012, tz);
      const k = 0.035 * (1 + 0.08 * Math.sin(state.clock.elapsedTime * 4));
      target.current.scale.set(k, k, 1);
    }
    if (pathLine.current) {
      pathLine.current.visible = g.moving;
      const a = pathLine.current.geometry.attributes.position as THREE.BufferAttribute;
      a.setXYZ(0, wx, 0.012, wz);
      a.setXYZ(1, tx, 0.012, tz);
      a.needsUpdate = true;
    }

    const det = s.engine.detections;
    const objs = s.engine.scenario.objects;
    for (let i = 0; i < MAX_RINGS; i++) {
      const m = rings.current[i];
      if (!m) continue;
      const d = det[i];
      const o = d && objs.find((ob) => ob.id === d.objectId);
      if (!o) {
        m.visible = false;
        continue;
      }
      m.visible = true;
      const [ox, oz] = gantryToWorld(o.x, o.y);
      m.position.set(ox, 0.012, oz);
      const k = Math.max(o.halfExtents[0], o.halfExtents[2]) * 1.1 * (0.7 + 0.4 * d.confidence);
      m.scale.set(k, k, 1);
    }
  });

  return (
    <group ref={root}>
      <group ref={carriage}>
        <lineLoop geometry={res.footprint} material={res.footMat} />
        <lineSegments geometry={res.frustum} material={res.frustumMat} />
      </group>
      <mesh ref={target} geometry={res.ring} material={res.targetMat} rotation={[-Math.PI / 2, 0, 0]} visible={false} />
      <primitive object={res.pathObj} ref={pathLine} visible={false} />
      {Array.from({ length: MAX_RINGS }, (_, i) => (
        <mesh
          key={i}
          ref={(el) => {
            rings.current[i] = el;
          }}
          geometry={res.ring}
          material={res.detMat}
          rotation={[-Math.PI / 2, 0, 0]}
          visible={false}
        />
      ))}
      <lineSegments geometry={res.gridGeo} material={res.gridMat} />
      <AxisLabel text="X" position={[gantryToWorld(GANTRY.travelX, 0)[0] + 0.035, 0.005, gantryToWorld(0, 0)[1]]} />
      <AxisLabel text="Y" position={[gantryToWorld(0, 0)[0], 0.005, gantryToWorld(0, GANTRY.travelY)[1] + 0.04]} />
    </group>
  );
}

const pv = new THREE.Vector3();

/** World point -> CSS px on the canvas. `behind` when the point is on the far side of the camera plane. */
function toScreen(p: THREE.Vector3, camera: THREE.Camera, width: number, height: number) {
  pv.copy(p).project(camera);
  return { x: ((pv.x + 1) / 2) * width, y: ((1 - pv.y) / 2) * height, behind: pv.z > 1 };
}

function inRect(x: number, y: number, r: { x0: number; y0: number; x1: number; y1: number }) {
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
}

/** Sand grid axis letter. Hidden when its anchor is behind the camera or outside the area the overlay leaves free. */
function AxisLabel({ text, position }: { text: string; position: [number, number, number] }) {
  const el = useRef<HTMLSpanElement>(null);
  const anchor = useMemo(() => new THREE.Vector3(...position), [position]);
  useFrame(({ camera, size }) => {
    const span = el.current;
    if (!span) return;
    const p = toScreen(anchor, camera, size.width, size.height);
    const show = !p.behind && inRect(p.x, p.y, freeRect(size.width, size.height));
    const v = show ? "" : "hidden";
    if (span.style.visibility !== v) span.style.visibility = v;
  });
  return (
    <Html position={position} zIndexRange={[0, 0]} style={{ pointerEvents: "none" }}>
      <span ref={el} className="label" style={{ color: "#6f8a9a", fontSize: 9 }}>
        {text}
      </span>
    </Html>
  );
}

/* ---------- scene 02 component callouts ---------- */

type Side = "l" | "r" | "u" | "d" | "ul" | "ur" | "dl" | "dr";
const D = Math.SQRT1_2;
const SIDE_DIR: Record<Side, [number, number]> = { l: [-1, 0], r: [1, 0], u: [0, -1], d: [0, 1], ul: [-D, -D], ur: [D, -D], dl: [-D, D], dr: [D, D] };
const SIDES = Object.keys(SIDE_DIR) as Side[];
const angleOf = ([x, y]: [number, number]) => Math.atan2(y, x);
/** Sides ordered by angular distance from the preferred one, so a blocked label slides around its anchor. */
function sidesFrom(prefer: Side): Side[] {
  const a0 = angleOf(SIDE_DIR[prefer]);
  const gap = (s: Side) => Math.abs(Math.atan2(Math.sin(angleOf(SIDE_DIR[s]) - a0), Math.cos(angleOf(SIDE_DIR[s]) - a0)));
  return [...SIDES].sort((a, b) => gap(a) - gap(b));
}
const SIDE_ORDER = Object.fromEntries(SIDES.map((s) => [s, sidesFrom(s)])) as Record<Side, Side[]>;
/** leader lengths tried, px from the anchor to the label edge */
const GAPS = [28, 52, 80];
const LABEL_MARGIN = 6;

/**
 * at: 3D anchor on the component's mesh; moving parts resolve it from the engine each frame.
 * prefer: the side of the anchor the label goes on when nothing is in the way. The placement runs per frame in
 * screen space: the first side and gap whose label rect stays inside the free area and clear of other labels,
 * their anchors and every test object wins. Ordered most constrained first, so the valve label is placed before
 * the ones with open space around them. `own` names the test object the callout points at: the leader then
 * starts from that object's screen rect instead of the anchor dot, so the label sits beside it, never on it.
 */
const CALLOUTS: Array<{ id: ComponentId; n: string; text: string; at: [number, number, number] | ((e: SimEngine, out: THREE.Vector3) => THREE.Vector3); prefer: Side; own?: ObjectType }> = [
  {
    id: "test-objects",
    n: "06",
    text: "TEST OBJECTS",
    at: (e, out) => {
      const w = e.scenario.objects.find((o) => o.type === "VALVE") ?? e.scenario.objects[0];
      const [x, z] = gantryToWorld(w.x, w.y);
      return out.set(x, w.z + w.halfExtents[1] * (1 - w.burial), z);
    },
    prefer: "d",
    own: "VALVE",
  },
  {
    id: "camera",
    n: "02",
    text: "CAMERA",
    at: (e, out) => {
      const [x, z] = gantryToWorld(e.gantry.x.pos, e.gantry.y.pos);
      return out.set(x, CAMERA.lensHeight + 0.05, z);
    },
    prefer: "l",
  },
  { id: "raspberry-pi", n: "04", text: "RASPBERRY PI", at: [PI_POS[0], PI_POS[1] + 0.03, PI_POS[2]], prefer: "u" },
  { id: "arduino", n: "05", text: "ARDUINO", at: [ARDUINO_POS[0], ARDUINO_POS[1] + 0.03, ARDUINO_POS[2]], prefer: "d" },
  { id: "gantry", n: "01", text: "GANTRY", at: [-0.6, GANTRY.railHeight + 0.02, -0.3], prefer: "ul" },
  { id: "aquarium", n: "03", text: "AQUARIUM", at: [-0.6, GANTRY.frameHeight, TANK.width / 2], prefer: "l" },
];

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const overlaps = (a: Rect, b: Rect, m: number) => a.x0 - m < b.x1 && a.x1 + m > b.x0 && a.y0 - m < b.y1 && a.y1 + m > b.y0;

function Callout({ id, n, text, register }: { id: ComponentId; n: string; text: string; register: (id: ComponentId, el: HTMLDivElement | null) => void }) {
  const active = useSimStore((s) => s.highlight === id);
  const setHighlight = useSimStore((s) => s.setHighlight);
  const line = active ? AMBER : "#4a6075";
  return (
    <Html zIndexRange={[0, 0]} style={{ pointerEvents: "none" }}>
      <div ref={(el) => register(id, el)} style={{ position: "relative", width: 0, height: 0 }}>
        <svg style={{ position: "absolute", left: 0, top: 0, width: 1, height: 1, overflow: "visible" }}>
          <circle cx={0} cy={0} r={2.5} fill={line} />
          <line x1={0} y1={0} x2={0} y2={0} stroke={line} strokeWidth={1} />
        </svg>
        <div
          onPointerEnter={() => setHighlight(id)}
          onPointerLeave={() => setHighlight(null)}
          className="panel label"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            transform: "translate(-50%, -50%)",
            pointerEvents: "auto",
            cursor: "default",
            display: "flex",
            gap: 8,
            alignItems: "baseline",
            padding: "4px 8px",
            whiteSpace: "nowrap",
            borderColor: active ? AMBER : undefined,
            color: active ? "#e6edf3" : undefined,
            transition: "border-color 120ms ease, color 120ms ease",
          }}
        >
          <span style={{ color: active ? AMBER : TEAL }}>{n}</span>
          {text}
        </div>
      </div>
    </Html>
  );
}

export function Callouts() {
  const scene = useSimStore((s) => s.scene);
  const nodes = useRef(new Map<ComponentId, HTMLDivElement>());
  const groups = useRef(new Map<ComponentId, THREE.Group>());
  const register = useCallback((id: ComponentId, el: HTMLDivElement | null) => {
    if (el) nodes.current.set(id, el);
    else nodes.current.delete(id);
  }, []);
  const tmp = useMemo(() => ({ v: new THREE.Vector3(), corner: new THREE.Vector3() }), []);

  useFrame(({ camera, size }) => {
    if (useSimStore.getState().scene !== 2) return;
    const e = useSimStore.getState().engine;
    const free = freeRect(size.width, size.height);

    // obstacles: every test object's projected box
    const obstacles: Rect[] = [];
    const byType = new Map<string, Rect>();
    for (const o of e.scenario.objects) {
      const [ox, oz] = gantryToWorld(o.x, o.y);
      const r = (o.rotation * Math.PI) / 180;
      const c = Math.cos(r);
      const sn = Math.sin(r);
      const box: Rect = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (const sx of [-1, 1])
        for (const sz of [-1, 1])
          for (const sy of [0, 1]) {
            const lx = sx * o.halfExtents[0];
            const lz = sz * o.halfExtents[2];
            tmp.corner.set(ox + lx * c - lz * sn, sy * (o.z + o.halfExtents[1] * (1 - o.burial)), oz + lx * sn + lz * c);
            const p = toScreen(tmp.corner, camera, size.width, size.height);
            if (p.behind) continue;
            box.x0 = Math.min(box.x0, p.x);
            box.x1 = Math.max(box.x1, p.x);
            box.y0 = Math.min(box.y0, p.y);
            box.y1 = Math.max(box.y1, p.y);
          }
      if (box.x0 < box.x1) {
        obstacles.push(box);
        if (!byType.has(o.type)) byType.set(o.type, box);
      }
    }

    // anchors first, so no label may cover another callout's anchor point
    const anchors = CALLOUTS.map((c) => {
      const g = groups.current.get(c.id);
      const at = typeof c.at === "function" ? c.at(e, tmp.v) : tmp.v.set(...c.at);
      if (g) g.position.copy(at);
      return toScreen(at, camera, size.width, size.height);
    });
    const placed: Rect[] = anchors.map((a) => ({ x0: a.x, y0: a.y, x1: a.x, y1: a.y }));

    CALLOUTS.forEach((c, i) => {
      const wrap = nodes.current.get(c.id);
      if (!wrap) return;
      const a = anchors[i];
      const show = !a.behind && inRect(a.x, a.y, free);
      const vis = show ? "" : "hidden";
      if (wrap.style.visibility !== vis) wrap.style.visibility = vis;
      if (!show) return;
      const label = wrap.lastElementChild as HTMLDivElement;
      const leader = wrap.querySelector("line") as SVGLineElement;
      const hw = label.offsetWidth / 2;
      const hh = label.offsetHeight / 2;
      const own = c.own ? byType.get(c.own) : undefined;
      let best: { cx: number; cy: number; ex: number; ey: number } | null = null;
      outer: for (const gap of GAPS) {
        for (const side of SIDE_ORDER[c.prefer]) {
          const [dx, dy] = SIDE_DIR[side];
          // the leader leaves the labelled object's rect, not the dot, so the label clears the object itself
          const s0 = own ? Math.min(dx ? (dx > 0 ? own.x1 - a.x : a.x - own.x0) / Math.abs(dx) : Infinity, dy ? (dy > 0 ? own.y1 - a.y : a.y - own.y0) / Math.abs(dy) : Infinity) : 0;
          // distance from the label centre to its edge along the leader direction
          const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
          const cx = a.x + dx * (s0 + gap + t);
          const cy = a.y + dy * (s0 + gap + t);
          const rect: Rect = { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh };
          if (rect.x0 < free.x0 || rect.x1 > free.x1 || rect.y0 < free.y0 || rect.y1 > free.y1) continue;
          if (placed.some((r, j) => j !== i && overlaps(rect, r, LABEL_MARGIN))) continue;
          if (obstacles.some((r) => overlaps(rect, r, LABEL_MARGIN))) continue;
          best = { cx, cy, ex: a.x + dx * (s0 + gap), ey: a.y + dy * (s0 + gap) };
          break outer;
        }
      }
      if (!best) {
        // nowhere clean: preferred side at the short gap, pulled inside the free area
        const [dx, dy] = SIDE_DIR[c.prefer];
        const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
        const cx = Math.min(free.x1 - hw, Math.max(free.x0 + hw, a.x + dx * (GAPS[0] + t)));
        const cy = Math.min(free.y1 - hh, Math.max(free.y0 + hh, a.y + dy * (GAPS[0] + t)));
        best = { cx, cy, ex: cx, ey: cy };
      }
      placed[i] = { x0: best.cx - hw, y0: best.cy - hh, x1: best.cx + hw, y1: best.cy + hh };
      const lx = `${(best.cx - a.x).toFixed(1)}px`;
      const ly = `${(best.cy - a.y).toFixed(1)}px`;
      if (label.style.left !== lx) label.style.left = lx;
      if (label.style.top !== ly) label.style.top = ly;
      leader.setAttribute("x2", (best.ex - a.x).toFixed(1));
      leader.setAttribute("y2", (best.ey - a.y).toFixed(1));
    });
  });

  if (scene !== 2) return null;
  return (
    <group>
      {CALLOUTS.map((c) => (
        <group
          key={c.id}
          ref={(g) => {
            if (g) groups.current.set(c.id, g);
            else groups.current.delete(c.id);
          }}
          position={typeof c.at === "function" ? undefined : c.at}
        >
          <Callout id={c.id} n={c.n} text={c.text} register={register} />
        </group>
      ))}
    </group>
  );
}

/* ---------- planned mission path: amber polyline through the plan waypoints, a dot per capture point ---------- */

const MAX_PLAN_POINTS = 80;

export function PlanPath() {
  const res = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_PLAN_POINTS * 3), 3));
    const dots = new THREE.InstancedMesh(new THREE.CircleGeometry(0.006, 16).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.9, depthWrite: false, fog: false }), MAX_PLAN_POINTS);
    dots.frustumCulled = false;
    const line = new THREE.Line(geo, lineMat(AMBER, 0.5));
    line.frustumCulled = false;
    const state: { shown: object | null } = { shown: null };
    const m = new THREE.Matrix4();
    /** Rebuilds the polyline and capture dots only when the plan object changes. */
    const sync = (plan: { waypoints: Array<{ x: number; y: number; capture: boolean }> } | null) => {
      if (plan === state.shown) return;
      state.shown = plan;
      const n = plan ? Math.min(plan.waypoints.length, MAX_PLAN_POINTS) : 0;
      const a = geo.attributes.position as THREE.BufferAttribute;
      let count = 0;
      for (let i = 0; i < n; i++) {
        const w = plan!.waypoints[i];
        const [x, z] = gantryToWorld(w.x, w.y);
        a.setXYZ(i, x, 0.013, z);
        if (w.capture) dots.setMatrixAt(count++, m.makeTranslation(x, 0.014, z));
      }
      a.needsUpdate = true;
      geo.setDrawRange(0, n);
      dots.count = count;
      dots.instanceMatrix.needsUpdate = true;
      line.visible = n > 1;
    };
    return { line, dots, sync };
  }, []);
  const root = useRef<THREE.Group>(null);
  useEffect(() => {
    root.current?.traverse((o) => o.layers.set(2));
  }, []);
  useFrame(() => res.sync(useSimStore.getState().engine.mission?.plan ?? null));
  return (
    <group ref={root}>
      <primitive object={res.line} />
      <primitive object={res.dots} />
    </group>
  );
}
