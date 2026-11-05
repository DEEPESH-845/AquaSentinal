"use client";

import clsx from "clsx";
import { ClipboardList, Lock, Printer } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { api } from "@/lib/api/client";
import type { InspectionReport, WorkOrder, WorkOrderPriority, WorkOrdersResponse } from "@/lib/api/types";
import { useMissionStore } from "@/lib/store/mission";
import { FALLBACK_TAG } from "./ask";
import { ExecTag } from "./intelligence";
import { LANGUAGES } from "./mission";
import { Btn, HindiNeedsMeta, Segmented, f1 } from "./shared";

const PRIORITY: Record<WorkOrderPriority, { word: string; tone: string; edge: string }> = {
  P1: { word: "Act first", tone: "border-danger/70 text-danger", edge: "border-l-danger" },
  P2: { word: "Plan it", tone: "border-amber/70 text-amber", edge: "border-l-amber" },
  P3: { word: "Routine check", tone: "border-cyan/70 text-cyan", edge: "border-l-cyan" },
};
/** "muse-spark-1.3" as the tag reads everywhere else: MUSE SPARK 1.3. The model name comes from the response, never from a constant. */
const modelTag = (model: string | null | undefined) => (model ?? "muse spark").replace(/-/g, " ").toUpperCase();
const EFFORT: Record<WorkOrder["effort"], string> = { S: "under an hour", M: "a few hours", L: "a day or more" };

/** A stored frame of this mission, small. A capture the report does not list, or a frame that fails to load, shows its id alone. */
function Evidence({ id, report, className }: { id: string; report: InspectionReport; className?: string }) {
  const [broken, setBroken] = useState(false);
  const point = report.path.find((p) => p.captureId === id);
  return (
    <span className={clsx("inline-flex items-center gap-1", className)} title={id} data-testid="workorder-evidence" data-capture={id}>
      {point && !broken && (
        // eslint-disable-next-line @next/next/no-img-element -- a few-KB stored frame from the backend; next/image would route it through the app server
        <img src={api.frameUrl(id)} alt="" width={40} height={30} onError={() => setBroken(true)} className="h-[30px] w-10 shrink-0 border border-line object-cover" />
      )}
      <span className="value text-[10px] text-dim">{point ? `#${point.seq}` : id.slice(-6)}</span>
    </span>
  );
}

function OrderCard({ o, report, lang }: { o: WorkOrder; report: InspectionReport; lang?: string }) {
  const p = PRIORITY[o.priority];
  return (
    <li className={clsx("min-w-0 border border-line border-l-[3px] bg-panel-2/40 px-2.5 py-2", p.edge)} data-testid="workorder" data-id={o.id} data-priority={o.priority}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={clsx("sim-tag whitespace-nowrap", p.tone)} title={p.word}>
          {o.priority}
        </span>
        <span className="value text-[10px] text-dim">{o.id}</span>
        <span className="value ml-auto text-[10px] text-muted" title={`Effort ${o.effort}: ${EFFORT[o.effort]}`}>
          effort {o.effort}
        </span>
      </div>
      <h4 lang={lang} className="mt-1 text-[12px] font-medium leading-snug text-text">
        {o.title}
      </h4>
      <p className="value mt-0.5 text-[10px] text-muted">
        ({f1(o.location.x)}, {f1(o.location.y)}) cm
      </p>
      <p lang={lang} className="mt-1 text-[11px] leading-snug text-text">
        {o.action}
      </p>
      <p lang={lang} className="mt-0.5 text-[10px] leading-snug text-dim">
        {o.rationale}
      </p>
      {o.evidence.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-1">
          {o.evidence.map((id) => (
            <Evidence key={id} id={id} report={report} />
          ))}
        </div>
      )}
    </li>
  );
}

/** Who wrote the list, from the response alone: a Meta list carries its logged execution class, a locked backend reads as locked, a missing key as offline rules. */
function Provenance({ r }: { r: WorkOrdersResponse }) {
  if (r.provider === "MUSE_SPARK") {
    return (
      <span className="flex flex-wrap items-center gap-1" data-testid="workorders-badges">
        <span className="sim-tag whitespace-nowrap border-teal! text-teal!">{modelTag(r.model)}</span>
        {r.classification && <ExecTag c={r.classification} />}
      </span>
    );
  }
  const why = r.fallback ? FALLBACK_TAG[r.fallback] : null;
  const locked = r.fallback === "LIVE_LOCKED";
  return (
    <span className="flex flex-wrap items-center gap-1" data-testid="workorders-badges">
      {locked && why && (
        <span className={clsx("sim-tag inline-flex items-center gap-1 whitespace-nowrap", why.tone)}>
          <Lock size={9} aria-hidden /> {why.text}
        </span>
      )}
      <span className={clsx("sim-tag whitespace-nowrap", !locked && "border-amber/60! text-amber!")}>OFFLINE RULES</span>
      {!locked && why?.text && <span className={clsx("sim-tag whitespace-nowrap", why.tone)}>{why.text}</span>}
    </span>
  );
}

/** Who will write the next list, before it is asked for. Unknown is grey; a locked backend says locked. */
function Writer() {
  const provider = useMissionStore((s) => s.system?.providers.spark);
  const spark = provider?.status;
  if (!spark) return <span className="sim-tag whitespace-nowrap opacity-70" data-testid="workorders-writer" data-status="UNKNOWN">WRITER UNKNOWN</span>;
  if (spark === "LIVE")
    return (
      <span className="sim-tag whitespace-nowrap border-teal! text-teal!" data-testid="workorders-writer" data-status="LIVE" title="Muse Spark writes the orders from this mission's stored records, as structured output">
        {modelTag(provider?.model)}
      </span>
    );
  if (spark === "LIVE_LOCKED")
    return (
      <span className="sim-tag inline-flex items-center gap-1 whitespace-nowrap border-amber/60! text-amber!" data-testid="workorders-writer" data-status="LIVE_LOCKED" title="Live mode is locked: enter the passcode (AI chip, top bar) for Muse Spark. The offline rules write the orders meanwhile.">
        <Lock size={9} aria-hidden /> LIVE LOCKED
      </span>
    );
  return (
    <span className="sim-tag whitespace-nowrap border-amber/60! text-amber!" data-testid="workorders-writer" data-status="OFFLINE" title="No MODEL_API_KEY on the backend: a rule table writes the orders from the stored records">
      OFFLINE RULES
    </span>
  );
}

/**
 * The paper copy: one order per page, black on white, with the frames that show the finding. A direct child of body (a portal),
 * hidden on screen; the print rules in globals.css hide everything else while it exists. It stays mounted so its frames are loaded
 * by the time the print dialog opens.
 */
function PrintSheet({ r, report, lang }: { r: WorkOrdersResponse; report: InspectionReport; lang?: string }) {
  if (typeof document === "undefined") return null;
  const writer = r.provider === "MUSE_SPARK" ? `${r.model ?? "Muse Spark"} (${(r.classification ?? "unlogged").replace(/_/g, " ").toLowerCase()})` : "offline rules, no model";
  return createPortal(
    <div className="wo-print" data-testid="workorders-print">
      {r.orders.map((o, i) => (
        <section key={o.id} className="wo-page" data-testid="workorder-page" lang={lang}>
          <p className="wo-head">
            <span className="wo-pri">{o.priority}</span> {o.id} <span className="wo-sub">of {r.orders.length} / mission {report.mission.id}</span>
          </p>
          <h1>{o.title}</h1>
          <dl>
            <dt>Location</dt>
            <dd>
              ({f1(o.location.x)}, {f1(o.location.y)}) cm from the gantry home corner
            </dd>
            <dt>Effort</dt>
            <dd>
              {o.effort}: {EFFORT[o.effort]}
            </dd>
            <dt>Priority</dt>
            <dd>
              {o.priority}: {PRIORITY[o.priority].word.toLowerCase()}
            </dd>
            <dt>Action</dt>
            <dd>{o.action}</dd>
            <dt>Why</dt>
            <dd>{o.rationale}</dd>
          </dl>
          {o.evidence.length > 0 && (
            <div className="wo-evidence">
              {o.evidence.map((id) => {
                const point = report.path.find((p) => p.captureId === id);
                return (
                  <figure key={id}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- print copy of a stored frame */}
                    {point && <img src={api.frameUrl(id)} alt="" width={200} height={150} />}
                    <figcaption>
                      {point ? `capture #${point.seq}, ` : ""}
                      {id}
                    </figcaption>
                  </figure>
                );
              })}
            </div>
          )}
          <p className="wo-sign">Completed by ____________________ Date ______________ Signed ____________________</p>
          <p className="wo-foot">
            Written by {writer}. Item {i + 1} of {r.orders.length}. {report.disclaimers[0]} Verify on site before acting.
          </p>
        </section>
      ))}
    </div>,
    document.body,
  );
}

/** Work orders for the shown report's mission: what a crew should do about its findings, each resting on stored captures. */
export function WorkOrdersCard({ report }: { report: InspectionReport }) {
  const { view, language, spark } = useMissionStore(
    useShallow((s) => ({ view: s.workOrders[report.mission.id], language: s.language, spark: s.system?.providers.spark.status })),
  );
  const { generate, setLanguage } = useMissionStore(useShallow((s) => ({ generate: s.generateWorkOrders, setLanguage: s.setLanguage })));
  const pending = view?.status === "PENDING";
  const r = view?.response;
  const lang = r?.provider === "MUSE_SPARK" && r.language === "hi" ? "hi" : undefined;
  return (
    <section className="mt-4 border-t border-line-strong pt-3" aria-labelledby="wo-title" data-testid="workorders-panel" data-status={view?.status ?? "IDLE"} data-provider={r?.provider}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 id="wo-title" className="font-sans text-[16px] leading-tight text-text">
          Work orders
        </h3>
        <Writer />
      </div>
      <p className="mt-1 text-[11px] leading-snug text-muted">One job per finding, each resting on the captures that show it. The objects are unverified visual observations: a crew verifies on site before acting.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Btn primary onClick={() => void generate()} disabled={pending} testId="workorders-generate" label={r ? "Regenerate work orders" : "Generate work orders"}>
          <ClipboardList size={14} /> {pending ? "Writing" : r ? "Regenerate" : "Generate work orders"}
        </Btn>
        <Btn onClick={() => window.print()} disabled={!r || r.orders.length === 0} testId="workorders-print-button" label="Print work orders" title={r?.orders.length ? "Prints one order per page" : "Generate the work orders first"}>
          <Printer size={14} /> Print work orders
        </Btn>
        <Segmented label="Work order language" options={LANGUAGES} value={language} onChange={setLanguage} />
        {/* one label: it speaks for the list on screen, or for the next one when there is none yet */}
        <HindiNeedsMeta offline={r ? r.provider !== "MUSE_SPARK" : spark !== "LIVE"} />
      </div>
      <span className="sr-only" role="status">
        {pending ? "Writing the work orders" : r ? `${r.orders.length} work order${r.orders.length === 1 ? "" : "s"} ready` : ""}
      </span>
      {view?.status === "FAILED" && <p className="mt-1 text-[11px] text-danger">{view.error ?? "The work orders could not be written."}</p>}
      {r && (
        <div className="mt-2" data-testid="workorders-list">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span className="label text-dim">
              {r.orders.length} order{r.orders.length === 1 ? "" : "s"}
            </span>
            <span className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
              <Provenance r={r} />
            </span>
          </div>
          {r.orders.length > 0 && (
            <ol className="mt-1.5 grid grid-cols-2 gap-2 max-[759px]:grid-cols-1">
              {r.orders.map((o) => (
                <OrderCard key={o.id} o={o} report={report} lang={lang} />
              ))}
            </ol>
          )}
          {r.note && r.fallback !== "NO_KEY" && <p className="mt-1 text-[10px] leading-snug text-dim">{r.note}</p>}
          <p className="value mt-1 text-[10px] leading-snug text-dim">
            {r.provider === "MUSE_SPARK" ? "written from the stored tracks" : "written from the rule table"}
            {r.executionIds.length > 0 && ` / ${r.executionIds.length} Meta request${r.executionIds.length === 1 ? "" : "s"} logged`}
            {r.droppedOrders > 0 && (
              <span className="text-amber">
                {" "}
                / {r.droppedOrders} order{r.droppedOrders === 1 ? "" : "s"} dropped
                {r.droppedEvidence.length > 0 && `: ${r.droppedEvidence.length} cited capture${r.droppedEvidence.length === 1 ? "" : "s"} no record holds`}
              </span>
            )}
          </p>
          <PrintSheet r={r} report={report} lang={lang} />
        </div>
      )}
    </section>
  );
}
