"use client";

import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { Pause, Play, RotateCcw, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { DEMO_INSTRUCTION, DEMO_PHASES } from "@/lib/sim/demo";
import { useSimStore } from "@/lib/sim/store";
import type { MissionResult } from "@/lib/sim/types";
import { useMissionStore } from "@/lib/store/mission";
import { ExecTag } from "./intelligence";
import { Btn, SourceTag, f1, pad2, pct, providerSource } from "./shared";

function MissionMetrics({ r }: { r: MissionResult }) {
  const cells: [string, string, string?][] = [
    ["Outcome", r.outcome.replace(/_/g, " "), r.outcome === "COMPLETED" ? "text-teal" : "text-amber"],
    ["Targets", pad2(r.confirmedTargets), "text-teal"],
    ["False pos.", pad2(r.falsePositives), r.falsePositives ? "text-amber" : undefined],
    ["Captures", pad2(r.captures)],
    ["Unreliable", pad2(r.unreliableCaptures)],
    ["Pauses", pad2(r.pauses)],
    ["Coverage", pct(r.coverage, 0)],
    ["Duration", `${f1(r.durationS)} s`],
  ];
  return (
    <div className="grid grid-cols-4 gap-px bg-line max-[759px]:grid-cols-2">
      {cells.map(([k, v, tone]) => (
        <div key={k} className="bg-panel px-2 py-1.5">
          <div className="label text-[9px]">{k}</div>
          <div className={`value truncate text-[13px] leading-tight ${tone ?? "text-text"}`}>{v}</div>
        </div>
      ))}
    </div>
  );
}

/** The instruction as the backend received it: transcript with its audio source and model call, or the typed fallback. */
function DemoCommand() {
  const transcript = useMissionStore((s) => s.transcript);
  const voice = useMissionStore((s) => s.voice);
  const interpreting = useMissionStore((s) => s.interpreting);
  const interpretError = useMissionStore((s) => s.interpretError);
  const voiceLive = useMissionStore((s) => s.system?.providers.voice.status === "LIVE");
  const exec = useMissionStore((s) => s.executionLog?.executions.find((e) => e.operation === "transcription")?.classification);
  return (
    <div className="mt-2 space-y-1">
      <div className="border-l-2 border-teal pl-2">
        <p className="text-[12px] leading-snug text-text">&quot;{transcript?.transcript ?? DEMO_INSTRUCTION}&quot;</p>
      </div>
      <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
        {transcript ? (
          <>
            <ExecTag c={transcript.source === "RECORDED_INPUT" ? "RECORDED_INPUT" : "LIVE_INPUT"} /> <ExecTag c={exec ?? "NOT_RUN"} /> Muse Voice Transcribe, {transcript.latencyMs} ms
          </>
        ) : voice.state === "TRANSCRIBING" ? (
          "Transcribing the recorded instruction..."
        ) : voice.state === "ERROR" ? (
          <span className="text-amber">Voice Transcribe failed: {voice.error}. Using the typed instruction.</span>
        ) : (
          <>
            <ExecTag c="NOT_RUN" /> {voiceLive ? "Typed instruction." : "Typed instruction: Voice Transcribe needs MODEL_API_KEY."}
          </>
        )}
      </p>
      {interpreting && <p className="text-[11px] text-muted">Planning...</p>}
      {interpretError && <p className="text-[11px] text-amber">Planning failed: {interpretError}</p>}
    </div>
  );
}

/** Replaces the context card while the scripted demo runs. */
export function DemoCard() {
  const phase = useSimStore((s) => s.demo.phase);
  const paused = useSimStore((s) => s.demo.paused);
  const t = useSimStore((s) => s.demo.t);
  const result = useSimStore((s) => s.missionResult);
  const usedFixture = useSimStore((s) => s.demo.usedFixture);
  const mission = useMissionStore((s) => s.mission);
  const pauseDemo = useSimStore((s) => s.pauseDemo);
  const startDemo = useSimStore((s) => s.startDemo);
  const exitDemo = useSimStore((s) => s.exitDemo);
  const setShowVision = useSimStore((s) => s.setShowVision);
  const p = DEMO_PHASES[phase] ?? DEMO_PHASES[0];

  // The director does not publish phase start times, so remember when this card saw the phase change.
  const phaseStart = useRef<{ phase: number; t: number; closed: boolean } | null>(null);
  const isResult = p.id === "REPORT";
  useEffect(() => {
    const ps = phaseStart.current;
    if (!ps || ps.phase !== phase) {
      phaseStart.current = { phase, t, closed: false };
      return;
    }
    if (!isResult || ps.closed || t - ps.t < p.minSeconds) return;
    ps.closed = true;
    setShowVision(true);
  }, [phase, isResult, t, p.minSeconds, setShowVision]);

  return (
    <div>
      <div className="mb-3 flex items-center gap-1">
        {DEMO_PHASES.map((ph, i) => (
          <span key={ph.id} className={clsx("h-[3px] flex-1", i === phase ? "bg-teal" : i < phase ? "bg-teal/40" : "bg-line")} title={ph.title} />
        ))}
      </div>
      <div className="label mb-0.5 text-dim">
        Demo {String(phase + 1).padStart(2, "0")} / {String(DEMO_PHASES.length).padStart(2, "0")}
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={p.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18, ease: "easeOut" }}>
          <h2 className="font-sans text-lg leading-tight text-text">{p.title}</h2>
          <p className="mt-1 text-[12px] leading-snug text-muted">{p.caption}</p>
          {p.id === "COMMAND" && <DemoCommand />}
          {p.id === "PLAN" && (
            <p className="value mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted">
              {mission ? (
                <>
                  {mission.id}: {mission.planSummary.captureCount} captures, about {Math.round(mission.planSummary.estimatedDurationS)} s <SourceTag source={providerSource(mission.provider)} />
                </>
              ) : (
                "Waiting for the backend plan..."
              )}
            </p>
          )}
          {usedFixture && p.id !== "INTRO" && p.id !== "COMMAND" && (
            <p className="mt-1 text-[11px] text-amber">No backend plan arrived (planning failed or the backend is unreachable): the twin runs the built-in contract fixture plan, which no model produced.</p>
          )}
          {isResult && result && (
            <div className="mt-3">
              <MissionMetrics r={result} />
            </div>
          )}
        </motion.div>
      </AnimatePresence>
      <div className="mt-3 flex flex-wrap gap-2">
        <Btn onClick={() => pauseDemo(!paused)} active={paused}>
          {paused ? <Play size={14} /> : <Pause size={14} />} {paused ? "Resume" : "Pause"}
        </Btn>
        <Btn onClick={startDemo}>
          <RotateCcw size={14} /> Replay
        </Btn>
        <Btn onClick={exitDemo} className="ml-auto">
          <X size={14} /> Exit demo
        </Btn>
      </div>
    </div>
  );
}

const STAGES: [string, string][] = [
  ["Plain-language intent", "An operator says what to inspect. Muse Spark turns it into a bounded, validated mission."],
  ["Segment anything", "SAM 3.1 outlines the objects named for each frame; masks become tracked, positioned observations."],
  ["Adaptive scanning", "The controller slows in silt and pauses when the camera cannot be trusted."],
  ["Honest evidence", "Every finding keeps its frame, its source and its uncertainty. Nothing is called a defect unverified."],
  ["Same gantry, real tank", "The serial driver, interlocks and watchdog are ready; physical actuation waits for a verified rig."],
  ["Field inspection", "Only what has already worked in the tank goes into open water."],
];

/** The closing moment. Calm, sequential, no decoration. */
export function VisionMoment() {
  const setShowVision = useSimStore((s) => s.setShowVision);
  const result = useSimStore((s) => s.missionResult);
  const close = () => {
    const s = useSimStore.getState();
    if (s.demo.active) s.exitDemo(); // the demo has nowhere left to go after the closing moment
    s.setShowVision(false);
  };
  const runAgain = () => {
    const s = useSimStore.getState();
    close();
    s.applyPreset("E");
    s.setScene(6);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setShowVision]);

  return (
    <motion.div
      className="pointer-events-auto absolute inset-0 z-50 flex flex-col items-center justify-center overflow-y-auto bg-ground/[0.985] px-6 max-[759px]:justify-start max-[759px]:pt-14 max-[759px]:pb-8"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
    >
      <Btn onClick={close} className="absolute right-4 top-3">
        <X size={14} /> Close
      </Btn>
      <div className="label mb-6 text-dim">From simulation to field</div>
      <ol className="w-full max-w-[600px]">
        {STAGES.map(([name, text], i) => (
          <motion.li
            key={name}
            className="grid grid-cols-[200px_1fr] items-center gap-x-6 max-[759px]:grid-cols-1 max-[759px]:gap-y-1"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.15 + i * 0.12, ease: "easeOut" }}
          >
            <span
              className={clsx(
                "justify-self-start whitespace-nowrap border px-2.5 py-1.5 font-mono text-[11px] tracking-[0.12em] uppercase",
                i === STAGES.length - 1 ? "border-amber text-amber" : "border-teal text-teal",
              )}
            >
              {name}
            </span>
            <p className="text-[15px] leading-snug text-muted">{text}</p>
            {i < STAGES.length - 1 && (
              <>
                <span className="ml-4 h-5 w-px bg-line-strong" />
                <span />
              </>
            )}
          </motion.li>
        ))}
      </ol>
      <motion.h1
        className="mt-10 max-w-[700px] text-center font-sans text-2xl leading-tight text-text"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4, delay: 0.15 + STAGES.length * 0.12 + 0.1 }}
      >
        Give an inspection gantry the ability to understand what it is asked and what it sees.
      </motion.h1>
      <motion.div
        className="mt-4 flex flex-col items-center gap-4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4, delay: 0.15 + STAGES.length * 0.12 + 0.4 }}
      >
        {result && (
          <p className="value text-[13px] text-muted">
            This run: {result.confirmedTargets} targets confirmed, {result.falsePositives} false positive{result.falsePositives === 1 ? "" : "s"}, {result.pauses} pause
            {result.pauses === 1 ? "" : "s"}, {result.unreliableCaptures} unreliable frames, in a repeatable tank test.
          </p>
        )}
        <Btn onClick={runAgain}>Try the turbidity scenario</Btn>
      </motion.div>
    </motion.div>
  );
}
