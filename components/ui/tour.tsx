"use client";

import clsx from "clsx";
import { ArrowLeft, ArrowRight, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { gsap } from "@/lib/animations/gsap";
import { DUR, EASE, prefersReducedMotion } from "@/lib/animations/motion";
import { useSimStore, type SceneId } from "@/lib/sim/store";
import { useMissionStore } from "@/lib/store/mission";
import { Btn } from "./shared";

type StepStatus = { done: boolean; text: string } | null;

interface Step {
  title: string;
  body: string;
  scene: SceneId;
  /** CSS selector of the element to spotlight; none centres the popover over the tank */
  target?: string;
  /** what the operator has actually done for this step, read from the stores; null for explanation-only steps */
  status?: () => StepStatus;
}

const ms = () => useMissionStore.getState();
const ss = () => useSimStore.getState();
let baselineTurbidity = 0;

/** Nine steps from the tank to the evidence. Each says what the real system does; none claims a step the user skipped. */
export const STEPS: Step[] = [
  {
    title: "The inspection environment",
    body: "A digital twin of a 120 x 60 cm test tank: a pipeline with a valve on sand, loose debris, and an XY gantry carrying a downward camera. Drag to orbit, scroll to zoom.",
    scene: 1,
  },
  {
    title: "Gantry controls",
    body: "Click the plan view to move the carriage, or focus it and use the arrow keys. Home, Stop and Centre-on act on the twin's motion controller, with soft limits enforced.",
    scene: 4,
    target: '[data-tour="card"]',
  },
  {
    title: "The camera feed",
    body: "What the gantry camera sees right now, rendered from the twin. Corner brackets are the simulated detector; the strip below shows mission progress and the visibility the controller is acting on.",
    scene: 4,
    target: '[data-tour="feed"]',
  },
  {
    title: "Issue an inspection command",
    body: "Hold to talk (Muse Voice Transcribe, with a key) or type the instruction. Muse Spark 1.3 turns it into a structured mission through allowlisted tools; offline, a labelled keyword parser does.",
    scene: 5,
    target: '[data-tour="composer"]',
    status: () => {
      const m = ms().mission;
      return m ? { done: true, text: `Mission ${m.id} planned by ${m.provider.replace(/_/g, " ").toLowerCase()}.` } : { done: false, text: "Waiting for you: press Use the example instruction, then Plan mission." };
    },
  },
  {
    title: "Review the mission plan",
    body: "The backend validated the mission and compiled bounded waypoints. Every tool call is listed with who made it. Nothing moves until you approve.",
    scene: 5,
    target: '[data-tour="card"]',
    status: () => {
      const m = ms().mission;
      if (!m) return { done: false, text: "No plan yet: go back one step." };
      return m.status === "PLANNED" ? { done: false, text: "Plan ready: Approve and run, or Discard." } : { done: true, text: `Plan ${m.status.toLowerCase()}.` };
    },
  },
  {
    title: "AI segmentation",
    body: "Each capture goes through image quality checks, frame reasoning and SAM 3.1 segmentation, then becomes tracked observations. Without a key the outlines are the twin's geometry, labelled as such.",
    scene: 3,
    target: '[data-tour="card"]',
    status: () => {
      const n = ms().captures.length;
      return n ? { done: true, text: `${n} capture${n === 1 ? "" : "s"} analysed.` } : { done: false, text: "No captures yet: press Capture, or run the mission." };
    },
  },
  {
    title: "Change the water",
    body: "Turbidity and lighting are simulated, and they drive the rendered water, the camera feed, the detector and the controller together. Try a preset such as E Turbidity increase.",
    scene: 6,
    target: '[data-tour="card"]',
    status: () => {
      const t = ss().scenario.turbidity;
      return Math.abs(t - baselineTurbidity) > 0.01 ? { done: true, text: `Turbidity changed to ${t.toFixed(2)}.` } : { done: false, text: "Waiting for you: move the Turbidity slider." };
    },
  },
  {
    title: "Adaptive perception",
    body: "During a mission the controller slows below the degraded-visibility limit, pauses below the unsafe limit, and re-observes uncertain detections. Its current decision is shown under the feed.",
    scene: 6,
    target: '[data-testid="feed-status"]',
  },
  {
    title: "Inspection evidence",
    body: "When a mission ends the backend writes a report from stored records: route, observed objects, uninspected strips and unverified anomaly candidates, exportable as JSON or Markdown.",
    scene: 7,
    target: '[data-tour="card"]',
    status: () => {
      const r = ms().report;
      return r ? { done: true, text: `Report for ${r.mission.id}: ${r.assets.length} objects, ${r.anomalyCandidates.length} candidate(s).` } : { done: false, text: "No report yet: it appears when an approved mission ends." };
    },
  },
];

type Box = { x: number; y: number; w: number; h: number };
const PAD = 6;

function targetBox(sel: string | undefined): Box | null {
  if (!sel) return null;
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  return { x: r.left - PAD, y: r.top - PAD, w: r.width + PAD * 2, h: r.height + PAD * 2 };
}

/**
 * Guided onboarding. A spotlight ring with a dimmed surround that lets every click through, and a popover beside the
 * target. Arrow keys step, Escape closes. Opening it expands the panels the steps point at.
 */
export function Tour() {
  const step = useSimStore((s) => s.tourStep);
  const setTourStep = useSimStore((s) => s.setTourStep);
  const ring = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [, tick] = useState(0);
  const s = step === null ? null : STEPS[step];

  // entering a step: its scene, open panels; the first step records the water so step 7 can tell a real change
  useEffect(() => {
    if (step === null) return;
    const st = ss();
    if (step === 0) baselineTurbidity = st.scenario.turbidity;
    st.setPanels({ card: true, telemetry: true });
    if (st.scene !== STEPS[step].scene) st.setScene(STEPS[step].scene);
    pop.current?.focus({ preventScroll: true });
  }, [step]);

  // follow the target through card swaps and resizes; also re-read live status a few times a second
  useEffect(() => {
    if (step === null) return;
    const sel = STEPS[step].target;
    let last = "";
    const read = () => {
      const b = targetBox(sel);
      const key = b ? `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.w)},${Math.round(b.h)}` : "none";
      if (key !== last) {
        last = key;
        setBox(b);
      }
      tick((n) => n + 1);
    };
    read();
    const id = window.setInterval(read, 200);
    return () => window.clearInterval(id);
  }, [step]);

  // the ring glides between targets; the popover settles in after it
  useLayoutEffect(() => {
    const el = ring.current;
    if (!el || step === null) return;
    const d = prefersReducedMotion() ? 0 : DUR.panel;
    if (box) gsap.to(el, { x: box.x, y: box.y, width: box.w, height: box.h, opacity: 1, duration: d, ease: EASE.out, overwrite: true });
    else gsap.to(el, { opacity: 0, duration: d / 2, overwrite: true });
  }, [box, step]);

  useLayoutEffect(() => {
    if (step === null || !pop.current || prefersReducedMotion()) return;
    const t = gsap.fromTo(pop.current, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: DUR.base, ease: EASE.out, delay: 0.08 });
    return () => {
      t.kill();
    };
  }, [step]);

  useEffect(() => {
    if (step === null) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "Escape") setTourStep(null);
      else if (e.key === "ArrowRight") setTourStep(Math.min(STEPS.length - 1, step + 1));
      else if (e.key === "ArrowLeft") setTourStep(Math.max(0, step - 1));
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, setTourStep]);

  if (step === null || !s) return null;
  const status = s.status?.() ?? null;
  const last = step === STEPS.length - 1;
  const place = popoverPlacement(box);

  return (
    <div className="pointer-events-none fixed inset-0 z-40" data-testid="tour">
      {/* dimmed surround; the ring is a hole in it. Without a target the whole view dims lightly. */}
      <div
        ref={ring}
        className="absolute left-0 top-0 border border-teal/80 opacity-0"
        style={{ boxShadow: "0 0 0 9999px rgb(4 8 12 / 0.58), 0 0 24px 2px rgb(66 214 197 / 0.22)" }}
        aria-hidden
      />
      {!box && <div className="absolute inset-0 bg-[rgb(4_8_12/0.35)]" aria-hidden />}
      <div
        ref={pop}
        tabIndex={-1}
        role="dialog"
        aria-modal="false"
        aria-labelledby="tour-title"
        className="panel pointer-events-auto absolute w-[340px] max-w-[calc(100vw-2rem)] p-4 outline-none max-[759px]:inset-x-4! max-[759px]:bottom-4! max-[759px]:top-auto! max-[759px]:w-auto"
        style={place}
      >
        <div className="mb-2 flex items-center gap-1" aria-hidden>
          {STEPS.map((_, i) => (
            <span key={i} className={clsx("h-[3px] flex-1 transition-colors duration-300", i === step ? "bg-teal" : i < step ? "bg-teal/40" : "bg-line-strong")} />
          ))}
        </div>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="label text-[9px] text-dim">
              Guide {String(step + 1).padStart(2, "0")} / {String(STEPS.length).padStart(2, "0")}
            </div>
            <h2 id="tour-title" className="mt-0.5 text-[16px] leading-tight text-text">
              {s.title}
            </h2>
          </div>
          <button type="button" className="btn btn-icon -mr-1 -mt-1" onClick={() => setTourStep(null)} aria-label="Skip the guide">
            <X size={14} />
          </button>
        </div>
        <p className="mt-1.5 text-[12px] leading-snug text-muted">{s.body}</p>
        {status && (
          <p className={clsx("mt-2 border-l-2 pl-2 text-[11px] leading-snug", status.done ? "border-teal text-teal" : "border-amber text-amber")} role="status">
            {status.text}
          </p>
        )}
        <div className="mt-3 flex items-center gap-2">
          <Btn onClick={() => setTourStep(step - 1)} disabled={step === 0} label="Previous step">
            <ArrowLeft size={14} /> Back
          </Btn>
          <Btn primary onClick={() => setTourStep(last ? null : step + 1)} label={last ? "Finish the guide" : "Next step"}>
            {last ? "Finish" : "Next"} {!last && <ArrowRight size={14} />}
          </Btn>
          <button type="button" className="label ml-auto hover:text-text" onClick={() => setTourStep(null)}>
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}

/** Beside the target where there is room: left of right-hand targets, above low ones, below high ones, else to the side. Centred with no target. */
function popoverPlacement(b: Box | null): React.CSSProperties {
  if (typeof window === "undefined" || !b) return { left: "50%", top: "50%", transform: "translate(-50%, -50%)" };
  const W = window.innerWidth;
  const H = window.innerHeight;
  const PW = 340;
  const PH = 250; // tallest step, measured at 1440 x 900
  const clampX = (x: number) => Math.max(16, Math.min(W - PW - 16, x));
  const clampY = (y: number) => Math.max(64, Math.min(H - PH - 16, y));
  if (b.x > W * 0.55 && b.x - PW - 16 > 16) return { left: b.x - PW - 16, top: clampY(b.y) };
  if (b.y - PH - 12 > 56) return { left: clampX(b.x), bottom: H - b.y + 12 };
  if (b.y + b.h + PH + 12 < H) return { left: clampX(b.x), top: b.y + b.h + 12 };
  if (b.x - PW - 16 > 16) return { left: b.x - PW - 16, top: clampY(b.y) };
  return { left: clampX(b.x + b.w + 16), top: clampY(b.y) };
}
