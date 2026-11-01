"use client";

import clsx from "clsx";
import { Download, FileText, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import type { InspectionReport } from "@/lib/api/types";
import { GANTRY } from "@/lib/sim/constants";
import { useSimStore } from "@/lib/sim/store";
import { useMissionStore } from "@/lib/store/mission";
import { Btn, CardHead, SourceTag, f1, f2, human, isTargetClass, pad2, pct, providerSource } from "./shared";

const MAP_W = 300;
const MAP_H = (MAP_W * GANTRY.travelY) / GANTRY.travelX;

/** Plan view of the inspection: region, uninspected strips, capture path, observed assets. Gantry cm, origin top left. */
function ReportMap({ r }: { r: InspectionReport }) {
  const sx = (x: number) => (x / GANTRY.travelX) * MAP_W;
  const sy = (y: number) => (y / GANTRY.travelY) * MAP_H;
  const reg = r.mission.spec.region;
  return (
    <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} className="w-full border border-line-strong bg-panel-2/60" role="img" aria-label="Inspection map">
      <rect x={sx(reg.xMin)} y={sy(reg.yMin)} width={sx(reg.xMax - reg.xMin)} height={Math.max(1, sy(reg.yMax - reg.yMin))} fill="none" stroke="#34465a" strokeDasharray="3 3" />
      {r.uninspectedAreas.map((u, i) => (
        <rect key={i} x={sx(u.xMin)} y={sy(u.yMin)} width={sx(u.xMax - u.xMin)} height={sy(u.yMax - u.yMin)} fill="#e5484d" fillOpacity={0.14} />
      ))}
      <polyline points={r.path.map((p) => `${sx(p.x)},${sy(p.y)}`).join(" ")} fill="none" stroke="#3db9b0" strokeOpacity={0.6} strokeWidth={1} />
      {r.path.map((p) => (
        <circle key={p.captureId} cx={sx(p.x)} cy={sy(p.y)} r={2} fill={p.reason === "REOBSERVE" ? "#f2a93b" : "#3db9b0"} />
      ))}
      {r.assets.map((a) => (
        <g key={a.assetId}>
          <rect x={sx(a.x) - 3} y={sy(a.y) - 3} width={6} height={6} fill="none" stroke={isTargetClass(a.label) ? "#f2a93b" : "#8b98a5"} strokeWidth={1.2} />
        </g>
      ))}
    </svg>
  );
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Metrics({ r }: { r: InspectionReport }) {
  const t = r.outcome.twinResult as Record<string, number> | null;
  const cells: [string, string, string?][] = [
    ["Outcome", t ? String(r.outcome.twinResult?.outcome).replace(/_/g, " ") : r.outcome.status, t?.outcome === ("COMPLETED" as unknown as number) ? "text-teal" : "text-amber"],
    ["Captures", pad2(r.path.length)],
    ["Objects", pad2(r.assets.length)],
    ["Candidates", pad2(r.anomalyCandidates.length), r.anomalyCandidates.length ? "text-amber" : undefined],
    ["Coverage", pct(r.coverageEstimate, 0)],
    ["Re-observed", t ? pad2(t.reobservations) : "-"],
    ["Pauses", t ? pad2(t.pauses) : "-"],
    ["Duration", t ? `${f1(t.durationS)} s` : "-"],
  ];
  return (
    <div className="grid grid-cols-4 gap-px bg-line max-[759px]:grid-cols-2">
      {cells.map(([k, v, tone]) => (
        <div key={k} className="bg-panel px-2 py-1.5">
          <div className="label text-[9px]">{k}</div>
          <div className={clsx("value truncate text-[14px] leading-tight", tone ?? "text-text")}>{v}</div>
        </div>
      ))}
    </div>
  );
}

function History() {
  const history = useMissionStore((s) => s.history);
  const loadReport = useMissionStore((s) => s.loadReport);
  const loadHistory = useMissionStore((s) => s.loadHistory);
  const current = useMissionStore((s) => s.report?.mission.id);
  useEffect(() => void loadHistory(), [loadHistory]);
  if (!history.length) return null;
  return (
    <div className="mt-3 border-t border-line pt-2">
      <div className="label mb-1 text-dim">History</div>
      <div className="max-h-28 overflow-y-auto">
        {history.map((h) => (
          <button
            key={h.id}
            type="button"
            onClick={() => void loadReport(h.id)}
            className={clsx("grid w-full grid-cols-[1fr_auto_auto] gap-x-3 border-b border-line py-[3px] text-left hover:bg-panel-2/60", h.id === current && "bg-panel-2")}
          >
            <span className="value truncate text-[11px] text-text">{h.id}</span>
            <span className="value text-[10px] text-muted">
              {h.captures} cap {h.assets} obj
            </span>
            <span className={clsx("label text-[9px]", h.status === "COMPLETED" ? "text-teal" : h.status === "RUNNING" ? "text-amber" : "text-dim")}>{h.status}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function ReportCard() {
  const r = useMissionStore((s) => s.report);
  const error = useMissionStore((s) => s.reportError);
  const backend = useMissionStore((s) => s.backend);
  const mission = useMissionStore((s) => s.mission);
  const missionResult = useSimStore((s) => s.missionResult);
  const [showPath, setShowPath] = useState(false);

  if (!r) {
    return (
      <div>
        <CardHead title="Inspection report" note={backend === "OFFLINE" ? "Reports are built by the backend from stored records. It is offline." : "No report yet. Plan and run a mission in AI Mission Control; its report appears here when it ends."} />
        {missionResult && <p className="value text-[11px] text-muted">Last twin run: {missionResult.outcome.replace(/_/g, " ")}, {missionResult.captures} captures (not recorded: no backend mission).</p>}
        {error && <p className="text-[11px] text-danger">{error}</p>}
        <Btn primary onClick={() => useSimStore.getState().setScene(5)}>
          Plan a mission
        </Btn>
        <History />
      </div>
    );
  }

  const s = r.summary;
  const replay = () => {
    const plan = mission?.id === r.mission.id ? mission.plan : null;
    if (plan && useSimStore.getState().runMission(plan, true)) useSimStore.getState().setScene(4);
  };
  return (
    <div>
      <CardHead
        title="Inspection report"
        note={r.mission.instruction}
        right={
          <div className="flex shrink-0 gap-1.5">
            <Btn onClick={() => download(`${r.mission.id}.json`, JSON.stringify(r, null, 2), "application/json")} label="Export JSON">
              <Download size={14} /> JSON
            </Btn>
            <a className="btn inline-flex items-center gap-1.5" href={api.reportMarkdownUrl(r.mission.id)} download aria-label="Export Markdown">
              <FileText size={14} /> MD
            </a>
          </div>
        }
      />
      <Metrics r={r} />
      <div className="mt-3 grid grid-cols-[minmax(0,1fr)_300px] gap-4 max-[999px]:grid-cols-1">
        <div className="min-w-0">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="label text-dim">Summary</span>
            <SourceTag source={providerSource(s.provider)} />
          </div>
          <p className="text-[12px] leading-snug text-text">{s.summary}</p>
          {s.error && <p className="mt-0.5 text-[10px] text-dim">{s.error}</p>}
          {s.limitations.length > 0 && (
            <ul className="mt-1 list-disc pl-4">
              {s.limitations.map((l) => (
                <li key={l} className="text-[11px] leading-snug text-muted">
                  {l}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2">
            <div className="label mb-0.5 text-dim">Anomaly candidates (unverified)</div>
            {r.anomalyCandidates.length === 0 && <p className="text-[11px] text-muted">None observed.</p>}
            {r.anomalyCandidates.map((a) => (
              <div key={a.assetId} className="grid grid-cols-[1fr_auto] gap-x-2 border-b border-line py-[2px] text-[11px]">
                <span className="value text-amber">
                  {human(a.label)} <span className="text-dim">{a.assetId.slice(-6)}</span>
                </span>
                <span className="value whitespace-nowrap text-muted">
                  ({f1(a.x)}, {f1(a.y)}) cm, {a.observations} obs{a.bestConfidence !== null ? `, ${pct(a.bestConfidence, 0)} ${a.confidenceSource === "SAM_3_1" ? "SAM" : "sim"}` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <ReportMap r={r} />
          <div className="value mt-1 flex flex-wrap gap-x-3 text-[9px] text-dim">
            <span className="text-teal">o capture</span>
            <span className="text-amber">o re-observe</span>
            <span className="text-amber">[] candidate</span>
            <span className="text-danger">uninspected</span>
          </div>
          <div className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-[2px] text-[11px]">
            <span className="label">Segmenter</span>
            <span className="value text-text">{r.segmentation.provider.replace(/_/g, " ")}</span>
            {r.segmentation.meanIouVsTwinTruth !== null && (
              <>
                <span className="label">IoU vs twin</span>
                <span className="value text-teal">
                  {f2(r.segmentation.meanIouVsTwinTruth)} over {r.segmentation.iouSamples} masks
                </span>
              </>
            )}
            {r.segmentation.meanLatencyMs !== null && (
              <>
                <span className="label">SAM latency</span>
                <span className="value text-text">{Math.round(r.segmentation.meanLatencyMs)} ms mean</span>
              </>
            )}
            <span className="label">Uninspected</span>
            <span className="value text-text">{r.uninspectedAreas.length} strip{r.uninspectedAreas.length === 1 ? "" : "s"}</span>
          </div>
        </div>
      </div>
      <button type="button" className="label mt-2 flex items-center gap-1.5 hover:text-text" onClick={() => setShowPath((v) => !v)} aria-expanded={showPath}>
        <span className="value text-[10px] text-dim">{showPath ? "-" : "+"}</span> Observed objects and capture path
      </button>
      {showPath && (
        <div className="mt-1 max-h-40 overflow-y-auto border border-line bg-ground/60 px-2 py-1 font-mono text-[10px] leading-[15px]">
          {r.assets.map((a) => (
            <div key={a.assetId} className={isTargetClass(a.label) ? "text-amber" : "text-muted"}>
              {a.assetId.slice(-6)} {human(a.label).padEnd(16)} ({f1(a.x)}, {f1(a.y)}) {a.observations} obs, {a.sources.join("+")}
            </div>
          ))}
          {r.path.map((p) => (
            <div key={p.captureId} className="text-dim">
              #{p.seq} {p.reason.padEnd(9)} ({f1(p.x)}, {f1(p.y)}) {p.perceptionState.toLowerCase().replace(/_/g, " ")}, sim vis {p.simulated ? pct(p.simulated.visibility, 0) : "n/a"}, image {p.imageVisibility !== null ? pct(p.imageVisibility, 0) : "n/a"}
            </div>
          ))}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {mission?.id === r.mission.id && (
          <Btn onClick={replay} title="Same plan, same scenario, same seed: the twin reproduces the run. Not recorded as a new inspection.">
            <RotateCcw size={14} /> Replay on twin
          </Btn>
        )}
        <span className="text-[10px] leading-snug text-dim">{r.disclaimers[0]}</span>
      </div>
      <History />
    </div>
  );
}
