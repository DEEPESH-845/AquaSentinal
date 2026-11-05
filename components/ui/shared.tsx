"use client";

import clsx from "clsx";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { gsap } from "@/lib/animations/gsap";
import { DUR, EASE, prefersReducedMotion } from "@/lib/animations/motion";
import { useSimStore } from "@/lib/sim/store";
import type { DetectedClass } from "@/lib/sim/types";
import { useMissionStore } from "@/lib/store/mission";

export const f1 = (n: number) => n.toFixed(1);
export const f2 = (n: number) => n.toFixed(2);
export const pct = (n: number, d = 1) => (n * 100).toFixed(d) + "%";
export const signed = (n: number, d = 2) => (n >= 0 ? "+" : "") + n.toFixed(d);
export const pad2 = (n: number) => String(Math.max(0, Math.floor(n))).padStart(2, "0");
export const clampNum = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

/** Amber for anomaly candidates (what an inspection is looking for), teal for infrastructure and everything else. */
export const isTargetClass = (c: DetectedClass | string) => c === "LOOSE_CABLE" || c === "FOREIGN_OBJECT" || c === "loose_cable" || c === "foreign_object";

/** Human label for a class or target string: LOOSE_CABLE / loose_cable -> loose cable. */
export const human = (c: string) => c.toLowerCase().replace(/_/g, " ");

export type Source = "SIMULATED" | "MUSE_SPARK" | "SAM_3_1" | "VOICE" | "OFFLINE" | "SIM_DETECTOR" | "IMAGE_DERIVED" | "TWIN_TRUTH" | "TEMPLATE" | "OPERATOR";

const SOURCE_TEXT: Record<Source, string> = {
  SIMULATED: "SIMULATED",
  MUSE_SPARK: "MUSE SPARK 1.3",
  SAM_3_1: "SAM 3.1",
  VOICE: "MUSE VOICE TRANSCRIBE",
  OFFLINE: "OFFLINE FALLBACK",
  SIM_DETECTOR: "SIM DETECTOR",
  IMAGE_DERIVED: "IMAGE-DERIVED ESTIMATE",
  TWIN_TRUTH: "TWIN GEOMETRY, NOT A MODEL",
  TEMPLATE: "TEMPLATE FROM RECORDS",
  OPERATOR: "OPERATOR",
};

/** Provenance tag. Model outputs are teal-bordered, fallbacks and simulated values neutral, so the source is never ambiguous. */
export function SourceTag({ source, className }: { source: Source; className?: string }) {
  const model = source === "MUSE_SPARK" || source === "SAM_3_1" || source === "VOICE";
  return <span className={clsx("sim-tag whitespace-nowrap", model && "border-teal! text-teal!", source === "OFFLINE" && "border-amber/60! text-amber!", className)}>{SOURCE_TEXT[source]}</span>;
}

/** Maps backend provider strings onto a SourceTag. */
export const providerSource = (p: string | null | undefined): Source =>
  p === "MUSE_SPARK" ? "MUSE_SPARK" : p === "SAM_3_1" ? "SAM_3_1" : p === "OPERATOR" ? "OPERATOR" : p === "TEMPLATE_FROM_RECORDS" ? "TEMPLATE" : p === "OFFLINE_FIXTURE" ? "TWIN_TRUTH" : p === "SIM_DETECTOR" ? "SIM_DETECTOR" : "OFFLINE";

/**
 * Beside output that did not come from a Meta model, while Hindi is selected: offline parsers and templates are English only
 * and are never machine-translated. `offline` is true for anything but a live Meta answer (no key, locked, template, fallback).
 */
export function HindiNeedsMeta({ offline, className }: { offline: boolean; className?: string }) {
  const hindi = useMissionStore((s) => s.language === "hi");
  if (!hindi || !offline) return null;
  return (
    <span data-testid="hindi-needs-meta" title="This output is English. Hindi voice, plans and summaries are written by the Meta models." className={clsx("value text-[10px] text-amber", className)}>
      Hindi needs Meta models
    </span>
  );
}

const DOT_BG = { teal: "bg-teal", amber: "bg-amber", danger: "bg-danger", dim: "bg-dim" } as const;

/** Status dot. `pulse` marks a live heartbeat (a dependency answering right now), never a decoration. */
export function Dot({ tone, pulse }: { tone: keyof typeof DOT_BG; pulse?: boolean }) {
  return (
    <span className="relative inline-flex h-1.5 w-1.5 shrink-0">
      {pulse && <span className={clsx("absolute inset-0 animate-ping rounded-full opacity-50 [animation-duration:2.4s]", DOT_BG[tone])} />}
      <span className={clsx("relative inline-block h-1.5 w-1.5 rounded-full", DOT_BG[tone])} />
    </span>
  );
}

/** Object list reference is stable across publishes; positions are read with primitive selectors elsewhere. */
export const useObjects = () => useSimStore((s) => s.scenario.objects);

export function CardHead({ title, note, right }: { title: string; note?: string; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div>
        <h2 className="font-sans text-xl leading-tight text-text">{title}</h2>
        {note && <p className="mt-1 text-[12px] leading-snug text-muted">{note}</p>}
      </div>
      {right}
    </div>
  );
}

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx("label", className)}>{children}</div>;
}

type ChipTone = "neutral" | "teal" | "amber";

export function Chip({
  children,
  tone = "neutral",
  active,
  onClick,
  disabled,
  className,
  title,
}: {
  children: ReactNode;
  tone?: ChipTone;
  active?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  const toneCls =
    tone === "teal" ? "border-teal text-teal" : tone === "amber" ? "border-amber text-amber" : "border-line-strong text-muted";
  const cls = clsx(
    "font-mono text-[10px] tracking-[0.1em] uppercase px-2 py-[3px] border whitespace-nowrap",
    active ? toneCls : "border-line text-muted",
    onClick && !disabled && "cursor-pointer hover:border-teal hover:text-text transition-colors duration-100",
    disabled && "opacity-50 cursor-not-allowed",
    className,
  );
  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick} disabled={disabled} title={title}>
        {children}
      </button>
    );
  }
  return (
    <span className={cls} title={title}>
      {children}
    </span>
  );
}

/** Arrow-separated chain of mono chips: FRAME -> PREPROCESS -> ... */
export function Chain({ items, activeIndex, tone = "teal" }: { items: string[]; activeIndex?: number; tone?: ChipTone }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {items.map((it, i) => (
        <div key={it} className="flex items-center gap-1">
          <Chip tone={tone} active={activeIndex === undefined ? true : activeIndex === i}>
            {it}
          </Chip>
          {i < items.length - 1 && <span className="font-mono text-[10px] text-dim">-&gt;</span>}
        </div>
      ))}
    </div>
  );
}

/** Six object chips. Used by VISION, GANTRY and CONTROL cards to point the camera at any object. */
export function ObjectChips({ onPick, activeId, label }: { onPick: (id: string) => void; activeId: string | null; label?: string }) {
  const objects = useObjects();
  return (
    <div className="flex flex-wrap items-center gap-1">
      {label && <span className="label mr-1">{label}</span>}
      {objects.map((o) => (
        <Chip key={o.id} tone={isTargetClass(o.type) ? "amber" : "teal"} active={activeId === o.id} onClick={() => onPick(o.id)} title={o.id}>
          {o.label}
        </Chip>
      ))}
    </div>
  );
}

export function Btn({
  children,
  onClick,
  primary,
  danger,
  active,
  disabled,
  className,
  title,
  label,
  testId,
}: {
  children: ReactNode;
  onClick: () => void;
  primary?: boolean;
  danger?: boolean;
  active?: boolean;
  disabled?: boolean;
  className?: string;
  title?: string;
  label?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label}
      data-testid={testId}
      className={clsx("btn inline-flex items-center gap-1.5", primary && "btn-primary", danger && "btn-danger", active && "btn-active", className)}
    >
      {children}
    </button>
  );
}

/**
 * Single-choice control. The selection indicator glides to the chosen option (GSAP), so the eye follows the change.
 * Arrow keys move the choice, as a radio group should.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  /** `lang` marks an option written in another language, so assistive tech reads it with the right voice */
  options: Array<{ id: T; text: string; title?: string; lang?: string }>;
  value: T;
  onChange: (v: T) => void;
  label: string;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const ind = useRef<HTMLSpanElement>(null);
  const first = useRef(true);
  useLayoutEffect(() => {
    const btn = root.current?.querySelector<HTMLElement>(`[data-seg="${value}"]`);
    if (!btn || !ind.current) return;
    const to = { x: btn.offsetLeft, width: btn.offsetWidth };
    if (first.current || prefersReducedMotion()) gsap.set(ind.current, to);
    else gsap.to(ind.current, { ...to, duration: DUR.base, ease: EASE.out, overwrite: true });
    first.current = false;
  }, [value, options.length]);
  const move = (d: number) => {
    const i = options.findIndex((o) => o.id === value);
    const next = options[(i + d + options.length) % options.length];
    onChange(next.id);
    root.current?.querySelector<HTMLElement>(`[data-seg="${next.id}"]`)?.focus();
  };
  return (
    <div ref={root} role="radiogroup" aria-label={label} className={clsx("relative inline-flex border border-line bg-ground/40 p-px", className)}>
      <span ref={ind} className="pointer-events-none absolute bottom-px left-0 top-px border border-teal/70 bg-teal/10" aria-hidden />
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          tabIndex={o.id === value ? 0 : -1}
          data-seg={o.id}
          lang={o.lang}
          title={o.title}
          onClick={() => onChange(o.id)}
          onKeyDown={(e) => {
            const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
            if (!d) return;
            e.preventDefault();
            e.stopPropagation();
            move(d);
          }}
          className={clsx("relative px-2 py-[3px] font-mono text-[10px] uppercase transition-colors duration-200", o.lang ? "tracking-normal" : "tracking-[0.1em]", o.id === value ? "text-teal" : "text-muted hover:text-text")}
        >
          {o.text}
        </button>
      ))}
    </div>
  );
}
