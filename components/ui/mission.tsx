"use client";

import clsx from "clsx";
import { Check, Mic, Pause, Play, Square, Wand2, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { MissionRecord, ToolCallRecord } from "@/lib/api/types";
import { DEMO_INSTRUCTION } from "@/lib/sim/demo";
import { useSimStore } from "@/lib/sim/store";
import { useMissionStore } from "@/lib/store/mission";
import { Btn, CardHead, Chip, SourceTag, f1, human, pct, providerSource } from "./shared";

/** Push-to-talk: hold to record (pointer or Space while focused), release to transcribe. Speech to text only. */
function VoiceButton() {
  const voice = useMissionStore((s) => s.voice);
  const live = useMissionStore((s) => s.system?.providers.voice.status === "LIVE");
  const { startVoice, stopVoice } = useMissionStore(useShallow((s) => ({ startVoice: s.startVoice, stopVoice: s.stopVoice })));
  const recording = voice.state === "RECORDING";
  const busy = voice.state === "TRANSCRIBING";
  return (
    <button
      type="button"
      disabled={!live || busy}
      aria-label={recording ? "Release to transcribe" : "Hold to talk"}
      title={live ? "Hold to talk. Muse Voice Transcribe turns speech into text; it never speaks back." : "Voice needs MODEL_API_KEY on the backend. Type the instruction instead."}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        void startVoice();
      }}
      onPointerUp={() => void stopVoice()}
      onPointerCancel={() => void stopVoice()}
      onKeyDown={(e) => {
        if ((e.key === " " || e.key === "Enter") && !e.repeat && !recording) {
          e.preventDefault();
          void startVoice();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === " " || e.key === "Enter") void stopVoice();
      }}
      className={clsx("btn inline-flex shrink-0 items-center gap-1.5 select-none", recording && "border-danger! text-danger!", busy && "opacity-60")}
    >
      <Mic size={14} className={clsx(recording && "animate-pulse motion-reduce:animate-none")} />
      {recording ? "Listening" : busy ? "Transcribing" : "Hold to talk"}
    </button>
  );
}

function Composer() {
  const { instruction, interpreting, interpretError, canFallBack, voice, mission } = useMissionStore(
    useShallow((s) => ({ instruction: s.instruction, interpreting: s.interpreting, interpretError: s.interpretError, canFallBack: s.canFallBack, voice: s.voice, mission: s.mission })),
  );
  const { setInstruction, interpret } = useMissionStore(useShallow((s) => ({ setInstruction: s.setInstruction, interpret: s.interpret })));
  const sparkLive = useMissionStore((s) => s.system?.providers.spark.status === "LIVE");
  const backend = useMissionStore((s) => s.backend);
  const running = useSimStore((s) => s.mode === "MISSION");
  // a plan under review or a mission in progress owns the box; a finished one must not block the next instruction
  const locked = interpreting || running || (mission !== null && !["COMPLETED", "ABORTED", "FAILED"].includes(mission.status));
  return (
    <div>
      <label htmlFor="instruction" className="label mb-1 flex items-center justify-between">
        <span>Instruction</span>
        <span className="flex items-center gap-1.5">
          {voice.latencyMs !== undefined && voice.state === "IDLE" && <SourceTag source="VOICE" />}
          <SourceTag source={sparkLive ? "MUSE_SPARK" : "OFFLINE"} />
        </span>
      </label>
      <textarea
        id="instruction"
        rows={3}
        maxLength={2000} // the backend's limit; longer text would only come back as an opaque 422
        value={instruction}
        disabled={locked}
        onChange={(e) => setInstruction(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void interpret();
        }}
        placeholder="Describe the inspection, e.g. inspect the pipeline left to right for loose cables and foreign objects."
        className="w-full border border-line-strong bg-panel-2 px-2 py-1.5 text-[12px] leading-snug text-text outline-none placeholder:text-dim focus:border-teal disabled:opacity-60"
      />
      {voice.state === "ERROR" && <p className="mt-1 text-[11px] text-amber">{voice.error}</p>}
      {interpretError && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-amber">
          <span>{interpretError}</span>
          {canFallBack && (
            <button type="button" className="value text-[10px] underline hover:text-text" onClick={() => void interpret(true)}>
              Use the offline parser instead
            </button>
          )}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <VoiceButton />
        <Btn primary onClick={() => void interpret()} disabled={locked || backend === "OFFLINE" || instruction.trim().length < 3}>
          <Wand2 size={14} /> {interpreting ? "Planning" : "Plan mission"}
        </Btn>
        {!instruction && !locked && (
          <button type="button" className="value text-[10px] text-dim hover:text-text" onClick={() => setInstruction(DEMO_INSTRUCTION)}>
            Use the example instruction
          </button>
        )}
        {backend === "OFFLINE" && <span className="text-[11px] text-amber">Backend offline: missions need the backend (npm run dev:all).</span>}
      </div>
    </div>
  );
}

const SCAN: Record<string, string> = { left_to_right: "left to right", right_to_left: "right to left", serpentine: "serpentine" };

function SpecGrid({ m }: { m: MissionRecord }) {
  const s = m.spec;
  const p = s.visibilityPolicy;
  const rows: [string, string][] = [
    ["Objective", human(s.objective)],
    ["Targets", s.targets.map(human).join(", ")],
    ["Scan", `${SCAN[s.scanPattern]}, ${m.planSummary.lanes} lane${m.planSummary.lanes === 1 ? "" : "s"}`],
    ["Region", `x ${s.region.xMin} to ${s.region.xMax}, y ${s.region.yMin} to ${s.region.yMax} cm`],
    ["Speed", `${pct(s.speedFraction, 0)} of 15 cm/s`],
    ["Visibility", `${p.reduceSpeedOnDegradation ? `slow to ${pct(p.reducedSpeedFraction, 0)} below ${pct(p.degradedVisibility, 0)}` : "no slow-down"}; ${p.stopOnUnsafeVisibility ? `pause below ${pct(p.unsafeVisibility, 0)}` : "no pause"}`],
    ["Plan", `${m.planSummary.waypointCount} waypoints, ${m.planSummary.captureCount} captures, ${f1(m.planSummary.pathLengthCm)} cm, about ${Math.round(m.planSummary.estimatedDurationS)} s`],
  ];
  return (
    <div className="grid grid-cols-[82px_1fr] gap-x-3 gap-y-[3px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <span className="label">{k}</span>
          <span className="value text-[11px] leading-snug text-text">{v}</span>
        </div>
      ))}
    </div>
  );
}

function Timeline({ items }: { items: ToolCallRecord[] }) {
  return (
    <ol className="border-l border-line pl-3">
      {items.map((t, i) => (
        <li key={i} className="relative pb-1.5 last:pb-0">
          <span className={clsx("absolute -left-[15.5px] top-[5px] h-[6px] w-[6px] rounded-full", t.ok ? "bg-teal" : "bg-danger")} />
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className={clsx("value text-[11px]", t.ok ? "text-text" : "text-danger")}>{t.name}</span>
            <span className="label text-[9px] text-dim">
              {t.phase} by {t.by.replace(/_/g, " ")}
            </span>
          </div>
          {t.error && <div className="text-[11px] leading-snug text-danger/90">refused: {t.error}</div>}
        </li>
      ))}
    </ol>
  );
}

function PlanReview({ m }: { m: MissionRecord }) {
  const { approve, discard, actionError } = useMissionStore(useShallow((s) => ({ approve: s.approve, discard: s.discard, actionError: s.actionError })));
  const estop = useSimStore((s) => s.telemetry.estop);
  return (
    <div className="mt-3 border-t border-line pt-2">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="value text-[12px] text-text">{m.id}</span>
        <SourceTag source={providerSource(m.provider)} />
        <Chip active tone={m.status === "PLANNED" ? "amber" : "teal"}>
          {m.status}
        </Chip>
      </div>
      {m.explanation && <p className="mb-2 text-[12px] leading-snug text-muted">{m.explanation}</p>}
      {m.warnings.length > 0 && (
        <ul className="mb-2 space-y-0.5">
          {m.warnings.map((w) => (
            <li key={w} className="text-[11px] leading-snug text-amber">
              {w}
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-[1fr_200px] gap-4 max-[759px]:grid-cols-1">
        <SpecGrid m={m} />
        <div>
          <div className="label mb-1 text-dim">Tool calls</div>
          <Timeline items={m.timeline} />
        </div>
      </div>
      {actionError && m.status === "PLANNED" && <p className="mt-2 text-[11px] text-danger">{actionError}</p>}
      {m.status === "PLANNED" && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Btn primary onClick={() => void approve().then((ok) => ok && useSimStore.getState().setScene(4))} disabled={estop} title={estop ? "Clear the emergency stop first" : "Run the plan on the digital twin"}>
            <Check size={14} /> Approve and run
          </Btn>
          <Btn onClick={discard}>
            <X size={14} /> Discard
          </Btn>
          <span className="text-[11px] text-muted">Nothing moves until you approve. The plan runs on the digital twin.</span>
        </div>
      )}
    </div>
  );
}

const STATE_TONE: Record<string, string> = {
  NORMAL_VISIBILITY: "text-teal",
  REDUCED_VISIBILITY: "text-amber",
  LOW_CONFIDENCE: "text-amber",
  REOBSERVATION_REQUIRED: "text-amber",
  INSPECTION_PAUSED: "text-danger",
  OPERATOR_INTERVENTION_REQUIRED: "text-danger",
};

/** Live mission controls. They act on the twin immediately and update the backend record after. */
export function MissionLive() {
  const m = useSimStore((s) => s.mission);
  const running = useSimStore((s) => s.mode === "MISSION");
  const { pause, resume, stop, actionError } = useMissionStore(useShallow((s) => ({ pause: s.pause, resume: s.resume, stop: s.stop, actionError: s.actionError })));
  if (!m || !running) return null;
  return (
    <div className="mt-3 border-t border-line pt-2">
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-[3px]">
        <span className="label">Status</span>
        <span className="value text-[11px] text-text">
          {m.status} {m.status === "RUNNING" && `waypoint ${Math.min(m.waypointIndex + 1, m.waypointsPlanned)} of ${m.waypointsPlanned}`}
        </span>
        <span className="label">Perception</span>
        <span className={clsx("value text-[11px]", STATE_TONE[m.perception])}>{m.perception.replace(/_/g, " ")}</span>
        <span className="label">Visibility</span>
        <span className="value text-[11px] text-text">
          {pct(m.visibility, 0)} <SourceTag source="SIMULATED" className="ml-1" />
        </span>
        <span className="label">Speed</span>
        <span className="value text-[11px] text-text">{pct(m.speedFraction, 0)}</span>
        <span className="label">Reason</span>
        <span className="text-[11px] leading-snug text-muted">{m.reason}</span>
      </div>
      {actionError && <p className="mt-1 text-[11px] text-danger">{actionError}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {m.status === "PAUSED" ? (
          <Btn onClick={resume}>
            <Play size={14} /> Resume
          </Btn>
        ) : (
          <Btn onClick={pause}>
            <Pause size={14} /> Pause
          </Btn>
        )}
        <Btn onClick={stop}>
          <Square size={14} /> Stop mission
        </Btn>
      </div>
    </div>
  );
}

export function MissionCard() {
  const mission = useMissionStore((s) => s.mission);
  const report = useMissionStore((s) => s.report);
  const setScene = useSimStore((s) => s.setScene);
  return (
    <div>
      <CardHead
        title="AI mission control"
        note="Describe the inspection by voice or text. Muse Spark turns it into a structured mission through allowlisted tools; the backend validates it and compiles bounded waypoints for you to approve."
      />
      <Composer />
      {mission && <PlanReview m={mission} />}
      <MissionLive />
      {report && mission && report.mission.id === mission.id && (
        <button type="button" className="value mt-2 text-[10px] text-amber hover:underline" onClick={() => setScene(7)}>
          MISSION FINISHED, VIEW REPORT -&gt;
        </button>
      )}
    </div>
  );
}
