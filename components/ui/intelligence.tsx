"use client";

import clsx from "clsx";
import { Play, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import type { ExecutionLog } from "@/lib/api/types";
import { CONTRIBUTIONS, INHERITED, SCENE_ORIGIN, type ContributionOrigin } from "@/lib/hackathon/contributions";
import { useSimStore } from "@/lib/sim/store";
import { useMissionStore } from "@/lib/store/mission";
import { Btn, CardHead, Dot, pct } from "./shared";

/**
 * Execution classes. Each one is derived from recorded state, never asserted by the UI:
 * LIVE_META only when the backend logged a successful request to the Meta API endpoint for that step.
 * HARDWARE_LIVE is never shown: no physical hardware event has been verified in this build.
 */
export type ExecClass = "LIVE_META" | "LIVE_META_FAILED" | "MOCKED" | "SIMULATED" | "RECORDED_INPUT" | "LIVE_INPUT" | "OFFLINE_FALLBACK" | "DETERMINISTIC" | "NOT_RUN";

const EXEC_TEXT: Record<ExecClass, string> = {
  LIVE_META: "LIVE META",
  LIVE_META_FAILED: "LIVE CALL FAILED",
  MOCKED: "MOCKED",
  SIMULATED: "SIMULATED",
  RECORDED_INPUT: "RECORDED INPUT",
  LIVE_INPUT: "LIVE MICROPHONE",
  OFFLINE_FALLBACK: "OFFLINE FALLBACK",
  DETERMINISTIC: "DETERMINISTIC",
  NOT_RUN: "NOT RUN",
};

export function ExecTag({ c, className }: { c: ExecClass; className?: string }) {
  return (
    <span
      data-exec={c}
      className={clsx(
        "sim-tag whitespace-nowrap",
        c === "LIVE_META" && "border-teal! bg-teal/15 text-teal!",
        (c === "LIVE_META_FAILED" || c === "MOCKED") && "border-danger/70! text-danger!",
        c === "OFFLINE_FALLBACK" && "border-amber/60! text-amber!",
        c === "NOT_RUN" && "opacity-60",
        className,
      )}
    >
      {EXEC_TEXT[c]}
    </span>
  );
}

const ORIGIN_TEXT: Record<ContributionOrigin, string> = { new: "HACKATHON-BUILT", adapted: "ADAPTED FROM HYDRALOOM", inherited: "INHERITED FOUNDATION" };

/** Provenance of a scene, from the contribution registry. Never says hackathon-built about inherited work. */
export function OriginTag({ scene }: { scene: number }) {
  const o = SCENE_ORIGIN[scene];
  if (!o) return null;
  return (
    <span title={o.note} data-origin={o.origin} className={clsx("sim-tag whitespace-nowrap", o.origin === "new" && "border-teal/60! text-teal!")}>
      {ORIGIN_TEXT[o.origin]}
    </span>
  );
}

/** The latest logged execution of an operation, classified. Null when the backend has logged none. */
function lastExec(log: ExecutionLog | null, op: string): ExecClass | null {
  const e = log?.executions.find((x) => x.operation === op);
  return e ? e.classification : null;
}

interface Stage {
  name: string;
  model?: string;
  value: string;
  exec: ExecClass[];
}

function useStages(): Stage[] {
  const { transcript, mission, captures, report, log, system } = useMissionStore(
    useShallow((s) => ({ transcript: s.transcript, mission: s.mission, captures: s.captures, report: s.report, log: s.executionLog, system: s.system })),
  );
  const m = useSimStore((s) => s.mission);
  const running = useSimStore((s) => s.mode === "MISSION");
  const live = system?.providers.spark.status === "LIVE";
  const segs = captures.flatMap((c) => c.result?.segmentations ?? []);
  const obs = captures.flatMap((c) => c.result?.observations ?? []);
  const samSegs = segs.filter((s) => s.provider === "SAM_3_1");
  const okSam = samSegs.filter((s) => s.status === "OK" || s.status === "EMPTY" || s.status === "REUSED");
  const masks = samSegs.reduce((n, s) => n + s.instances.length, 0);
  const assets = new Set(obs.map((o) => o.assetId)).size;

  const voiceExec: ExecClass[] = transcript
    ? [transcript.source === "RECORDED_INPUT" ? "RECORDED_INPUT" : "LIVE_INPUT", lastExec(log, "transcription") ?? "NOT_RUN"]
    : [system?.providers.voice.status === "LIVE" ? "NOT_RUN" : "OFFLINE_FALLBACK"];
  const planExec: ExecClass[] = !mission ? ["NOT_RUN"] : mission.provider === "MUSE_SPARK" ? [lastExec(log, "mission_planning") ?? "NOT_RUN"] : mission.provider === "OPERATOR" ? ["DETERMINISTIC"] : ["OFFLINE_FALLBACK"];
  const samExec: ExecClass[] = samSegs.length ? [okSam.length ? (lastExec(log, "segmentation") ?? "NOT_RUN") : "LIVE_META_FAILED"] : segs.length ? ["OFFLINE_FALLBACK"] : ["NOT_RUN"];

  return [
    {
      name: "Voice instruction",
      model: "Muse Voice Transcribe",
      value: transcript ? `"${transcript.transcript.slice(0, 90)}${transcript.transcript.length > 90 ? "..." : ""}" ${transcript.latencyMs === null ? "cached" : `${transcript.latencyMs} ms`}` : live ? "waiting for push-to-talk or the recorded instruction" : "no key: the instruction is typed",
      exec: voiceExec,
    },
    {
      name: "Mission reasoning",
      model: "Muse Spark 1.3",
      value: mission ? `${mission.id}: ${mission.spec.targets.join(", ")}; ${mission.timeline.length} tool call(s)` : "no mission yet",
      exec: planExec,
    },
    {
      name: "Validated plan",
      value: mission ? `${mission.planSummary.captureCount} captures, ${mission.planSummary.waypointCount} waypoints, ${Math.round(mission.planSummary.pathLengthCm)} cm, inside soft limits; ${mission.status}` : "compiled by the backend after validation",
      exec: mission ? ["DETERMINISTIC"] : ["NOT_RUN"],
    },
    {
      name: "Inspection",
      value: m ? `${m.status} waypoint ${Math.min(m.waypointIndex + 1, m.waypointsPlanned)} / ${m.waypointsPlanned}, ${captures.length} captures; frames rendered by the twin` : "gantry idle",
      exec: m ? ["SIMULATED"] : ["NOT_RUN"],
    },
    {
      name: "Segmentation",
      model: "SAM 3.1",
      value: samSegs.length ? `${okSam.length} / ${samSegs.length} requests answered, ${masks} masks` : segs.length ? `${segs.length} twin-geometry outlines, no model` : "no captures yet",
      exec: samExec,
    },
    {
      name: "Track association",
      value: obs.length ? `${obs.length} observations on ${assets} persistent asset(s)` : "no observations yet",
      exec: obs.length ? ["DETERMINISTIC"] : ["NOT_RUN"],
    },
    {
      name: "Adaptive control",
      value: m && running ? `${m.perception.replace(/_/g, " ")}, speed ${pct(m.speedFraction, 0)}, visibility ${pct(m.visibility, 0)}` : m ? `${m.perception.replace(/_/g, " ")}` : "deterministic visibility controller, not the model",
      exec: m ? ["SIMULATED", "DETERMINISTIC"] : ["NOT_RUN"],
    },
    {
      name: "Evidence report",
      model: report?.summary.provider === "MUSE_SPARK" ? "Muse Spark 1.3" : undefined,
      value: report ? `${report.assets.length} assets, ${report.anomalyCandidates.length} unverified candidate(s); summary: ${report.summary.provider.replace(/_/g, " ").toLowerCase()}` : "written when the mission ends",
      exec: !report ? ["NOT_RUN"] : report.summary.provider === "MUSE_SPARK" ? [lastExec(log, "report_summary") ?? "NOT_RUN"] : ["DETERMINISTIC"],
    },
  ];
}

function ExecutionTable({ log }: { log: ExecutionLog | null }) {
  const rows = log?.executions.slice(0, 6) ?? [];
  const counts = log?.counts ?? {};
  return (
    <div data-testid="execution-log">
      <div className="mb-1 flex items-center gap-2">
        <span className="label">Model execution log</span>
        <span className="value text-[10px] text-dim">
          {log ? `live ok ${counts.LIVE_META ?? 0}, live failed ${counts.LIVE_META_FAILED ?? 0}, mocked ${counts.MOCKED ?? 0}` : "backend unreachable"}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="border-t border-line pt-1 text-[11px] text-muted">No Meta request has been made by this backend. Nothing on this page is presented as model output until one is logged here.</p>
      ) : (
        <div className="grid grid-cols-[auto_1fr_auto_auto] gap-x-3 border-t border-line pt-1">
          {rows.map((e) => (
            <div key={e.id} className="contents">
              <span className="value text-[10px] text-dim">{e.requestAt.slice(11, 19)}</span>
              <span className="value truncate text-[10px] text-text" title={`${e.inputRef} -> ${e.outputRef ?? e.error ?? ""}${e.traceId ? ` trace ${e.traceId}` : ""}`}>
                {e.model} {e.operation}
              </span>
              <span className="value text-[10px] text-muted">{e.durationMs != null ? `${Math.round(e.durationMs)} ms` : "-"}</span>
              <ExecTag c={e.classification} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function IntelligenceCard() {
  const stages = useStages();
  const { preflight, log, refreshEvidence, backend } = useMissionStore(useShallow((s) => ({ preflight: s.preflight, log: s.executionLog, refreshEvidence: s.refreshEvidence, backend: s.backend })));
  const demoActive = useSimStore((s) => s.demo.active);
  const startDemo = useSimStore((s) => s.startDemo);

  useEffect(() => void refreshEvidence(), [refreshEvidence]);

  const tested = CONTRIBUTIONS.filter((c) => c.status === "tested").length;
  const verified = CONTRIBUTIONS.filter((c) => c.status === "verified").length;
  return (
    <div data-testid="intelligence-card">
      <CardHead
        title="New inspection intelligence"
        note="AquaSentinal introduces multimodal, adaptive underwater inspection using Meta AI models. Each step below shows where its output came from."
      />
      <ol className="border-t border-line">
        {stages.map((s, i) => (
          <li key={s.name} className="grid grid-cols-[18px_150px_1fr_auto] items-baseline gap-x-2 border-b border-line py-[3px] max-[759px]:grid-cols-[18px_1fr_auto]">
            <span className="value text-[10px] text-dim">{String(i + 1).padStart(2, "0")}</span>
            <span className="min-w-0">
              <span className="label text-text">{s.name}</span>
              {s.model && <span className="block truncate text-[9px] text-dim">{s.model}</span>}
            </span>
            <span className="truncate text-[11px] text-muted max-[759px]:col-span-2 max-[759px]:col-start-2 max-[759px]:row-start-2" title={s.value}>
              {s.value}
            </span>
            <span className="flex justify-end gap-1">
              {s.exec.map((c) => (
                <ExecTag key={c} c={c} />
              ))}
            </span>
          </li>
        ))}
      </ol>

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 max-[759px]:grid-cols-1">
        <div data-testid="preflight">
          <div className="mb-1 flex items-center gap-2">
            <span className="label">Judge preflight</span>
            <span className={clsx("value text-[10px]", preflight?.liveMetaReady ? "text-teal" : "text-amber")}>
              {backend !== "ONLINE" ? "backend offline" : !preflight ? "checking" : preflight.liveMetaReady ? "live Meta verified" : "live Meta not verified"}
            </span>
          </div>
          <ul className="border-t border-line">
            {(preflight?.checks ?? []).map((c) => (
              <li key={c.id} className="grid grid-cols-[10px_1fr] items-baseline gap-x-2 py-[1px]" title={c.detail}>
                <Dot tone={c.ok ? "teal" : "amber"} />
                <span className="truncate text-[11px] text-text">
                  {c.label} <span className="text-muted">- {c.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <ExecutionTable log={log} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Btn primary onClick={startDemo} disabled={demoActive} label="Start judge demo">
          <Play size={14} /> Start judge demo
        </Btn>
        <Btn onClick={() => void refreshEvidence()} label="Refresh preflight">
          <RefreshCw size={14} /> Refresh
        </Btn>
        <span className="ml-auto text-[10px] text-dim" title={INHERITED.map((c) => c.name).join("; ")}>
          {CONTRIBUTIONS.length} hackathon contributions: {tested} tested, {verified} verified live. {INHERITED.length} inherited foundations.
        </span>
      </div>
    </div>
  );
}
