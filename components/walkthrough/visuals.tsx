"use client";

import clsx from "clsx";
import type { CSSProperties } from "react";
import { GANTRY } from "@/lib/sim/constants";
import type { MissionPlan, MissionResult, TestObject } from "@/lib/sim/types";
import { C } from "@/lib/theme";

const isTarget = (t: string) => t === "LOOSE_CABLE" || t === "FOREIGN_OBJECT";
const human = (s: string) => s.toLowerCase().replace(/_/g, " ");
const pct = (n: number) => `${Math.round(n * 100)}%`;

/* ---------------------------------------------------------------- 03 data flow */

export interface FlowStep {
  id: string;
  title: string;
  tag: string;
  body: string;
  detail: string;
}

/** VOICE -> MUSE SPARK -> MISSION PLAN -> INSPECTION. Nodes and links are animated by the page via data-node / data-link. */
export function Flow({ steps }: { steps: FlowStep[] }) {
  return (
    <ol className="flex flex-col">
      {steps.map((s, i) => (
        <li key={s.id} className="flex flex-col">
          <div data-node className="panel grid grid-cols-[28px_1fr] gap-x-3 px-4 py-3">
            <span className="value pt-0.5 text-[11px] text-teal">{String(i + 1).padStart(2, "0")}</span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-mono text-[13px] tracking-[0.16em] text-text">{s.title}</span>
                <span className="sim-tag">{s.tag}</span>
              </div>
              <p className="mt-1 text-[13px] leading-snug text-muted">{s.body}</p>
              <p className="value mt-1.5 text-[11px] leading-snug text-dim">{s.detail}</p>
            </div>
          </div>
          {i < steps.length - 1 && (
            <div className="relative ml-[29px] h-6 w-px bg-line" aria-hidden>
              <span data-link className="absolute inset-0 origin-top bg-teal" />
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

/* ---------------------------------------------------------------- 04 frame wipe */

export interface FrameObjects {
  frame: string;
  gantryX: number;
  gantryY: number;
  turbidity: number;
  visibility: number;
  objects: Array<{ objectId: string; type: string; box: [number, number, number, number] }>;
}

/**
 * A twin capture and the outlines of the twin's own object-id render, revealed by a wipe. `--wipe` (0..100) is
 * set by the scroll timeline or the range input. The outlines are geometry, not a model output, and say so.
 */
export function FrameWipe({ meta, wipe, onWipe }: { meta: FrameObjects | null; wipe: number; onWipe: (v: number) => void }) {
  return (
    <figure className="m-0">
      <div data-wipe className="relative aspect-[4/3] w-full overflow-hidden border border-line-strong bg-ground" style={{ "--wipe": `${wipe}%` } as CSSProperties}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/walkthrough/clear-x37.jpg" alt="Twin camera frame over the pipeline at gantry X 37 cm, Y 20 cm" className="absolute inset-0 h-full w-full" />
        <div className="absolute inset-0" style={{ clipPath: "inset(0 0 0 var(--wipe))" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/walkthrough/clear-x37.jpg" alt="" className="absolute inset-0 h-full w-full brightness-[0.55] saturate-[0.6]" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/walkthrough/clear-x37-outlines.png" alt="" className="absolute inset-0 h-full w-full" />
          {meta && (
            <svg viewBox="0 0 640 480" className="absolute inset-0 h-full w-full" aria-hidden>
              {meta.objects
                .filter((o) => o.type !== "PIPE_SEGMENT")
                .map((o) => (
                  <text key={o.objectId} x={o.box[0] > 520 ? o.box[2] - 4 : o.box[0] + 4} textAnchor={o.box[0] > 520 ? "end" : "start"} y={Math.max(16, o.box[1] - 6)} fill={isTarget(o.type) ? C.amber : C.teal} fontSize={14} fontFamily="var(--font-plex-mono)" paintOrder="stroke" stroke={C.ground} strokeWidth={4}>
                    {human(o.type)}
                  </text>
                ))}
            </svg>
          )}
        </div>
        <div className="pointer-events-none absolute inset-y-0 w-px bg-teal shadow-[0_0_12px_rgba(66,214,197,0.6)]" style={{ left: "var(--wipe)" }} />
        <span className="value absolute left-2 top-2 bg-ground/80 px-1.5 py-0.5 text-[10px] text-text">RAW FRAME</span>
        <span className="value absolute right-2 top-2 bg-ground/80 px-1.5 py-0.5 text-[10px] text-teal">OUTLINES</span>
      </div>
      <label className="mt-2 flex items-center gap-3">
        <span className="label shrink-0">Compare</span>
        <input type="range" min={0} max={100} step={1} value={Math.round(wipe)} onChange={(e) => onWipe(Number(e.target.value))} aria-label="Wipe between the raw frame and the outlines" />
      </label>
      <figcaption className="mt-2 flex flex-wrap items-center gap-2 text-[12px] leading-snug text-muted">
        <span className="sim-tag">TWIN GEOMETRY, NOT A MODEL</span>
        {meta && (
          <span className="value text-[11px] text-dim">
            frame {meta.frame}, gantry ({meta.gantryX.toFixed(1)}, {meta.gantryY.toFixed(1)}) cm, turbidity {meta.turbidity.toFixed(2)}
          </span>
        )}
      </figcaption>
    </figure>
  );
}

/* ---------------------------------------------------------------- 06 trajectory + metrics */

const MAP_W = 400;
const MAP_H = (MAP_W * GANTRY.travelY) / GANTRY.travelX;

/** Plan view in gantry cm. The path is drawn by the page through stroke-dashoffset on [data-path]. */
export function Trajectory({ plan, objects }: { plan: MissionPlan; objects: TestObject[] }) {
  const sx = (x: number) => (x / GANTRY.travelX) * MAP_W;
  const sy = (y: number) => (y / GANTRY.travelY) * MAP_H;
  const r = plan.region;
  return (
    <svg viewBox={`-8 -8 ${MAP_W + 16} ${MAP_H + 16}`} className="w-full border border-line-strong bg-ground/70" role="img" aria-label={`Plan view: ${plan.waypoints.length} waypoints over the inspection region, ${objects.length} objects`}>
      <defs>
        <pattern id="wt-grid" width={MAP_W / 10} height={MAP_H / 4} patternUnits="userSpaceOnUse">
          <path d={`M ${MAP_W / 10} 0 L 0 0 0 ${MAP_H / 4}`} fill="none" stroke={C.line} strokeWidth={1} />
        </pattern>
      </defs>
      <rect width={MAP_W} height={MAP_H} fill="url(#wt-grid)" stroke={C.lineStrong} />
      <rect x={sx(r.xMin)} y={sy(r.yMin)} width={sx(r.xMax - r.xMin)} height={sy(r.yMax - r.yMin)} fill={C.teal} fillOpacity={0.04} stroke={C.teal} strokeOpacity={0.4} strokeDasharray="4 4" />
      {objects.map((o) => (
        <rect key={o.id} x={sx(o.x) - 4} y={sy(o.y) - 4} width={8} height={8} fill="none" stroke={isTarget(o.type) ? C.amber : C.muted} strokeWidth={1.4}>
          <title>{o.label}</title>
        </rect>
      ))}
      <polyline data-path points={plan.waypoints.map((w) => `${sx(w.x)},${sy(w.y)}`).join(" ")} fill="none" stroke={C.teal} strokeWidth={2} pathLength={1} strokeDasharray="1" />
      {plan.waypoints.map((w, i) => (
        <circle key={i} cx={sx(w.x)} cy={sy(w.y)} r={4} fill={C.ground} stroke={C.teal} strokeWidth={1.5} />
      ))}
    </svg>
  );
}

const ROWS: Array<[string, (r: MissionResult) => string, "higher" | "lower" | null]> = [
  ["Outcome", (r) => human(r.outcome), null],
  ["Targets confirmed", (r) => String(r.confirmedTargets), "higher"],
  ["False positives", (r) => String(r.falsePositives), "lower"],
  ["Unreliable frames", (r) => String(r.unreliableCaptures), "lower"],
  ["Pauses", (r) => String(r.pauses), null],
  ["Captures", (r) => String(r.captures), null],
  ["Coverage", (r) => pct(r.coverage), null],
  ["Duration", (r) => `${r.durationS.toFixed(1)} s`, null],
];

export function CompareTable({ adaptive, fixed }: { adaptive: MissionResult; fixed: MissionResult }) {
  return (
    <div className="panel grid grid-cols-[1fr_auto_auto] gap-y-1 px-4 py-3">
      <span className="label text-dim">Same plan, same seed</span>
      <span className="label pl-5 text-right text-teal">Adaptive</span>
      <span className="label pl-5 text-right">Fixed speed</span>
      {ROWS.map(([k, fmt, better]) => {
        const a = fmt(adaptive);
        const f = fmt(fixed);
        const win = better === "higher" ? parseFloat(a) > parseFloat(f) : better === "lower" ? parseFloat(a) < parseFloat(f) : false;
        return (
          <div key={k} className="contents">
            <span className="label border-t border-line pt-1">{k}</span>
            <span className={clsx("value border-t border-line pl-5 pt-1 text-right text-[13px]", win ? "text-teal" : "text-text")}>{a}</span>
            <span className="value border-t border-line pl-5 pt-1 text-right text-[13px] text-text">{f}</span>
          </div>
        );
      })}
    </div>
  );
}
