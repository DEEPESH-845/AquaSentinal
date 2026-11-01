"use client";

import { useEffect } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { useSimStore, type ComponentId } from "@/lib/sim/store";

/** Scene 02 highlight tint. Teal, restrained. */
export const HIGHLIGHT_COLOR = new THREE.Color("#3db9b0");
export const AMBER = "#f2a93b";
export const TEAL = "#3db9b0";

type Emissive = THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;

/**
 * Boosts the emissive of a component's materials while it is the highlighted component.
 * Materials must be owned by that component (not shared across components).
 */
export function useHighlight(id: ComponentId, materials: Emissive[], intensity = 0.18): void {
  const active = useSimStore((s) => s.highlight === id);
  useEffect(() => setEmissive(materials, active ? HIGHLIGHT_COLOR : null, intensity), [active, materials, intensity]);
}

const BLACK = new THREE.Color(0, 0, 0);

/** Tint a material set, or clear the tint when colour is null. */
export function setEmissive(materials: Emissive[], color: THREE.Color | null, intensity: number): void {
  for (const m of materials) {
    m.emissive.copy(color ?? BLACK);
    m.emissiveIntensity = color ? intensity : 1;
  }
}

/** Merge several transformed geometries into one, for static parts that share a material. */
export function mergeBoxes(parts: Array<{ size: [number, number, number]; at: [number, number, number]; rot?: [number, number, number] }>) {
  const geoms = parts.map((p) => {
    const g = new THREE.BoxGeometry(...p.size);
    if (p.rot) g.rotateX(p.rot[0]).rotateY(p.rot[1]).rotateZ(p.rot[2]);
    return g.translate(...p.at);
  });
  const merged = mergeGeometries(geoms, false);
  for (const g of geoms) g.dispose();
  return merged;
}

export const std = (opts: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(opts);

/** Screen rect (CSS px) the DOM overlay leaves free for the 3D subject. */
export interface FreeRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const GAP = 12;
/** Desktop layout fallback for when the overlay is not in the DOM (first frame, headless). */
const FALLBACK = { left: 130, top: 56, column: 320, card: 330 };

let measured: FreeRect | null = null;

const rectOf = (name: string) => document.querySelector(`[data-lab="${name}"]`)?.getBoundingClientRect() ?? null;

/**
 * Reads the overlay's real boxes (components/ui/LabUI.tsx tags them with data-lab): header, scene nav, right column
 * and bottom card. On the desktop layout the nav is a vertical rail and the column runs down the right; on the
 * compact layout the nav is a horizontal strip above the card and only the camera feed sits top right, so the free
 * band lies between the feed and the strip. Called by the observer below, never per frame.
 */
export function measureFreeRect(): FreeRect | null {
  if (typeof document === "undefined") return null;
  const header = rectOf("header");
  const nav = rectOf("nav");
  const column = rectOf("column");
  const card = rectOf("card");
  if (!header || !nav || !column || !card) return null;
  const W = window.innerWidth;
  const compact = nav.width > nav.height;
  return compact
    ? { x0: GAP, y0: column.bottom + GAP, x1: W - GAP, y1: nav.top - GAP }
    : { x0: nav.right + GAP, y0: header.bottom + GAP, x1: column.left - GAP, y1: card.top - GAP };
}

/** Re-measures now (one layout read). The camera rig calls this before every fit so the first frame is right. */
export function refreshFreeRect(): void {
  measured = measureFreeRect() ?? measured;
}

/** Cached free rect for this canvas size; refreshed by observeOverlay. Safe to call every frame. */
export function freeRect(width: number, height: number): FreeRect {
  if (measured && measured.x1 - measured.x0 > 40 && measured.y1 - measured.y0 > 40) return measured;
  return { x0: FALLBACK.left, y0: FALLBACK.top, x1: width - FALLBACK.column, y1: height - FALLBACK.card };
}

/**
 * Keeps the cached free rect current and calls back when it changed materially (a scene card of a different
 * height, a resize, the compact layout kicking in). Small content changes inside a card are ignored so the
 * camera does not creep while a scan fills the Vision card. Returns a disposer.
 */
export function observeOverlay(onChange: (r: FreeRect) => void, threshold = 80): () => void {
  // Compared against the last rect that was notified, not the previous sample, so a width animated over
  // many small frames (the VISION column growing 300 to 440 px) still crosses the threshold.
  let notified: FreeRect | null = null;
  let settle = 0;
  const differs = (a: FreeRect, b: FreeRect, by: number) => Math.abs(a.x0 - b.x0) > by || Math.abs(a.x1 - b.x1) > by || Math.abs(a.y0 - b.y0) > by || Math.abs(a.y1 - b.y1) > by;
  const update = () => {
    const r = measureFreeRect();
    if (!r) return;
    measured = r;
    if (!notified || differs(notified, r, threshold)) {
      notified = r;
      onChange(r);
      // The change fires part-way through an animated layout (the column growing), so the pose would depend on frame timing.
      // One trailing look after the animation ends makes the final pose a function of the final layout only.
      clearTimeout(settle);
      settle = window.setTimeout(() => {
        const m = measureFreeRect();
        if (!m || !notified || !differs(notified, m, 4)) return;
        measured = m;
        notified = m;
        onChange(m);
      }, 500);
    }
  };
  const ro = new ResizeObserver(update);
  let raf = 0;
  // The overlay is a sibling React tree of the canvas; poll a frame at a time until its elements exist.
  const attach = () => {
    const els = ["header", "nav", "column", "card"].map((name) => document.querySelector(`[data-lab="${name}"]`));
    if (els.some((el) => !el)) {
      raf = requestAnimationFrame(attach);
      return;
    }
    for (const el of els) ro.observe(el!);
    update();
  };
  attach();
  window.addEventListener("resize", update);
  return () => {
    cancelAnimationFrame(raf);
    clearTimeout(settle);
    ro.disconnect();
    window.removeEventListener("resize", update);
  };
}
