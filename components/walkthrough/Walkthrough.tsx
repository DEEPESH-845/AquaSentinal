"use client";

import clsx from "clsx";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { ScrollTrigger, gsap, useGsap } from "@/lib/animations/gsap";
import { DUR, EASE } from "@/lib/animations/motion";
import { compareStrategies } from "@/lib/sim/compare";
import { CAMERA, GANTRY, TANK } from "@/lib/sim/constants";
import { DEMO_FIXTURE_PLAN, DEMO_INSTRUCTION } from "@/lib/sim/demo";
import { visibilityBand } from "@/lib/sim/perception";
import { SCENARIO_PRESETS, defaultScenario, presetScenario } from "@/lib/sim/scenario";
import { FEED_ELEMENT_ID, SCENE_CAMERA, useSimStore, type CameraPreset } from "@/lib/sim/store";
import { C } from "@/lib/theme";
import { CompareTable, Flow, FrameWipe, Trajectory, type FlowStep, type FrameObjects } from "./visuals";

const LabScene = dynamic(() => import("@/components/lab/Scene").then((m) => m.LabScene), { ssr: false });

/** Camera preset and how much the twin is dimmed behind each section's own visual. */
const SECTIONS: Array<{ id: string; title: string; preset: CameraPreset; veil: number }> = [
  { id: "problem", title: "The problem", preset: "C", veil: 0 },
  { id: "system", title: "The system", preset: "A", veil: 0 },
  { id: "intelligence", title: "The intelligence", preset: "A", veil: 0.82 },
  { id: "perception", title: "The perception", preset: "D", veil: 0.82 },
  { id: "adaptive", title: "Adaptive perception", preset: "C", veil: 0.5 },
  { id: "result", title: "The result", preset: "B", veil: 0.8 },
  { id: "enter", title: "Enter the lab", preset: "A", veil: 0.35 },
];

const PLAN = DEMO_FIXTURE_PLAN;
const POLICY = PLAN.policy;
const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Section 05 turbidity over the scrubbed range: silt rises to 0.85, then settles to 0.3 so the scan can resume. */
const turbidityAt = (p: number) => (p < 0.65 ? 0.1 + (0.75 * p) / 0.65 : 0.85 - (0.55 * (p - 0.65)) / 0.35);

const FLOW: FlowStep[] = [
  { id: "voice", title: "VOICE", tag: "MUSE VOICE TRANSCRIBE", body: `"${DEMO_INSTRUCTION}"`, detail: "Speech to text only. The demo sends public/demo/instruction.wav, labelled RECORDED INPUT; push-to-talk is labelled LIVE MICROPHONE." },
  {
    id: "spark",
    title: "MUSE SPARK",
    tag: "MUSE SPARK 1.3",
    body: "Reads the instruction and answers only through allowlisted tools: set objective, targets, scan pattern, region and visibility policy.",
    detail: `targets: ${PLAN.targets.map((t) => t.toLowerCase().replace(/_/g, " ")).join(", ")}`,
  },
  {
    id: "plan",
    title: "MISSION PLAN",
    tag: "CONTRACT FIXTURE PLAN",
    body: `The backend validates the mission and compiles bounded waypoints: ${PLAN.waypoints.length} waypoints, ${pct(PLAN.speedFraction)} speed, region x ${PLAN.region.xMin} to ${PLAN.region.xMax}, y ${PLAN.region.yMin} to ${PLAN.region.yMax} cm.`,
    detail: `slow to ${pct(POLICY.reducedSpeedFraction)} below ${pct(POLICY.degradedVisibility)} visibility, pause below ${pct(POLICY.unsafeVisibility)}. Live plans come from Muse Spark 1.3 when MODEL_API_KEY is set.`,
  },
  { id: "inspect", title: "INSPECTION", tag: "OPERATOR APPROVAL", body: "Nothing moves until the operator approves. The gantry then scans and captures a frame at every waypoint.", detail: "Each frame: OpenCV image quality, Muse Spark frame reasoning, SAM 3.1 segmentation, track association." },
];

/* ---------------------------------------------------------------- shared pieces */

function Index({ n }: { n: number }) {
  return (
    <div data-reveal className="mb-5 flex items-center gap-3">
      <span className="value text-[11px] text-teal">{String(n).padStart(2, "0")}</span>
      <span className="h-px w-10 bg-line-strong" />
      <span className="value text-[11px] text-dim">07</span>
      <span className="label ml-2">{SECTIONS[n - 1].title}</span>
    </div>
  );
}

function Headline({ children, size = "lg" }: { children: ReactNode; size?: "lg" | "md" }) {
  return (
    <h2 data-reveal className={clsx("font-sans font-semibold uppercase tracking-[-0.01em] text-text", size === "lg" ? "text-[44px] leading-[1.04] max-[999px]:text-[30px]" : "text-[32px] leading-[1.08] max-[999px]:text-[26px]")}>
      {children}
    </h2>
  );
}

/** Copy block. The scrim sits behind the text only, so the twin stays visible around it. */
function Copy({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx("relative max-w-[560px] py-6 pr-8 min-[1000px]:bg-[linear-gradient(to_right,rgb(8_15_22/0.94)_0%,rgb(8_15_22/0.82)_70%,rgb(8_15_22/0))] max-[999px]:bg-ground/88 max-[999px]:px-5", className)}>
      {children}
    </div>
  );
}

function Lead({ children }: { children: ReactNode }) {
  return (
    <p data-reveal className="mt-5 text-[17px] leading-relaxed text-muted max-[999px]:text-[15px]">
      {children}
    </p>
  );
}

function Spec({ k, v }: { k: string; v: string }) {
  return (
    <div data-reveal className="contents">
      <span className="label border-t border-line pt-2">{k}</span>
      <span className="value border-t border-line pt-2 text-[13px] leading-snug text-text">{v}</span>
    </div>
  );
}

/* ---------------------------------------------------------------- 05 live readout */

/** The walkthrough never changes the water under a running inspection: that mission's evidence would no longer match its plan. */
const missionRunning = () => useSimStore.getState().mode === "MISSION";
const setWater = (turbidity: number) => {
  if (!missionRunning()) useSimStore.getState().setScenario({ turbidity });
};

function AdaptiveReadout() {
  const env = useSimStore(useShallow((s) => s.telemetry.environment));
  const turbidity = useSimStore((s) => s.scenario.turbidity);
  const locked = useSimStore((s) => s.mode === "MISSION");
  const band = visibilityBand(env.visibility, POLICY);
  const speed = band === "NORMAL" ? PLAN.speedFraction : band === "DEGRADED" ? POLICY.reducedSpeedFraction : 0;
  const tone = band === "NORMAL" ? "text-teal" : band === "DEGRADED" ? "text-amber" : "text-danger";
  const decision = band === "NORMAL" ? "Scan at plan speed" : band === "DEGRADED" ? "Slow the scan, re-observe uncertain detections" : "Pause: frames this murky are not recorded as evidence";
  return (
    <div className="space-y-4" data-testid="adaptive-readout">
      <label className="block">
        <div className="mb-1 flex items-center justify-between">
          <span className="label">Turbidity</span>
          <span className="value text-[13px] text-text">{turbidity.toFixed(2)}</span>
        </div>
        <input type="range" min={0} max={1} step={0.01} value={turbidity} disabled={locked} onChange={(e) => setWater(Number(e.target.value))} aria-label="Turbidity of the twin water" />
      </label>
      {locked && <p className="text-[12px] text-amber">An inspection is running in mission control, so this page leaves its water alone.</p>}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="label">Visibility estimate</span>
          <span className={clsx("value text-[13px]", tone)} data-testid="wt-visibility">
            {pct(env.visibility)} {band}
          </span>
        </div>
        <div className="relative h-2 bg-panel-2" aria-hidden>
          <div className={clsx("absolute inset-y-0 left-0 transition-[width] duration-200", band === "NORMAL" ? "bg-teal" : band === "DEGRADED" ? "bg-amber" : "bg-danger")} style={{ width: pct(env.visibility) }} />
          <span className="absolute -top-1 h-4 w-px bg-danger" style={{ left: pct(POLICY.unsafeVisibility) }} />
          <span className="absolute -top-1 h-4 w-px bg-amber" style={{ left: pct(POLICY.degradedVisibility) }} />
        </div>
        <div className="value mt-1 flex justify-between text-[10px] text-dim">
          <span>pause below {pct(POLICY.unsafeVisibility)}</span>
          <span>slow below {pct(POLICY.degradedVisibility)}</span>
        </div>
      </div>
      <div className="border-l-2 pl-3" style={{ borderColor: band === "NORMAL" ? C.teal : band === "DEGRADED" ? C.amber : C.danger }}>
        <div className="label">Controller command</div>
        <div className={clsx("value mt-0.5 text-[15px]", tone)}>{speed > 0 ? `${pct(speed)} speed` : "PAUSED"}</div>
        <div className="mt-0.5 text-[13px] text-muted">{decision}</div>
      </div>
      <p className="flex flex-wrap items-center gap-2 text-[11px] leading-snug text-dim">
        <span className="sim-tag">SIMULATED</span>
        Synthetic water in the twin, same thresholds as the mission controller. Each real capture also gets an image-derived estimate from OpenCV.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- page */

export function Walkthrough() {
  const root = useRef<HTMLDivElement>(null);
  const veil = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [wipe, setWipe] = useState(55);
  const [meta, setMeta] = useState<FrameObjects | null>(null);
  const result = useMemo(() => compareStrategies(presetScenario("E"), PLAN), []);
  const presetE = SCENARIO_PRESETS.find((p) => p.id === "E");
  const objects = useMemo(() => presetScenario("E").objects, []);
  const objectCount = defaultScenario().objects.length;

  useEffect(() => {
    let live = true;
    fetch("/walkthrough/clear-x37-objects.json")
      .then((r) => r.json())
      .then((m: FrameObjects) => live && setMeta(m))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  // The twin is shared with mission control: put back what this page changed when it unmounts.
  useEffect(() => {
    const turbidity = useSimStore.getState().engine.scenario.turbidity;
    return () => {
      const s = useSimStore.getState();
      setWater(turbidity);
      s.setCameraPreset(SCENE_CAMERA[s.scene]);
    };
  }, []);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (window as unknown as { __scrollTriggers?: () => number }).__scrollTriggers = () => ScrollTrigger.getAll().length;
  }, []);

  useGsap(
    () => {
      const q = gsap.utils.selector(root);
      const sections = q("[data-section]") as HTMLElement[];
      let active = -1;
      const sync = (progress: number) => {
        gsap.set(bar.current, { scaleX: progress });
        const mid = window.innerHeight / 2;
        const idx = sections.findIndex((el) => {
          const r = el.getBoundingClientRect();
          return r.top <= mid && r.bottom > mid;
        });
        if (idx < 0 || idx === active) return;
        active = idx;
        useSimStore.getState().setCameraPreset(SECTIONS[idx].preset);
        gsap.to(veil.current, { opacity: SECTIONS[idx].veil, duration: DUR.panel, ease: EASE.inOut, overwrite: true });
      };
      const setTurbidity = (p: number) => setWater(turbidityAt(p));

      const mm = gsap.matchMedia();
      // "any" always matches: gsap.matchMedia skips the callback when no condition matches, which would leave small screens with no triggers at all
      mm.add({ desktop: "(min-width: 1000px)", reduce: "(prefers-reduced-motion: reduce)", any: "all" }, (ctx) => {
        const { desktop, reduce } = ctx.conditions as { desktop: boolean; reduce: boolean };

        if (!reduce) {
          for (const sec of sections) {
            const els = sec.querySelectorAll("[data-reveal]");
            if (els.length) gsap.from(els, { opacity: 0, y: desktop ? 24 : 12, duration: desktop ? DUR.section : DUR.base, stagger: 0.07, ease: EASE.out, scrollTrigger: { trigger: sec, start: "top 78%" } });
          }
        }

        // 03: the flow lights up step by step, pinned on desktop only
        const s3 = q("#intelligence")[0];
        if (desktop && !reduce) {
          const nodes = s3.querySelectorAll("[data-node]");
          const links = s3.querySelectorAll("[data-link]");
          gsap.set(nodes, { opacity: 0.28 });
          gsap.set(links, { scaleY: 0 });
          const tl = gsap.timeline({ defaults: { ease: "none", duration: 1 }, scrollTrigger: { trigger: s3, start: "top top", end: "+=90%", pin: true, scrub: 0.4 } });
          nodes.forEach((n, i) => {
            tl.to(n, { opacity: 1, borderColor: C.teal });
            if (links[i]) tl.to(links[i], { scaleY: 1 });
          });
        }

        // 04: the wipe follows the scroll; the range input stays available
        if (!reduce) ScrollTrigger.create({ trigger: q("[data-wipe]")[0], start: "top 80%", end: "bottom 30%", onUpdate: (self) => setWipe(90 - 80 * self.progress) });

        // 05: scroll drives the twin's turbidity. Pinned on desktop; a plain scrubbed range on small screens.
        if (!reduce) {
          const s5 = q("#adaptive")[0];
          ScrollTrigger.create(desktop ? { trigger: s5, start: "top top", end: "+=140%", pin: true, onUpdate: (self) => setTurbidity(self.progress) } : { trigger: s5, start: "top 60%", end: "bottom 40%", onUpdate: (self) => setTurbidity(self.progress) });
        }

        // 06: the plan path draws itself
        if (!reduce) gsap.fromTo(q("[data-path]"), { strokeDashoffset: 1 }, { strokeDashoffset: 0, ease: "none", scrollTrigger: { trigger: q("#result svg")[0], start: "top 85%", end: "bottom 50%", scrub: true } });

        // created last so it reads section rects after the pins above have their spacers
        const st = ScrollTrigger.create({ start: 0, end: "max", onUpdate: (self) => sync(self.progress), onRefresh: (self) => sync(self.progress) });
        sync(st.progress);
      });
      return () => mm.revert();
    },
    [],
    root,
  );

  return (
    <div ref={root} className="relative min-h-dvh bg-ground text-text">
      {/* The live twin, fixed behind the story; never takes the scroll or the pointer. On desktop the canvas covers the
          right of the page, where the copy is not. */}
      <div className="fixed inset-y-0 right-0 left-[44vw] z-0 [mask-image:linear-gradient(to_right,transparent,black_22%)] max-[999px]:left-0 max-[999px]:[mask-image:none] [&_*]:pointer-events-none!" aria-hidden>
        <LabScene />
      </div>
      {/* The camera fit centres on the canvas and reads the stage rect as canvas pixels, so the stage spans the canvas
          size from the viewport origin. It is invisible; only its size matters. */}
      <div data-lab="stage" aria-hidden className="pointer-events-none invisible fixed left-0 top-12 bottom-0 w-[56vw] max-[999px]:bottom-auto max-[999px]:h-[40vh] max-[999px]:w-full" />
      <div ref={veil} className="pointer-events-none fixed inset-0 z-[1] bg-ground opacity-0" />
      <div className="pointer-events-none fixed inset-0 z-[1] bg-[radial-gradient(ellipse_at_70%_45%,transparent_40%,rgb(8_15_22/0.55)_100%)]" />

      <header className="fixed inset-x-0 top-0 z-30 flex h-12 items-center justify-between border-b border-line bg-ground/80 px-6 backdrop-blur-sm max-[999px]:px-4">
        <Link href="/" className="font-mono text-[13px] font-semibold tracking-[0.28em] text-text max-[439px]:tracking-[0.14em]">
          AQUASENTINAL
        </Link>
        <div className="flex items-center gap-4">
          <span className="label max-[639px]:hidden">Product walkthrough</span>
          <Link href="/" className="btn">
            Mission control
          </Link>
        </div>
        <div ref={bar} className="absolute inset-x-0 -bottom-px h-px origin-left scale-x-0 bg-teal" />
      </header>

      <main className="relative z-10">
        {/* 01 */}
        <section id="problem" data-section className="flex min-h-dvh items-center px-[6vw] pt-12 max-[999px]:items-end max-[999px]:px-4 max-[999px]:pb-10 max-[999px]:pt-[44vh]">
          <Copy>
            <Index n={1} />
            <Headline>The deeper the inspection, the less you can trust your eyes.</Headline>
            <Lead>Underwater inspection is challenged by degraded visibility, incomplete visual evidence and difficult coordination between operators and robotic systems.</Lead>
            <p data-reveal className="label mt-8 text-dim">
              Scroll. The tank behind this text is the live digital twin.
            </p>
          </Copy>
        </section>

        {/* 02 */}
        <section id="system" data-section className="flex min-h-dvh items-center px-[6vw] py-24 max-[999px]:px-4 max-[999px]:pt-[44vh]">
          <Copy>
            <Index n={2} />
            <Headline size="md">A camera gantry over a pipeline in a test tank.</Headline>
            <Lead>An XY gantry carries a downward camera across the tank. Every move is bounded by soft limits, and every frame is tied to the gantry position it was taken from.</Lead>
            <div className="mt-6 grid grid-cols-[132px_1fr] gap-x-4 gap-y-0">
              <Spec k="XY travel" v={`${GANTRY.travelX} x ${GANTRY.travelY} cm, ${GANTRY.maxSpeed} cm/s, ${GANTRY.accel} cm/s2`} />
              <Spec k="Camera" v={`nadir, ${CAMERA.hfovDeg} degree underwater FOV, lens ${Math.round(CAMERA.lensHeight * 100)} cm above the sand`} />
              <Spec k="Inspection area" v={`${TANK.length * 100} x ${TANK.width * 100} cm tank, ${TANK.waterLevel * 100} cm of water`} />
              <Spec k="Environment" v="turbidity and lighting in the twin; image-derived visibility from each frame" />
              <Spec k="Targets" v={`${objectCount} objects: pipeline, flanges, valve, loose cable, crate, wrench, rope, rocks`} />
            </div>
            <p data-reveal className="mt-5 flex flex-wrap items-center gap-2 text-[12px] text-dim">
              <span className="sim-tag">INHERITED TESTBED</span> The tank, gantry and camera rig come from HydraLoom. What follows is new.
            </p>
          </Copy>
        </section>

        {/* 03 */}
        <section id="intelligence" data-section className="grid min-h-dvh grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] items-center gap-12 px-[6vw] py-16 max-[999px]:grid-cols-1 max-[999px]:gap-6 max-[999px]:px-4 max-[999px]:py-20">
          <Copy>
            <Index n={3} />
            <Headline size="md">From a sentence to a bounded mission.</Headline>
            <Lead>The operator says what to inspect. Meta models turn it into structure; the backend decides what is allowed to move.</Lead>
          </Copy>
          <div className="w-full max-w-[560px] justify-self-end max-[999px]:max-w-none max-[999px]:bg-ground/88 max-[999px]:p-4">
            <Flow steps={FLOW} />
          </div>
        </section>

        {/* 04 */}
        <section id="perception" data-section className="grid min-h-dvh grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] items-center gap-12 px-[6vw] py-24 max-[999px]:grid-cols-1 max-[999px]:gap-6 max-[999px]:px-4">
          <Copy>
            <Index n={4} />
            <Headline size="md">Outlines, not guesses.</Headline>
            <Lead>For every capture, Muse Spark names what to look for and SAM 3.1 returns a mask for each instance. Masks become tracked observations with a position on the gantry plane, so the same cable seen twice stays one object.</Lead>
            <p data-reveal className="mt-4 text-[14px] leading-relaxed text-muted">
              The overlay here is drawn from the twin&apos;s own geometry, the reference SAM 3.1 is scored against. Live SAM 3.1 masks appear in Perception when the backend has MODEL_API_KEY.
            </p>
          </Copy>
          <div data-reveal className="w-full max-w-[600px] justify-self-end max-[999px]:max-w-none max-[999px]:bg-ground/88 max-[999px]:p-4">
            <FrameWipe meta={meta} wipe={wipe} onWipe={setWipe} />
          </div>
        </section>

        {/* 05 */}
        <section id="adaptive" data-section className="flex min-h-dvh items-center px-[6vw] py-16 max-[999px]:flex-col max-[999px]:items-stretch max-[999px]:px-4 max-[999px]:pt-[44vh]">
          <div className="grid w-full max-w-[1000px] grid-cols-[minmax(0,1fr)_minmax(0,340px)] gap-8 max-[999px]:grid-cols-1 max-[999px]:gap-4">
            <Copy className="pb-4">
              <Index n={5} />
              <Headline size="md">When the water clouds, the scan adapts.</Headline>
              <Lead>Keep scrolling: silt rises in the twin and then settles. The controller slows below the degraded threshold and pauses below the unsafe one, instead of recording frames nobody should trust.</Lead>
              <div className="mt-6">
                <AdaptiveReadout />
              </div>
            </Copy>
            <div className="self-start pt-6">
              <div className="label mb-1 flex items-center justify-between bg-ground/85 px-2 py-1">
                <span className="text-text">Gantry camera</span>
                <span className="sim-tag">DIGITAL TWIN</span>
              </div>
              {/* transparent on purpose: the canvas underneath paints the gantry camera into this rect */}
              <div id={FEED_ELEMENT_ID} className="relative aspect-[4/3] w-full border border-line-strong">
                <span className="absolute left-1/2 top-1/2 h-4 w-px -translate-x-1/2 -translate-y-1/2 bg-teal/70" />
                <span className="absolute left-1/2 top-1/2 h-px w-4 -translate-x-1/2 -translate-y-1/2 bg-teal/70" />
              </div>
            </div>
          </div>
        </section>

        {/* 06 */}
        <section id="result" data-section className="grid min-h-dvh grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] items-center gap-12 px-[6vw] py-24 max-[999px]:grid-cols-1 max-[999px]:gap-6 max-[999px]:px-4">
          <Copy>
            <Index n={6} />
            <Headline size="md">From a camera feed to an intelligent inspection system.</Headline>
            <Lead>
              The same plan run twice on scenario E ({presetE?.name.toLowerCase()}): once with the visibility policy, once at fixed speed. Every finding keeps its frame, its source and its uncertainty; nothing is called a defect until it is verified.
            </Lead>
            <p data-reveal className="mt-4 flex flex-wrap items-center gap-2 text-[12px] text-dim">
              <span className="sim-tag">SIMULATED</span> Computed in your browser on the twin, seed {presetScenario("E").seed}. Reruns give identical numbers.
            </p>
          </Copy>
          <div data-reveal className="w-full max-w-[560px] justify-self-end space-y-4 max-[999px]:max-w-none max-[999px]:bg-ground/88 max-[999px]:p-4">
            <Trajectory plan={PLAN} objects={objects} />
            <div className="value flex flex-wrap gap-x-4 text-[10px] text-dim">
              <span className="text-teal">o waypoint and path</span>
              <span className="text-amber">[] inspection target</span>
              <span>[] other object</span>
            </div>
            <CompareTable adaptive={result.adaptive} fixed={result.fixed} />
          </div>
        </section>

        {/* 07 */}
        <section id="enter" data-section className="flex min-h-[80dvh] items-center justify-center px-[6vw] py-24 text-center max-[999px]:px-4">
          <div className="max-w-[640px] bg-[radial-gradient(ellipse_at_center,rgb(8_15_22/0.9)_30%,rgb(8_15_22/0)_75%)] px-8 py-10">
            <div data-reveal className="mb-5 flex items-center justify-center gap-3">
              <span className="value text-[11px] text-teal">07</span>
              <span className="h-px w-10 bg-line-strong" />
              <span className="value text-[11px] text-dim">07</span>
            </div>
            <Headline size="md">Enter the lab.</Headline>
            <Lead>Describe an inspection, approve the plan, change the water and read the evidence. Every value is labelled live, simulated or fallback.</Lead>
            <div data-reveal className="mt-8 flex justify-center">
              <Link href="/" className="btn btn-primary px-6! py-3! text-[12px]!">
                Enter mission control
              </Link>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
