"use client";

import clsx from "clsx";
import { motion } from "framer-motion";
import { CircleDollarSign, Lock, LockOpen, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Credits, SavedReason } from "@/lib/api/types";
import { useMissionStore } from "@/lib/store/mission";
import { Btn, Dot } from "./shared";

/** Header credit meter and the live-mode unlock dialog. Every number comes from the backend's credit governor, none is computed here. */

export type CreditState = "UNKNOWN" | "NO_KEY" | "OK" | "WARN" | "EXHAUSTED";

const WARN_AT = 0.8;

/** Spent as a share of the budget, 0 to 1. A zero budget refuses every call, so it counts as full. */
export const creditFraction = (c: Credits) => (c.budgetUsd > 0 ? Math.min(1, Math.max(0, c.spentUsd / c.budgetUsd)) : 1);

/** Grey with no key, red when nothing is left, amber above 80 percent of the budget. */
export function creditState(known: boolean, keyed: boolean, c: Credits | undefined): CreditState {
  if (!known || !c) return "UNKNOWN";
  if (!keyed) return "NO_KEY";
  if (c.remainingUsd <= 0) return "EXHAUSTED";
  return creditFraction(c) > WARN_AT ? "WARN" : "OK";
}

/** A fraction of a cent is shown as such instead of rounding to $0.000, which would read as nothing spent. */
export const usd = (n: number, dp = 3) => (n > 0 && n < 0.5 * 10 ** -dp ? `<$${(10 ** -dp).toFixed(dp)}` : `$${n.toFixed(dp)}`);

// text colours carry `!`: the .label utility sets its own colour and would otherwise win
const TONE: Record<CreditState, { text: string; bar: string; border: string }> = {
  UNKNOWN: { text: "text-dim!", bar: "bg-dim", border: "hover:border-line-strong" },
  NO_KEY: { text: "text-dim!", bar: "bg-dim", border: "hover:border-line-strong" },
  OK: { text: "text-teal!", bar: "bg-teal", border: "hover:border-teal/60" },
  WARN: { text: "text-amber!", bar: "bg-amber", border: "border-amber/50! hover:border-amber" },
  EXHAUSTED: { text: "text-danger!", bar: "bg-danger", border: "border-danger/60! hover:border-danger" },
};

/** Spoken form of the state, first in the chip's accessible name so it is not left to colour alone. */
const STATE_ARIA: Record<CreditState, string> = { UNKNOWN: "unknown", NO_KEY: "no key", OK: "within budget", WARN: "warning, over 80 percent", EXHAUSTED: "cap reached" };

const STATE_TAG: Record<CreditState, string> = { UNKNOWN: "UNKNOWN", NO_KEY: "NO KEY", OK: "WITHIN BUDGET", WARN: "OVER 80%", EXHAUSTED: "CAP REACHED" };

/** What each skipped-call counter means, in the words an operator needs. */
const SAVED_TEXT: Record<SavedReason, string> = {
  duplicate: "Duplicate frame, earlier result reused",
  unusable_quality: "Frame too poor to analyse",
  not_candidate: "Re-check with no candidate in view",
  cache_hit: "Identical request, cached answer",
  budget: "Refused by the budget cap",
};

const SAVED_ORDER: SavedReason[] = ["cache_hit", "duplicate", "unusable_quality", "not_candidate", "budget"];

/** The one credit selector the chip, its popover and later panels share. */
export function useCredits() {
  return useMissionStore(
    useShallow((s) => {
      const c = s.system?.credits;
      const keyed = !!s.system && s.system.providers.spark.status !== "OFFLINE";
      return { credits: c, state: creditState(!!s.system, keyed, c) };
    }),
  );
}

function summary(state: CreditState, c: Credits | undefined) {
  if (!c || state === "UNKNOWN") return "The backend has not answered, so spend is unknown";
  if (state === "NO_KEY") return `No MODEL_API_KEY, so no credits can be spent. Budget cap ${usd(c.budgetUsd, 2)}`;
  return `${usd(c.spentUsd)} of ${usd(c.budgetUsd, 2)} spent (estimate from Meta list prices). ${c.liveCalls} live, ${c.cachedCalls} cached, ${c.saved.total} saved`;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="label whitespace-nowrap text-[9px] text-dim">
        {label} <span className="max-[380px]:sr-only">calls</span>
      </dt>
      <dd className="value mt-0.5 text-[15px] leading-none text-text">{value}</dd>
    </div>
  );
}

function CreditPopover({ id, state, credits: c, lock, onClose, onLock }: { id: string; state: CreditState; credits: Credits | undefined; lock: LiveLock; onClose: () => void; onLock: () => void }) {
  const tone = TONE[state];
  return (
    <div
      id={id}
      role="dialog"
      aria-modal="false"
      aria-label="Credit usage"
      data-testid="credits-popover"
      className="panel bg-panel! pointer-events-auto absolute right-4 top-full z-40 mt-1.5 w-[340px] max-w-[calc(100vw-1.5rem)] p-3.5 max-[439px]:right-3"
    >
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <span className="label text-text">Credits</span>
        <span className="flex items-center gap-1.5">
          <span className={clsx("sim-tag whitespace-nowrap", state === "WARN" && "border-amber/60! text-amber!", state === "EXHAUSTED" && "border-danger/70! text-danger!")} data-testid="credits-state">
            {STATE_TAG[state]}
          </span>
          <button type="button" className="btn btn-icon -my-1 -mr-1" aria-label="Close credit details" onClick={onClose}>
            <X size={12} />
          </button>
        </span>
      </div>

      {lock !== "OPEN" && (
        // The row is shown wherever the header draws no AI chip (locked: below 600 px; unlocked: below 999 px), so the lock can always be changed from here.
        <div className={clsx("mb-3 flex items-center justify-between gap-3 border px-2.5 py-2", lock === "LOCKED" ? "border-amber/40 bg-amber/[0.06] min-[600px]:hidden" : "border-line min-[999px]:hidden")} data-testid="credits-lock-row">
          <span className={clsx("flex items-center gap-1.5 text-[12px] leading-snug", lock === "LOCKED" ? "text-amber" : "text-muted")}>
            {lock === "LOCKED" ? <Lock size={12} aria-hidden /> : <LockOpen size={12} aria-hidden />}
            {lock === "LOCKED" ? "Live mode is locked" : "Live mode is unlocked"}
          </span>
          <Btn onClick={onLock}>{lock === "LOCKED" ? "Unlock" : "Lock"}</Btn>
        </div>
      )}

      {!c || state === "UNKNOWN" ? (
        <p className="text-[12px] leading-snug text-muted">The backend has not answered, so spend is unknown. Nothing is assumed.</p>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <span className={clsx("value text-[22px] leading-none", state === "NO_KEY" ? "text-dim" : "text-text")} data-testid="credits-spent">
              {usd(c.spentUsd, 4)}
            </span>
            <span className="value text-[11px] text-muted">of {usd(c.budgetUsd, 2)} budget</span>
          </div>
          <div className="mt-2 h-[3px] w-full bg-line" role="progressbar" aria-label="Budget spent" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(creditFraction(c) * 100)}>
            <div className={clsx("h-full transition-[width] duration-300", tone.bar)} style={{ width: `${creditFraction(c) * 100}%` }} />
          </div>
          <p className="mt-1.5 text-[11px] leading-snug text-muted">
            {state === "NO_KEY"
              ? "No MODEL_API_KEY is set, so no credit can be spent. The counts below come from the evidence store."
              : state === "EXHAUSTED"
                ? "Budget cap reached: new Meta calls are refused before they are sent."
                : `${usd(c.remainingUsd, 4)} left before the cap refuses new Meta calls.`}
          </p>

          <dl className="mt-3 grid grid-cols-3 gap-x-2 border-t border-line pt-2.5">
            <Stat label="Live" value={c.liveCalls} />
            <Stat label="Cached" value={c.cachedCalls} />
            <Stat label="Saved" value={c.saved.total} />
          </dl>

          <div className="label mb-1 mt-3 text-[9px] text-dim">Saved calls by reason</div>
          <ul className="border-t border-line" data-testid="credits-saved">
            {SAVED_ORDER.map((r) => (
              <li key={r} className="flex items-baseline justify-between gap-3 border-b border-line py-[3px]" data-reason={r}>
                <span className="text-[11px] leading-snug text-muted">{SAVED_TEXT[r]}</span>
                <span className={clsx("value text-[11px]", c.saved.byReason[r] ? "text-text" : "text-dim")}>{c.saved.byReason[r]}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="mt-2.5 text-[10px] leading-snug text-dim">Estimate from Meta list prices, summed over live calls only. Saved counts restart with the backend.</p>
    </div>
  );
}

/**
 * Header credit chip: spent against budget with a thin bar, and a click-open popover with the detail.
 * At 1280 px and up it reads `CREDITS $0.042 / $1.00`; below that it collapses to an icon and the amount, below 520 px to the icon and the bar.
 * The popover carries the lock and unlock button wherever the header draws no AI chip.
 * Tailwind 4 reads `max-[N]` as "narrower than N", so every show and hide pair here uses the same N as its `min-[N]`.
 */
export function CreditChip() {
  const { credits: c, state } = useCredits();
  const lock = useLiveLock();
  const locked = lock === "LOCKED";
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const popId = useId();
  const tone = TONE[state];

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      btn.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!btn.current?.contains(t) && !document.getElementById(popId)?.contains(t)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open, popId]);

  const value = state === "UNKNOWN" ? "UNKNOWN" : state === "NO_KEY" ? "NO KEY" : usd(c!.spentUsd);
  const frac = c && state !== "NO_KEY" && state !== "UNKNOWN" ? creditFraction(c) : 0;
  const wide = state === "UNKNOWN" || state === "NO_KEY" ? null : ` / ${usd(c!.budgetUsd, 2)}`;

  return (
    <>
      <button
        ref={btn}
        type="button"
        data-testid="chip-credits"
        data-state={state}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? popId : undefined}
        aria-label={`Credits ${STATE_ARIA[state]}. ${summary(state, c)}.${locked ? " Live mode is locked." : ""} ${open ? "Hide" : "Show"} details`}
        title={`${summary(state, c)}. Click for details.`}
        onClick={() => setOpen((o) => !o)}
        className={clsx("relative flex min-h-[25px] shrink-0 items-center gap-1.5 border border-line bg-ground/40 px-2 py-1 transition-colors duration-150 max-[520px]:px-1.5", tone.border, open && "border-line-strong bg-panel-2/60")}
      >
        <span className="flex max-[1280px]:hidden">
          <Dot tone={state === "OK" ? "teal" : state === "WARN" ? "amber" : state === "EXHAUSTED" ? "danger" : "dim"} />
        </span>
        {locked && <Lock size={12} className="text-amber! min-[600px]:hidden" aria-hidden />}
        <CircleDollarSign size={12} className={clsx("min-[1280px]:hidden", locked && "max-[600px]:hidden", tone.text)} aria-hidden />
        <span className="label text-text max-[1280px]:hidden">Credits</span>
        <span className={clsx("label text-[9px] whitespace-nowrap max-[520px]:hidden", state === "WARN" || state === "EXHAUSTED" ? tone.text : state === "OK" ? "text-text!" : "text-dim!")} data-testid="credits-value">
          {value}
          {wide && <span className="text-dim max-[1280px]:hidden">{wide}</span>}
        </span>
        <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-line">
          <span className={clsx("block h-full transition-[width] duration-300", tone.bar)} style={{ width: `${frac * 100}%` }} />
        </span>
      </button>
      {open && (
        <CreditPopover
          id={popId}
          state={state}
          credits={c}
          lock={lock}
          onClose={() => {
            setOpen(false);
            btn.current?.focus();
          }}
          onLock={() => {
            // the dialog hands focus back to whoever had it, so that is the chip, not the popover that is about to go
            setOpen(false);
            btn.current?.focus();
            useMissionStore.getState().setUnlockOpen(true);
          }}
        />
      )}
    </>
  );
}

export type LiveLock = "OPEN" | "LOCKED" | "UNLOCKED";

/** Lock state of live mode, from the status the backend returned for this browser. OPEN: the backend has no passcode. */
export function useLiveLock(): LiveLock {
  return useMissionStore((s) => {
    const l = s.system?.live;
    return !l || !l.lockEnabled ? "OPEN" : l.unlocked ? "UNLOCKED" : "LOCKED";
  });
}

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

/**
 * Modal passcode entry. The passcode goes to the backend in the body of POST /api/system/unlock and, once it works, is kept in
 * sessionStorage for this tab and sent as X-Aqua-Passcode. When already unlocked it offers to lock again instead.
 */
export function UnlockDialog() {
  const { setOpen, unlock, relock, notice, blockedUntil } = useMissionStore(
    useShallow((s) => ({ setOpen: s.setUnlockOpen, unlock: s.unlock, relock: s.relock, notice: s.lockNotice, blockedUntil: s.unlockBlockedUntil })),
  );
  const lock = useLiveLock();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const descId = useId();
  const waitS = blockedUntil ? Math.max(0, Math.ceil((blockedUntil - now) / 1000)) : 0;

  // modal: focus moves in on open and back to where it was on close
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    (input.current ?? root.current?.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    return () => prev?.focus?.();
  }, []);

  useEffect(() => {
    if (!waitS) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waitS]);

  const close = () => setOpen(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      } else if (e.key === "Tab") {
        // keep Tab inside the dialog
        const items = [...(root.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code || busy || waitS) return;
    setBusy(true);
    setError(null);
    const r = await unlock(code);
    setBusy(false);
    setNow(Date.now());
    if (!r.ok) {
      // a refusal for too many attempts is shown by the countdown, which ends with it; no message is left behind
      setError(r.blocked ? null : (r.error ?? "That passcode was not accepted."));
      setCode(""); // a rejected guess is not kept in the field
      input.current?.focus();
    }
  };

  const locked = lock === "LOCKED";
  return (
    <motion.div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descId}
      data-testid="unlock-dialog"
      className="pointer-events-auto absolute inset-0 z-[60] flex overflow-y-auto bg-ground/80 p-4 backdrop-blur-[2px]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      onPointerDown={(e) => e.target === e.currentTarget && close()}
    >
      <motion.form
        className="panel m-auto w-full max-w-[400px] p-5 max-[439px]:p-4"
        onSubmit={submit}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
      >
        <div className="mb-2 flex items-start justify-between gap-3">
          <h2 id={titleId} className="flex items-center gap-2 font-sans text-xl leading-tight text-text">
            {locked ? <Lock size={16} className="text-amber" aria-hidden /> : <LockOpen size={16} className="text-teal" aria-hidden />}
            {locked ? "Unlock live mode" : "Live mode is unlocked"}
          </h2>
          <button type="button" className="btn btn-icon -mr-1 -mt-1" aria-label="Close" onClick={close}>
            <X size={14} />
          </button>
        </div>
        <p id={descId} className="text-[12px] leading-snug text-muted">
          {locked
            ? "Meta model calls spend credits, so this backend keeps them behind a passcode. Until it is entered the lab runs on its labelled offline fallbacks. The passcode stays in this tab's session storage and is sent only to the backend."
            : "This tab holds the passcode, so Meta calls are enabled for it. Lock again before handing the screen to someone else."}
        </p>

        {notice && locked && (
          <p className="mt-3 border-l-2 border-amber pl-2 text-[12px] leading-snug text-amber" role="status" data-testid="unlock-notice">
            {notice}
          </p>
        )}

        {locked ? (
          <>
            <label htmlFor={`${titleId}-code`} className="label mb-1 mt-4 block">
              Passcode
            </label>
            <input
              id={`${titleId}-code`}
              ref={input}
              type="password"
              name="aqua-live-passcode"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              maxLength={256}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              readOnly={busy}
              aria-invalid={!!error}
              aria-describedby={error || waitS ? `${titleId}-err` : undefined}
              className="w-full select-text border border-line-strong bg-panel-2 px-2 py-1.5 font-mono text-[13px] text-text outline-none placeholder:text-dim focus:border-teal read-only:opacity-60"
            />
            <div id={`${titleId}-err`} role="alert" className="min-h-[18px] pt-1.5 text-[12px] leading-snug text-danger" data-testid="unlock-error">
              {waitS > 0 ? (
                <span data-testid="unlock-wait">
                  Too many failed attempts. Try again in {waitS} s.
                </span>
              ) : (
                error
              )}
            </div>
            <div className="mt-3 flex items-center justify-end gap-2">
              <Btn onClick={close}>Cancel</Btn>
              <button type="submit" className="btn btn-primary inline-flex items-center gap-1.5" disabled={!code || busy || waitS > 0}>
                <Lock size={14} /> {busy ? "Checking" : "Unlock"}
              </button>
            </div>
          </>
        ) : (
          <div className="mt-4 flex items-center justify-end gap-2">
            <Btn onClick={close}>Keep unlocked</Btn>
            <Btn primary onClick={relock}>
              <Lock size={14} /> Lock live mode
            </Btn>
          </div>
        )}
      </motion.form>
    </motion.div>
  );
}
