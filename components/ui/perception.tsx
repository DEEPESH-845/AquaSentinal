"use client";

import clsx from "clsx";
import { Camera } from "lucide-react";
import { useState } from "react";
import type { Segmentation } from "@/lib/api/types";
import { CAMERA } from "@/lib/sim/constants";
import { useSimStore } from "@/lib/sim/store";
import { useMissionStore, type CaptureView } from "@/lib/store/mission";
import { Btn, CardHead, Chip, SourceTag, f1, f2, human, isTargetClass, pct, providerSource } from "./shared";

const W = CAMERA.captureWidth;
const H = CAMERA.captureHeight;

type StageState = "done" | "fail" | "skip" | "wait";

function stages(c: CaptureView | undefined): Array<[string, StageState, string]> {
  if (!c) return [];
  const r = c.result;
  const seg = r?.segmentations ?? [];
  const sending = c.status === "SENDING";
  const segState: StageState = sending ? "wait" : !r ? "fail" : seg.length === 0 ? "skip" : seg.every((s) => s.status === "FAILED") ? "fail" : "done";
  return [
    ["Frame", "done", "640 x 480 from the twin camera"],
    ["Quality", r?.quality ? "done" : sending ? "wait" : "fail", "OpenCV contrast, sharpness, colour"],
    ["Reasoning", r?.reasoning?.provider === "MUSE_SPARK" ? "done" : sending ? "wait" : "skip", "Muse Spark names what to segment"],
    ["Segment", segState, seg[0]?.provider === "SAM_3_1" ? "SAM 3.1 masks" : "offline fixture masks"],
    ["Track", r ? (r.observations.length ? "done" : "skip") : sending ? "wait" : "fail", "association by position and label"],
    ["Evidence", r ? "done" : sending ? "wait" : "fail", "frame and records stored"],
  ];
}

const STAGE_TONE: Record<StageState, string> = { done: "border-teal text-teal", fail: "border-danger text-danger", skip: "border-line text-dim", wait: "border-amber text-amber animate-pulse motion-reduce:animate-none" };

/** Frame plus overlays drawn in frame pixel space, so they scale with the image. */
function FrameView({ c, showMasks, showSim }: { c: CaptureView; showMasks: boolean; showSim: boolean }) {
  const segs = c.result?.segmentations ?? [];
  return (
    <div className="relative w-full border border-line" style={{ aspectRatio: `${W} / ${H}` }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={c.frameUrl} alt={`Inspection frame ${c.seq}`} className="absolute inset-0 h-full w-full" />
      <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full" aria-hidden>
        {showMasks &&
          segs.flatMap((s) =>
            s.instances.map((inst) => {
              const amber = isTargetClass(inst.targetClass ?? "");
              const color = amber ? "#f2a93b" : "#3db9b0";
              const [x0, y0] = inst.box;
              return (
                <g key={inst.instanceId}>
                  {inst.polygons.map((poly, i) => (
                    <polygon key={i} points={poly.map(([x, y]) => `${x},${y}`).join(" ")} fill={color} fillOpacity={s.provider === "SAM_3_1" ? 0.32 : 0.18} stroke={color} strokeWidth={2} strokeDasharray={s.provider === "SAM_3_1" ? undefined : "6 4"} />
                  ))}
                  <text x={x0 + 2} y={Math.max(14, y0 - 6)} fill={color} fontSize={15} fontFamily="var(--font-plex-mono)" paintOrder="stroke" stroke="#0b1219" strokeWidth={3}>
                    {inst.prompt}
                    {inst.confidence !== null ? ` ${(inst.confidence * 100).toFixed(0)}%` : ""}
                  </text>
                </g>
              );
            }),
          )}
        {showSim &&
          c.request.detections.map((d) => {
            const [u, v, w, h] = d.bbox;
            return (
              <g key={d.objectId}>
                <rect x={u * W} y={v * H} width={w * W} height={h * H} fill="none" stroke="#e6edf3" strokeOpacity={0.75} strokeWidth={1.5} strokeDasharray="3 3" />
                <text x={u * W + 2} y={(v + h) * H + 14} fill="#e6edf3" fontSize={12} fontFamily="var(--font-plex-mono)" paintOrder="stroke" stroke="#0b1219" strokeWidth={3}>
                  SIM {d.class} {(d.confidence * 100).toFixed(0)}%
                </text>
              </g>
            );
          })}
      </svg>
      <div className="value absolute left-1.5 top-1.5 bg-ground/75 px-1 text-[10px] text-muted">
        #{c.seq} {c.request.reason} X {f1(c.request.gantryX)} Y {f1(c.request.gantryY)}
      </div>
    </div>
  );
}

function SegRow({ s }: { s: Segmentation }) {
  const ious = s.instances.map((i) => i.iou).filter((x): x is number => x !== null);
  return (
    <div className="grid grid-cols-[1fr_auto] items-baseline gap-x-2 border-b border-line py-[3px]">
      <span className="min-w-0">
        <span className="value text-[11px] text-text">&quot;{s.prompt}&quot;</span>
        <span className={clsx("label ml-2 text-[9px]", s.status === "OK" ? "text-teal" : s.status === "FAILED" ? "text-danger" : "text-dim")}>{s.status}</span>
        {s.error && <span className="block text-[10px] leading-snug text-danger/90">{s.error}</span>}
      </span>
      <span className="value whitespace-nowrap text-right text-[10px] text-muted">
        {s.instances.length} mask{s.instances.length === 1 ? "" : "s"}
        {s.latencyMs !== null && ` ${Math.round(s.latencyMs)} ms`}
        {ious.length > 0 && ` IoU ${f2(ious.reduce((a, b) => a + b, 0) / ious.length)}`}
      </span>
    </div>
  );
}

export function PerceptionCard() {
  const captures = useMissionStore((s) => s.captures);
  const selected = useMissionStore((s) => s.selectedCapture);
  const selectCapture = useMissionStore((s) => s.selectCapture);
  const backend = useMissionStore((s) => s.backend);
  const samLive = useMissionStore((s) => s.system?.providers.sam.status === "LIVE");
  const estop = useSimStore((s) => s.telemetry.estop);
  const [showMasks, setShowMasks] = useState(true);
  const [showSim, setShowSim] = useState(false);
  const c = captures.find((x) => x.seq === selected) ?? captures[captures.length - 1];
  const r = c?.result;
  const segProvider = r?.segmentations[0]?.provider;

  return (
    <div>
      <CardHead
        title="AI perception"
        note={
          samLive
            ? "Each capture: image quality with OpenCV, Muse Spark names what to look for, SAM 3.1 segments it, masks become tracked observations."
            : "SAM 3.1 needs MODEL_API_KEY on the backend. Offline, observations come from the simulated detector and the outlines are the twin's own geometry, labelled as such."
        }
        right={
          <Btn onClick={() => useSimStore.getState().engine.requestCapture()} disabled={estop} title="Capture a frame at the current position">
            <Camera size={14} /> Capture
          </Btn>
        }
      />
      {!c ? (
        <p className="border-t border-line pt-2 text-[12px] text-muted">No frames yet. Capture one here, or run a mission: it captures at every planned waypoint.</p>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-1">
            {stages(c).map(([name, st, hint], i, all) => (
              <div key={name} className="flex items-center gap-1" title={hint}>
                <span className={clsx("border px-1.5 py-[2px] font-mono text-[10px] tracking-[0.1em] uppercase", STAGE_TONE[st])}>{name}</span>
                {i < all.length - 1 && <span className="font-mono text-[10px] text-dim">-&gt;</span>}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 max-[759px]:grid-cols-1">
            <div>
              <FrameView c={c} showMasks={showMasks} showSim={showSim} />
              <div className="mt-1 flex flex-wrap items-center gap-1">
                <Chip tone="teal" active={showMasks} onClick={() => setShowMasks((v) => !v)}>
                  {segProvider === "SAM_3_1" ? "SAM masks" : "Fixture masks"}
                </Chip>
                <Chip tone="neutral" active={showSim} onClick={() => setShowSim((v) => !v)}>
                  Sim detector boxes
                </Chip>
                {segProvider && <SourceTag source={providerSource(segProvider)} className="ml-auto" />}
              </div>
              {captures.length > 1 && (
                <div className="mt-1.5 flex gap-1 overflow-x-auto pb-1" role="listbox" aria-label="Captures">
                  {captures.map((x) => (
                    <button
                      key={x.seq}
                      type="button"
                      role="option"
                      aria-selected={x.seq === c.seq}
                      onClick={() => selectCapture(x.seq)}
                      className={clsx("value shrink-0 border px-1.5 py-[2px] text-[10px]", x.seq === c.seq ? "border-teal text-teal" : x.status === "FAILED" ? "border-danger/60 text-danger" : "border-line text-muted hover:text-text")}
                    >
                      #{x.seq}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="min-w-0 space-y-2">
              {c.status === "SENDING" && <p className="text-[12px] text-amber">Analysing frame...</p>}
              {c.status === "NOT_SENT" && <p className="text-[12px] text-amber">{c.error ?? (backend === "OFFLINE" ? "Backend offline." : "")}</p>}
              {c.status === "FAILED" && <p className="text-[12px] text-danger">Capture failed: {c.error}</p>}
              {r?.quality && (
                <div>
                  <div className="mb-0.5 flex items-center justify-between">
                    <span className="label text-dim">Image quality</span>
                    <SourceTag source="IMAGE_DERIVED" />
                  </div>
                  <div className="grid grid-cols-[auto_1fr_auto_1fr] gap-x-3 gap-y-[2px]">
                    <span className="label">Visibility</span>
                    <span className={clsx("value text-[11px]", r.quality.band === "GOOD" ? "text-teal" : r.quality.band === "DEGRADED" ? "text-amber" : "text-danger")}>
                      {pct(r.quality.visibilityEstimate, 0)} {r.quality.band}
                    </span>
                    <span className="label">Contrast</span>
                    <span className="value text-[11px] text-text">{f2(r.quality.contrast)}</span>
                    <span className="label">Sharpness</span>
                    <span className="value text-[11px] text-text">{Math.round(r.quality.sharpness)}</span>
                    <span className="label">Twin vis.</span>
                    <span className="value text-[11px] text-muted">{pct(c.request.visibility, 0)} sim</span>
                  </div>
                </div>
              )}
              {r?.reasoning && (
                <div>
                  <div className="mb-0.5 flex items-center justify-between">
                    <span className="label text-dim">Frame reasoning</span>
                    <SourceTag source={r.reasoning.provider === "MUSE_SPARK" ? "MUSE_SPARK" : "OFFLINE"} />
                  </div>
                  {r.reasoning.sceneSummary && <p className="text-[11px] leading-snug text-muted">{r.reasoning.sceneSummary}</p>}
                  {r.reasoning.error && <p className="text-[11px] leading-snug text-dim">{r.reasoning.provider === "UNAVAILABLE" && !r.reasoning.phrases.length ? "Not run: " : "Fell back: "}{r.reasoning.error}</p>}
                </div>
              )}
              {r && r.segmentations.length > 0 && (
                <div>
                  <div className="label mb-0.5 text-dim">Segmentation requests</div>
                  {r.segmentations.map((s) => (
                    <SegRow key={s.id} s={s} />
                  ))}
                </div>
              )}
              {r && (
                <div>
                  <div className="label mb-0.5 text-dim">Observations ({r.observations.length})</div>
                  {r.observations.length === 0 && <p className="text-[11px] text-dim">None from this frame.</p>}
                  {r.observations.slice(0, 6).map((o) => (
                    <div key={o.id} className="grid grid-cols-[1fr_auto] gap-x-2 text-[11px]">
                      <span className={clsx("value truncate", isTargetClass(o.label) ? "text-amber" : "text-text")}>
                        {human(o.label)} <span className="text-dim">{o.assetId.slice(-6)}</span>
                      </span>
                      <span className="value whitespace-nowrap text-muted">
                        ({f1(o.x)}, {f1(o.y)}) {o.confidence !== null ? `${pct(o.confidence, 0)} ${o.confidenceSource === "SAM_3_1" ? "SAM" : "sim"}` : "no conf."}
                      </span>
                    </div>
                  ))}
                  {r.notes.map((n) => (
                    <p key={n} className="text-[10px] leading-snug text-dim">
                      {n}
                    </p>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
