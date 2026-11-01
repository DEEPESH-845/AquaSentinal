"use client";

import clsx from "clsx";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useShallow } from "zustand/react/shallow";
import { CAMERA } from "@/lib/sim/constants";
import { FEED_ELEMENT_ID, useSimStore } from "@/lib/sim/store";
import type { Detection } from "@/lib/sim/types";
import { f1, isTargetClass, pct } from "./shared";

/** 10 px mono glyph advance plus the label's horizontal padding; only an estimate for the overlap check. */
const LABEL_CHAR_PX = 6.2;
const LABEL_PAD_PX = 8;

type FeedSize = { w: number; h: number };

const labelText = (d: Detection) => `SIM ${d.class} ${pct(d.confidence)}`;
// Label sits above the box unless the box touches the frame top; clamp right so it never leaves the feed.
const labelInside = (d: Detection, feed: FeedSize) => d.bbox[1] * feed.h < 14;
const labelRight = (d: Detection) => d.bbox[0] + d.bbox[2] > 0.72;

/** The label's rectangle in normalised feed coordinates, mirroring where BoundingBoxes places it. */
function labelRect(d: Detection, feed: FeedSize): [number, number, number, number] {
  const [u, v, w] = d.bbox;
  const lw = (labelText(d).length * LABEL_CHAR_PX + LABEL_PAD_PX) / feed.w;
  const x0 = labelRight(d) ? u + w - lw : u;
  const y0 = labelInside(d, feed) ? v + (labelRight(d) ? 20 : 2) / feed.h : v - 16 / feed.h;
  return [x0, y0, x0 + lw, y0 + 14 / feed.h];
}

/** Anomaly candidates and unknowns get a label; the most confident label wins when two would overlap. */
function labelledIds(detections: Detection[], feed: FeedSize): Set<string> {
  const placed: Array<[number, number, number, number]> = [];
  const ids = new Set<string>();
  for (const d of [...detections].sort((a, b) => b.confidence - a.confidence)) {
    if (!isTargetClass(d.class) && d.class !== "UNKNOWN") continue;
    const r = labelRect(d, feed);
    if (placed.some((q) => r[0] < q[2] && q[0] < r[2] && r[1] < q[3] && q[1] < r[3])) continue;
    placed.push(r);
    ids.add(d.objectId);
  }
  return ids;
}

/**
 * Camera feed frame. The body is fully transparent: the 3D renderer paints the gantry
 * camera view into the #gantry-camera-feed rectangle on the WebGL canvas underneath.
 * Only the header has a background; the body is a 1 px border plus DOM overlays.
 */
export function CameraFeed() {
  const { frame, x, y } = useSimStore(useShallow((s) => ({ frame: s.telemetry.camera.frame, x: s.telemetry.gantry.x, y: s.telemetry.gantry.y })));
  const m = useSimStore(useShallow((s) => (s.mission && s.mode === "MISSION" ? { online: s.mission.cameraOnline, perception: s.mission.perception } : null)));
  // the 300 px column has no room for the resolution beside the tag; the wide Perception column does
  const wide = useSimStore((s) => s.scene === 3);

  return (
    <div className="panel border-line-strong">
      <div className="flex items-center justify-between gap-2 border-b border-line px-2.5 py-1.5">
        <div className="flex items-center gap-2 whitespace-nowrap">
          <span className="label text-text">Camera feed</span>
          <span className="sim-tag">DIGITAL TWIN</span>
        </div>
        <span className="value whitespace-nowrap text-[9px] text-muted max-[999px]:hidden">
          {CAMERA.fps} FPS f{frame}
          {wide && ` ${CAMERA.resolution.replace(" (simulated)", "")}`}
        </span>
        {/* compact column: the readout moves up here so it cannot collide with box tags in a 176 or 220 px feed */}
        <span className="value whitespace-nowrap text-[10px] text-teal min-[1000px]:hidden">
          X {f1(x)}&nbsp;&nbsp;Y {f1(y)}
        </span>
      </div>

      {/* The render is inset in the opaque panel so the feed reads as an instrument, not a hole into the 3D room. */}
      <div className="p-1.5">
        <div id={FEED_ELEMENT_ID} className="relative w-full overflow-hidden border border-line" style={{ aspectRatio: "4 / 3", background: "transparent" }}>
          {/* a shade darker than the lab view, plus lens fall-off, so the inset reads as a camera, not a viewport */}
          <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(ellipse at center, rgba(0,0,0,0.22) 50%, rgba(0,0,0,0.55) 100%)" }} />
          {/* crosshair */}
          <div className="pointer-events-none absolute left-1/2 top-1/2 h-4 w-px -translate-x-1/2 -translate-y-1/2 bg-teal/70" />
          <div className="pointer-events-none absolute left-1/2 top-1/2 h-px w-4 -translate-x-1/2 -translate-y-1/2 bg-teal/70" />
          {/* frame corners */}
          <div className="pointer-events-none absolute left-1 top-1 h-2 w-2 border-l border-t border-line-strong" />
          <div className="pointer-events-none absolute right-1 top-1 h-2 w-2 border-r border-t border-line-strong" />
          <div className="pointer-events-none absolute bottom-1 left-1 h-2 w-2 border-b border-l border-line-strong" />
          <div className="pointer-events-none absolute bottom-1 right-1 h-2 w-2 border-b border-r border-line-strong" />
          {/* position readout */}
          <div className="value pointer-events-none absolute bottom-1.5 left-2 bg-ground/70 px-1 text-[10px] text-teal max-[999px]:hidden">
            X {f1(x)}&nbsp;&nbsp;Y {f1(y)} cm
          </div>
          <div className="label pointer-events-none absolute right-2 top-1.5 bg-ground/70 px-1 text-[9px]">{m ? m.perception.split("_")[0] : "CAM D"}</div>
          <BoundingBoxes />
          {m && !m.online && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-ground" role="status">
              <span className="value text-[12px] tracking-[0.2em] text-danger">NO SIGNAL</span>
              <span className="label mt-1 text-[9px]">camera offline (scripted dropout)</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Memoised so the 20 Hz frame counter in the header does not re-render six animated boxes.
const BoundingBoxes = memo(function BoundingBoxes() {
  const detections = useSimStore((s) => s.detections);
  const ref = useRef<HTMLDivElement>(null);
  const [feed, setFeed] = useState<FeedSize>({ w: 220, h: 165 });
  useEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setFeed({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const labelled = useMemo(() => labelledIds(detections, feed), [detections, feed]);
  return (
    <div ref={ref} className="pointer-events-none absolute inset-0">
      <AnimatePresence>
        {detections.map((d) => {
          const target = isTargetClass(d.class);
          // LOCKED corners are solid, DETECTED ones dimmer; the state needs no text of its own
          const color = clsx(target ? "border-amber" : "border-teal", d.state !== "LOCKED" && "opacity-50");
          const [u, v, w, h] = d.bbox;
          return (
            <motion.div
              key={d.objectId}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute"
              style={{ left: `${u * 100}%`, top: `${v * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` }}
            >
              <span className={clsx("absolute -left-px -top-px h-2.5 w-2.5 border-l border-t", color)} />
              <span className={clsx("absolute -right-px -top-px h-2.5 w-2.5 border-r border-t", color)} />
              <span className={clsx("absolute -bottom-px -left-px h-2.5 w-2.5 border-b border-l", color)} />
              <span className={clsx("absolute -bottom-px -right-px h-2.5 w-2.5 border-b border-r", color)} />
              {labelled.has(d.objectId) && (
                <div
                  className={clsx(
                    "value absolute whitespace-nowrap bg-ground/70 px-1 py-px text-[10px] leading-none",
                    labelInside(d, feed) ? (labelRight(d) ? "top-5" : "top-0.5") : "-top-4",
                    labelRight(d) ? "right-0" : "left-0",
                    target ? "text-amber" : "text-teal",
                  )}
                >
                  {labelText(d)}
                </div>
              )}
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
});
