"use client";

import clsx from "clsx";
import { Lock, Send } from "lucide-react";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { gsap, useGsap } from "@/lib/animations/gsap";
import { prefersReducedMotion } from "@/lib/animations/motion";
import { api } from "@/lib/api/client";
import type { AskCitation, AskFallback, AskResponse, InspectionReport } from "@/lib/api/types";
import { useSimStore } from "@/lib/sim/store";
import { useMissionStore, type AskView } from "@/lib/store/mission";
import { ExecTag } from "./intelligence";
import { LANGUAGES, VoiceButton } from "./mission";
import { Btn, HindiNeedsMeta, Segmented, SourceTag, f1, human } from "./shared";

const SUGGESTED = ["Where is the loose cable?", "How many objects were found?", "How confident is the detection?"];
/** A citation points at the twin object of its class nearest to its position, if one lies this close (gantry cm). */
const NEAREST_OBJECT_CM = 15;

/**
 * Selection and camera for a citation, through the store actions the Gantry card's "Centre on" chips already use: the twin
 * object nearest the cited position is selected and the carriage drives to it under the follow camera. While a mission runs the
 * carriage is left alone (stopping it would abort the mission): the object is only selected and the overview camera shows it.
 */
export function focusCitation(c: AskCitation) {
  const s = useSimStore.getState();
  const type = c.label.toUpperCase();
  const near = s.scenario.objects
    .filter((o) => o.type === type)
    .map((o) => ({ o, d: Math.hypot(o.x - c.x, o.y - c.y) }))
    .filter(({ d }) => d <= NEAREST_OBJECT_CM)
    .sort((a, b) => a.d - b.d)[0]?.o;
  const running = s.mode === "MISSION";
  if (near) {
    if (running) s.selectObject(near.id);
    else s.trackObject(near.id);
  } else if (!running) {
    s.moveGantryTo(Math.round(c.x * 10) / 10, Math.round(c.y * 10) / 10);
  }
  s.setCameraPreset(running ? "B" : "D");
}

const FALLBACK_TAG: Record<AskFallback, { text: string; tone: string }> = {
  LIVE_LOCKED: { text: "LIVE LOCKED", tone: "border-amber/60! text-amber!" },
  NO_KEY: { text: "", tone: "" },
  BUDGET_EXCEEDED: { text: "BUDGET REACHED", tone: "border-amber/60! text-amber!" },
  LIVE_META_FAILED: { text: "LIVE CALL FAILED", tone: "border-danger/70! text-danger!" },
  NO_ANSWER: { text: "NO GROUNDED ANSWER", tone: "border-amber/60! text-amber!" },
};

/** Who answered, from the response alone. A locked backend reads as locked, a missing key as offline, and a Meta answer carries its logged execution class. */
function AnswerBadges({ r }: { r: AskResponse }) {
  if (r.provider === "MUSE_SPARK") {
    return (
      <span className="flex flex-wrap items-center gap-1" data-testid="ask-badges">
        <SourceTag source="MUSE_SPARK" />
        {r.classification && <ExecTag c={r.classification} />}
      </span>
    );
  }
  const why = r.fallback ? FALLBACK_TAG[r.fallback] : null;
  const locked = r.fallback === "LIVE_LOCKED";
  return (
    <span className="flex flex-wrap items-center gap-1" data-testid="ask-badges">
      {locked && why && (
        <span className={clsx("sim-tag inline-flex items-center gap-1 whitespace-nowrap", why.tone)}>
          <Lock size={9} aria-hidden /> {why.text}
        </span>
      )}
      <span className={clsx("sim-tag whitespace-nowrap", !locked && "border-amber/60! text-amber!")}>{locked ? "RECORDS QUERY" : "OFFLINE RECORDS QUERY"}</span>
      {!locked && why?.text && <span className={clsx("sim-tag whitespace-nowrap", why.tone)}>{why.text}</span>}
    </span>
  );
}

/** Who will answer the next question, before it is asked. Unknown is grey; a locked backend says locked. */
function Answerer() {
  const spark = useMissionStore((s) => s.system?.providers.spark.status);
  if (!spark) return <span className="sim-tag whitespace-nowrap opacity-70" data-testid="ask-answerer" data-status="UNKNOWN">ANSWERER UNKNOWN</span>;
  if (spark === "LIVE")
    return (
      <span className="sim-tag whitespace-nowrap border-teal! text-teal!" data-testid="ask-answerer" data-status="LIVE" title="Muse Spark answers through read-only tools over this mission's records">
        MUSE SPARK 1.3 + TOOLS
      </span>
    );
  if (spark === "LIVE_LOCKED")
    return (
      <span className="sim-tag inline-flex items-center gap-1 whitespace-nowrap border-amber/60! text-amber!" data-testid="ask-answerer" data-status="LIVE_LOCKED" title="Live mode is locked: enter the passcode (AI chip, top bar) for Muse Spark. The offline records query answers meanwhile.">
        <Lock size={9} aria-hidden /> LIVE LOCKED
      </span>
    );
  return (
    <span className="sim-tag whitespace-nowrap border-amber/60! text-amber!" data-testid="ask-answerer" data-status="OFFLINE" title="No MODEL_API_KEY on the backend: the offline records query answers where, how many, what and confidence questions">
      OFFLINE RECORDS QUERY
    </span>
  );
}

/**
 * The answer text with its `[n]` markers, revealed left to right. Animation only: the response has already arrived. The whole
 * text is in the DOM from the first frame (the unrevealed tail is transparent), so nothing reflows and assistive technology
 * reads the answer at once. A remount, or reduced motion, shows it complete.
 */
function Reveal({ text, lang, instant, onDone }: { text: string; lang?: string; instant: boolean; onDone: () => void }) {
  const [shown, setShown] = useState(() => (instant || prefersReducedMotion() ? text.length : 0));
  useGsap(() => {
    if (shown >= text.length) {
      if (!instant) onDone();
      return;
    }
    const at = { n: 0 };
    gsap.to(at, {
      n: text.length,
      duration: Math.min(1.8, 0.4 + text.length * 0.012),
      ease: "none",
      onUpdate: () => setShown(Math.floor(at.n)),
      onComplete: () => {
        setShown(text.length);
        onDone();
      },
    });
  }, [text]);

  const tokens = text
    .split(/(\[\d+\])/)
    .filter(Boolean)
    .reduce<Array<{ tok: string; start: number }>>((acc, tok) => [...acc, { tok, start: acc.length ? acc[acc.length - 1].start + acc[acc.length - 1].tok.length : 0 }], []);
  return (
    <p lang={lang} className="text-[12px] leading-snug text-text" data-testid="ask-answer-text">
      {tokens.map(({ tok, start }, i) => {
        const marker = /^\[\d+\]$/.test(tok);
        const seen = Math.max(0, Math.min(tok.length, shown - start));
        if (marker) return <sup key={i} className={clsx("value mx-px text-[9px] text-teal", seen < tok.length && "opacity-0")}>{tok}</sup>;
        return (
          <span key={i}>
            {tok.slice(0, seen)}
            <span className="opacity-0">{tok.slice(seen)}</span>
          </span>
        );
      })}
    </p>
  );
}

function CitationChip({ n, c, report }: { n: number; c: AskCitation; report: InspectionReport }) {
  const [broken, setBroken] = useState(false);
  // the stored frame of a capture this report lists; a citation for anything else shows its label without a thumbnail
  const point = report.path.find((p) => p.captureId === c.captureId);
  const where = `(${f1(c.x)}, ${f1(c.y)}) cm`;
  return (
    <button
      type="button"
      data-testid="ask-citation"
      data-capture={c.captureId}
      onClick={() => focusCitation(c)}
      aria-label={`Citation ${n}: ${human(c.label)}${point ? `, capture ${point.seq}` : ""}, at ${where}. Show it in the twin.`}
      title={`${c.captureId}\nShow it in the twin`}
      className="flex min-w-0 max-w-full items-center gap-1.5 border border-line bg-ground/40 py-0.5 pr-2 pl-0.5 text-left transition-colors duration-150 hover:border-teal"
    >
      {point && !broken && (
        // eslint-disable-next-line @next/next/no-img-element -- a few-KB stored frame from the backend; next/image would route it through the app server
        <img src={api.frameUrl(c.captureId)} alt="" width={40} height={30} loading="lazy" onError={() => setBroken(true)} className="h-[30px] w-10 shrink-0 border border-line object-cover" />
      )}
      <span className="value shrink-0 text-[10px] text-teal">[{n}]</span>
      <span className="truncate text-[11px] text-text">{human(c.label)}</span>
      <span className="value shrink-0 text-[10px] text-dim">
        {point ? `#${point.seq} ` : ""}
        {where}
      </span>
    </button>
  );
}

function Answer({ a, report }: { a: AskView; report: InspectionReport }) {
  const markRevealed = useMissionStore((s) => s.markAskRevealed);
  const r = a.response;
  return (
    <li className="border-t border-line py-2" data-testid="ask-answer" data-status={a.status} data-provider={r?.provider} data-fallback={r?.fallback ?? undefined}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 flex-1 text-[11px] leading-snug text-muted">
          <span className="label mr-1.5 text-dim">Q</span>
          {a.question}
        </p>
        {r && (
          <span className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
            <HindiNeedsMeta offline={r.provider !== "MUSE_SPARK"} />
            <AnswerBadges r={r} />
          </span>
        )}
      </div>
      {a.status === "PENDING" && <p className="value mt-1 animate-pulse text-[11px] text-muted motion-reduce:animate-none">Reading the records...</p>}
      {a.status === "FAILED" && <p className="mt-1 text-[11px] text-danger">{a.error ?? "The question could not be answered."}</p>}
      {r && (
        <div className="mt-1">
          <Reveal text={r.answer} lang={r.provider === "MUSE_SPARK" && r.language === "hi" ? "hi" : undefined} instant={a.revealed} onDone={() => markRevealed(a.id)} />
          {r.note && r.fallback !== "NO_KEY" && <p className="mt-1 text-[10px] leading-snug text-dim">{r.note}</p>}
          {r.citations.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {r.citations.map((c, i) => (
                <CitationChip key={c.captureId} n={i + 1} c={c} report={report} />
              ))}
            </div>
          )}
          <p className="value mt-1 text-[10px] leading-snug text-dim">
            {r.toolCalls.length > 0 ? (
              <>
                tools: {r.toolCalls.map((t) => t.name).join(", ")}
                {r.toolCalls.some((t) => !t.ok) && <span className="text-amber"> ({r.toolCalls.filter((t) => !t.ok).length} refused)</span>}
              </>
            ) : (
              "no tools called"
            )}
            {r.executionIds.length > 0 && ` / ${r.executionIds.length} Meta request${r.executionIds.length === 1 ? "" : "s"} logged`}
            {r.droppedCitations.length > 0 && <span className="text-amber"> / {r.droppedCitations.length} uncited id{r.droppedCitations.length === 1 ? "" : "s"} dropped</span>}
          </p>
        </div>
      )}
    </li>
  );
}

/** "Ask the inspector": grounded questions about the shown report's mission. Muse Spark reads the stored records through tools; offline, a records query answers. */
export function AskCard({ report }: { report: InspectionReport }) {
  const { draft, asks, backend, spark, language } = useMissionStore(
    useShallow((s) => ({ draft: s.askDraft, asks: s.asks, backend: s.backend, spark: s.system?.providers.spark.status, language: s.language })),
  );
  const { setDraft, ask, setLanguage } = useMissionStore(useShallow((s) => ({ setDraft: s.setAskDraft, ask: s.ask, setLanguage: s.setLanguage })));
  const mine = asks.filter((a) => a.missionId === report.mission.id).reverse();
  const pending = asks.some((a) => a.status === "PENDING");
  const ready = draft.trim().length >= 3 && !pending && backend !== "OFFLINE";
  const send = (q: string) => void ask(q);
  return (
    <section className="mt-4 border-t border-line-strong pt-3" aria-labelledby="ask-title" data-testid="ask-panel">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 id="ask-title" className="font-sans text-[16px] leading-tight text-text">
          Ask the inspector
        </h3>
        <Answerer />
      </div>
      <p className="mt-1 text-[11px] leading-snug text-muted">Answers come from this mission&apos;s stored records. Every claim links to the capture it rests on; click one to see it in the twin.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label htmlFor="ask-input" className="sr-only">
          Question about this mission
        </label>
        <input
          id="ask-input"
          type="text"
          maxLength={500} // the backend's limit
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && ready) send(draft);
          }}
          placeholder="Ask about this mission, e.g. where is the loose cable?"
          className="min-w-[min(100%,14rem)] flex-1 border border-line-strong bg-panel-2 px-2 py-1.5 text-[12px] leading-snug text-text outline-none placeholder:text-dim focus:border-teal"
        />
        <VoiceButton target="ask" />
        <Btn primary onClick={() => send(draft)} disabled={!ready} label="Ask">
          <Send size={14} /> {pending ? "Asking" : "Ask"}
        </Btn>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="label">Answer language</span>
        <Segmented label="Answer language" options={LANGUAGES} value={language} onChange={setLanguage} />
        <HindiNeedsMeta offline={spark !== "LIVE"} />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Suggested questions">
        {SUGGESTED.map((q) => (
          <button
            key={q}
            type="button"
            data-testid="ask-suggestion"
            disabled={pending || backend === "OFFLINE"}
            onClick={() => send(q)}
            className="border border-line px-2 py-[3px] text-left text-[11px] text-muted transition-colors duration-150 hover:border-teal hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
          >
            {q}
          </button>
        ))}
      </div>
      {backend === "OFFLINE" && <p className="mt-1 text-[11px] text-amber">Backend offline: questions are answered from the records it stores.</p>}
      <span className="sr-only" role="status">
        {pending ? "Reading the records" : ""}
      </span>
      {mine.length > 0 && (
        <ol className="mt-2" data-testid="ask-answers">
          {mine.map((a) => (
            <Answer key={a.id} a={a} report={report} />
          ))}
        </ol>
      )}
    </section>
  );
}
