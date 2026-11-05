"use client";

import clsx from "clsx";
import { motion } from "framer-motion";
import { Camera, Lock, RotateCcw, Upload, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import { api, ApiError } from "@/lib/api/client";
import type { AskFallback, RealSegment, RealSegmentResponse } from "@/lib/api/types";
import { useMissionStore } from "@/lib/store/mission";
import { C } from "@/lib/theme";
import { FALLBACK_TAG } from "./ask";
import { FOCUSABLE, usd } from "./credits";
import { ExecTag } from "./intelligence";
import { Btn, SourceTag } from "./shared";

/**
 * Real water: one frame from the device camera (or an image file) goes to SAM 3.1 through POST /api/ai/segment-image, and the masks are
 * drawn over the still frame. Nothing here is a mission: no twin, no stored evidence. Without the Meta key (or locked) the shutter
 * still takes the frame and says so, and nothing is drawn.
 */

/** Phrases per shutter; each is one SAM 3.1 request. The backend refuses more (MAX_REAL_PROMPTS). */
const MAX_PROMPTS = 2;
const PROMPT_CHIPS = ["cable", "plastic bottle", "rope", "pipe"];
/** The long side of the frame that is sent, and its JPEG quality. */
const MAX_SIDE = 1024;
const JPEG_QUALITY = 0.85;
const MAX_PROMPT_CHARS = 60; // the backend's limit
const NEEDS_KEY = "SAM 3.1 needs the Meta key";
/** First prompt teal, second amber, as the mission overlays colour targets. */
const SWATCH = [C.teal, C.amber];

/** Size to draw a frame at: never above MAX_SIDE on the long side, never upscaled. */
function fitLongSide(w: number, h: number, max = MAX_SIDE): [number, number] {
  const k = Math.min(1, max / Math.max(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

async function toJpeg(source: CanvasImageSource, sw: number, sh: number): Promise<Blob> {
  const [w, h] = fitLongSide(sw, sh);
  const canvas = Object.assign(document.createElement("canvas"), { width: w, height: h });
  canvas.getContext("2d")!.drawImage(source, 0, 0, w, h);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("the browser could not encode the frame"))), "image/jpeg", JPEG_QUALITY));
}

// ---------------------------------------------------------------- camera

type CamState = { status: "starting" } | { status: "live" } | { status: "unavailable"; reason: string };

/** Why getUserMedia cannot even be tried here. Cameras need a secure context: https, or localhost. */
function blockedReason(): string | null {
  if (!window.isSecureContext) return "The camera needs https or localhost, and this page is on an insecure origin.";
  if (!navigator.mediaDevices?.getUserMedia) return "This browser exposes no camera API.";
  return null;
}

function failureReason(e: unknown): string {
  const name = e instanceof DOMException || e instanceof Error ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Camera permission was denied. Allow it in the browser's site settings and retry.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera was found on this device.";
  if (name === "NotReadableError" || name === "AbortError") return "The camera could not start: another app may be using it.";
  return `The camera could not start (${(e as Error | undefined)?.message || name || "unknown error"}).`;
}

/** The environment-facing camera, attached to the `video` ref it returns and stopped when the panel closes. Live is reported by the video's own `playing` event. */
function useCamera() {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const attempts = useRef(0); // a getUserMedia that resolves after a retry or a close is released, never attached
  // a camera that cannot be tried here (insecure origin, no API) is known from the first render
  const [state, setState] = useState<CamState>(() => {
    const reason = blockedReason();
    return reason ? { status: "unavailable", reason } : { status: "starting" };
  });

  const release = useCallback(() => {
    attempts.current++;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  }, []);

  const open = useCallback(async () => {
    release();
    const attempt = attempts.current;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      if (attempt !== attempts.current) return s.getTracks().forEach((t) => t.stop());
      stream.current = s;
      if (video.current) video.current.srcObject = s;
    } catch (e) {
      if (attempt === attempts.current) setState({ status: "unavailable", reason: failureReason(e) });
    }
  }, [release]);

  useEffect(() => {
    if (blockedReason() === null) void open();
    return release;
  }, [open, release]);

  const retry = () => {
    const reason = blockedReason();
    setState(reason ? { status: "unavailable", reason } : { status: "starting" });
    if (!reason) void open();
  };

  return { video, state, markLive: () => setState({ status: "live" }), retry };
}

// ---------------------------------------------------------------- result

interface Shot {
  url: string;
  blob: Blob;
  status: "SENDING" | "DONE" | "FAILED";
  response?: RealSegmentResponse;
  error?: string;
}

/** Displayed pixels per image pixel, so labels and strokes keep their on-screen size at any panel width. */
function useScale(ref: RefObject<SVGSVGElement | null>, w: number, h: number) {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setScale(Math.max(0.05, Math.min(e.contentRect.width / w, e.contentRect.height / h))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, w, h]);
  return scale;
}

/** SAM 3.1 masks over the still, in the mission-control mask style (translucent fill, solid outline, mono label with a ground halo). */
function Overlay({ r }: { r: RealSegmentResponse }) {
  const ref = useRef<SVGSVGElement>(null);
  const scale = useScale(ref, r.width, r.height);
  const px = (n: number) => n / scale; // screen pixels to image pixels
  return (
    <svg ref={ref} viewBox={`0 0 ${r.width} ${r.height}`} className="absolute inset-0 h-full w-full" aria-hidden data-testid="realcam-overlay">
      {r.segments.flatMap((seg, si) =>
        seg.instances.map((inst, ii) => {
          const color = SWATCH[si % SWATCH.length];
          const [x0, y0] = inst.box;
          return (
            <g key={`${si}-${ii}`} data-testid="realcam-mask" data-prompt={seg.prompt}>
              {inst.polygons.map((poly, pi) => (
                <polygon key={pi} points={poly.map(([x, y]) => `${x},${y}`).join(" ")} fill={color} fillOpacity={0.32} stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
              ))}
              <text
                x={x0 + px(2)}
                y={Math.max(px(13), y0 - px(5))}
                fill={color}
                fontSize={px(11)}
                fontFamily="var(--font-plex-mono)"
                paintOrder="stroke"
                stroke={C.ground}
                strokeWidth={px(3)}
                strokeLinejoin="round"
              >
                {seg.prompt}
                {inst.confidence !== null ? ` ${(inst.confidence * 100).toFixed(0)}%` : ""}
              </text>
            </g>
          );
        }),
      )}
    </svg>
  );
}

const ms = (n: number | null) => (n === null ? "replayed" : `${Math.round(n)} ms`);

function SegmentRow({ s, i }: { s: RealSegment; i: number }) {
  const what =
    s.status === "OK"
      ? `${s.instances.length} mask${s.instances.length === 1 ? "" : "s"}`
      : s.status === "EMPTY"
        ? "no match"
        : s.status === "SKIPPED_BUDGET"
          ? "skipped: budget cap"
          : "request failed";
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 border-b border-line py-[3px]" data-testid="realcam-segment" data-status={s.status}>
      <span aria-hidden className="inline-block h-2 w-2 shrink-0 self-center" style={{ background: SWATCH[i % SWATCH.length] }} />
      <span className="text-[12px] text-text">{s.prompt}</span>
      <span className={clsx("value text-[11px]", s.status === "OK" ? "text-teal" : s.status === "EMPTY" ? "text-muted" : "text-amber")}>{what}</span>
      {(s.status === "OK" || s.status === "EMPTY") && <span className="value ml-auto text-[10px] text-dim">{ms(s.latencyMs)}</span>}
      {s.error && <span className="w-full text-[10px] leading-snug text-danger">{s.error}</span>}
    </li>
  );
}

/** Why no mask came back from a request that was made, from the segments alone: the budget cap, else a failed call. */
const failedWhy = (r: RealSegmentResponse): AskFallback => (r.segments.length > 0 && r.segments.every((s) => s.status === "SKIPPED_BUDGET") ? "BUDGET_EXCEEDED" : "LIVE_META_FAILED");

function Result({ shot, onUnlock }: { shot: Shot; onUnlock: () => void }) {
  const r = shot.response;
  if (shot.status === "SENDING") return <p className="value mt-2 animate-pulse text-[11px] text-muted motion-reduce:animate-none">Asking SAM 3.1...</p>;
  if (shot.status === "FAILED" || !r) return <p className="mt-2 text-[11px] leading-snug text-danger">{shot.error ?? "The frame could not be segmented."} The still frame is shown without masks.</p>;
  if (r.fallback) {
    const locked = r.fallback === "LIVE_LOCKED";
    return (
      <div className="mt-2" data-testid="realcam-result" data-provider={r.provider} data-fallback={r.fallback}>
        <span className="flex flex-wrap items-center gap-1" data-testid="realcam-badges">
          {locked ? (
            <span className={clsx("sim-tag inline-flex items-center gap-1 whitespace-nowrap", FALLBACK_TAG.LIVE_LOCKED.tone)}>
              <Lock size={9} aria-hidden /> {FALLBACK_TAG.LIVE_LOCKED.text}
            </span>
          ) : (
            <span className="sim-tag whitespace-nowrap border-amber/60! text-amber!">NO KEY</span>
          )}
          <span className="sim-tag whitespace-nowrap">NO MASK DRAWN</span>
        </span>
        <p className="mt-1.5 text-[13px] leading-snug text-text" data-testid="realcam-needs-key">
          {NEEDS_KEY}
        </p>
        <p className="mt-0.5 text-[11px] leading-snug text-muted">
          {locked ? "Live mode is locked, so nothing was sent to Meta." : "No MODEL_API_KEY is set on the backend, so nothing was sent to Meta."} The frame above is exactly what would have been segmented.
        </p>
        {locked && (
          <div className="mt-2">
            <Btn onClick={onUnlock} testId="realcam-unlock">
              <Lock size={14} /> Unlock live mode
            </Btn>
          </div>
        )}
      </div>
    );
  }
  const answered = r.provider === "SAM_3_1";
  const why = answered ? null : FALLBACK_TAG[failedWhy(r)];
  // executionIds also holds the cache replays (each is an execution record of its own); only requestsSent went to Meta
  const replayed = Math.max(0, r.executionIds.length - r.requestsSent);
  return (
    <div className="mt-2" data-testid="realcam-result" data-provider={r.provider} data-class={r.classification ?? undefined}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="flex flex-wrap items-center gap-1" data-testid="realcam-badges">
          {answered ? (
            <>
              <SourceTag source="SAM_3_1" />
              {r.classification && <ExecTag c={r.classification} />}
            </>
          ) : (
            why && <span className={clsx("sim-tag whitespace-nowrap", why.tone)}>{why.text}</span>
          )}
        </span>
        <span className="value text-[10px] text-dim" data-testid="realcam-stats">
          {answered ? `latency ${ms(r.latencyMs)} / cost ${usd(r.costUsd, 4)}` : "no mask drawn"}
          {` / ${r.requestsSent} sent to Meta${replayed > 0 ? `, ${replayed} replayed from cache` : ""}`}
        </span>
      </div>
      <ul className="mt-1.5 border-t border-line">
        {r.segments.map((s, i) => (
          <SegmentRow key={s.prompt} s={s} i={i} />
        ))}
      </ul>
      {!answered && r.note && <p className="mt-1 text-[10px] leading-snug text-dim">{r.note}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- dialog

/** The "Real water" panel: opened from the header camera button. */
export function RealWaterDialog({ onClose }: { onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const seq = useRef(0); // the shot whose answer is still wanted; an older one that arrives late is dropped
  const titleId = useId();
  const sam = useMissionStore((s) => s.system?.providers.sam.status);
  const [picked, setPicked] = useState<string[]>(["cable"]);
  const [custom, setCustom] = useState("");
  const [shot, setShot] = useState<Shot | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const cam = useCamera();

  // the phrases of the next shutter: chips first, then the free text, a repeat counted once
  const text = custom.trim();
  const prompts = [...picked, ...(text ? [text] : [])].filter((p, i, all) => all.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i).slice(0, MAX_PROMPTS);
  const full = prompts.length >= MAX_PROMPTS;
  const sending = shot?.status === "SENDING";

  // modal: focus moves in on open and back to the opener on close
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    root.current?.focus();
    return () => prev?.focus?.();
  }, []);

  // the frame on screen is a local object URL; release it when it is replaced or the panel closes
  const url = shot?.url;
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  const ask = useCallback(async (blob: Blob, phrases: string[], id: number) => {
    try {
      const response = await api.segmentImage(blob, phrases);
      if (id === seq.current) setShot((s) => s && { ...s, status: "DONE", response });
    } catch (e) {
      if (id === seq.current) setShot((s) => s && { ...s, status: "FAILED", error: e instanceof ApiError ? e.message : "The request failed." });
    }
  }, []);

  const begin = (blob: Blob) => {
    const id = ++seq.current;
    setFrameError(null);
    setShot({ url: URL.createObjectURL(blob), blob, status: "SENDING" });
    void ask(blob, prompts, id);
  };

  const shutter = async () => {
    const v = cam.video.current;
    if (!v || !v.videoWidth) return;
    try {
      begin(await toJpeg(v, v.videoWidth, v.videoHeight));
    } catch {
      setFrameError("The camera frame could not be encoded for sending.");
    }
  };

  const again = () => {
    if (!shot) return;
    const id = ++seq.current;
    setShot({ ...shot, status: "SENDING", response: undefined, error: undefined });
    void ask(shot.blob, prompts, id);
  };

  const upload = async (f: File | undefined) => {
    if (!f) return;
    try {
      const bitmap = await createImageBitmap(f);
      const blob = await toJpeg(bitmap, bitmap.width, bitmap.height);
      bitmap.close();
      begin(blob);
    } catch {
      setFrameError("That file is not an image this browser can read.");
    }
  };

  const toggle = (p: string) => setPicked((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

  // Keys stay inside the panel, so the lab's scene shortcuts never fire behind it. Escape closes; Tab stays in.
  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab") {
      const items = [...(root.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === root.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const live = cam.state.status === "live";
  const providerTag =
    sam === "LIVE" ? (
      <span className="sim-tag whitespace-nowrap border-teal! text-teal!" data-testid="realcam-provider" data-status="LIVE" title="SAM 3.1 will segment the frame; each prompt is one request">
        SAM 3.1 READY
      </span>
    ) : sam === "LIVE_LOCKED" ? (
      <span className="sim-tag inline-flex items-center gap-1 whitespace-nowrap border-amber/60! text-amber!" data-testid="realcam-provider" data-status="LIVE_LOCKED" title="Live mode is locked: enter the passcode for SAM 3.1">
        <Lock size={9} aria-hidden /> LIVE LOCKED
      </span>
    ) : (
      <span className={clsx("sim-tag whitespace-nowrap", sam && "border-amber/60! text-amber!", !sam && "opacity-70")} data-testid="realcam-provider" data-status={sam ?? "UNKNOWN"} title="No MODEL_API_KEY on the backend: the frame is shown without masks">
        {sam ? "NEEDS META KEY" : "PROVIDER UNKNOWN"}
      </span>
    );

  return (
    <motion.div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-testid="realcam-dialog"
      className="pointer-events-auto absolute inset-0 z-[60] flex overflow-y-auto bg-ground/80 p-4 outline-none backdrop-blur-[2px] max-[439px]:p-2"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        className="panel m-auto w-full max-w-[720px] p-5 max-[439px]:p-3.5"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 id={titleId} className="font-sans text-xl leading-tight text-text">
              Real water
            </h2>
            {providerTag}
          </div>
          <button type="button" className="btn btn-icon -mr-1 -mt-1" aria-label="Close real water camera" onClick={onClose} data-testid="realcam-close">
            <X size={14} />
          </button>
        </div>
        <p className="mt-1 text-[12px] leading-snug text-muted">
          Point a phone or laptop camera at real water, or upload a photo. SAM 3.1 outlines the things you name.
        </p>

        {/* the frame: live camera, or the still that was sent with the masks drawn over it */}
        <div className="relative mt-3 aspect-[4/3] max-h-[52dvh] w-full overflow-hidden border border-line bg-ground" data-testid="realcam-viewport">
          <video
            ref={cam.video}
            muted
            playsInline
            autoPlay
            onPlaying={cam.markLive}
            data-testid="realcam-video"
            className={clsx("absolute inset-0 h-full w-full object-contain", !(live && !shot) && "invisible")}
          />
          {shot && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element -- a local blob URL of the frame just taken */}
              <img src={shot.url} alt="The captured frame" data-testid="realcam-still" className="absolute inset-0 h-full w-full object-contain" />
              {shot.response && shot.response.provider === "SAM_3_1" && <Overlay r={shot.response} />}
            </>
          )}
          {!shot && !live && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-4 text-center" data-testid="realcam-camera-state" data-state={cam.state.status}>
              {cam.state.status === "starting" ? (
                <p className="value animate-pulse text-[11px] text-muted motion-reduce:animate-none">Starting the camera...</p>
              ) : (
                <>
                  <p className="text-[12px] leading-snug text-amber" data-testid="realcam-reason">
                    {cam.state.status === "unavailable" ? cam.state.reason : ""}
                  </p>
                  <p className="text-[11px] leading-snug text-muted">Uploading an image still works.</p>
                </>
              )}
            </div>
          )}
        </div>

        <p className="mt-2 text-[11px] leading-snug text-muted" data-testid="realcam-consent">
          Shutter, Upload and Segment again send this frame, downscaled to {MAX_SIDE} px, to Meta&apos;s SAM 3.1 through the backend, one request per prompt. Without the Meta key, or while live mode is locked, the
          backend does not forward it.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {shot ? (
            <>
              <Btn primary onClick={again} disabled={sending || prompts.length === 0} testId="realcam-again" label="Segment this frame again">
                <Camera size={14} /> Segment again
              </Btn>
              <Btn onClick={() => setShot(null)} testId="realcam-new" label="Back to the camera">
                <RotateCcw size={14} /> New shot
              </Btn>
            </>
          ) : (
            <Btn primary onClick={() => void shutter()} disabled={!live || prompts.length === 0} testId="realcam-shutter" label="Shutter: capture one frame and segment it">
              <Camera size={14} /> Shutter
            </Btn>
          )}
          <Btn onClick={() => file.current?.click()} disabled={sending || prompts.length === 0} testId="realcam-upload" label="Upload an image to segment">
            <Upload size={14} /> Upload image
          </Btn>
          {cam.state.status === "unavailable" && !shot && (
            <Btn onClick={cam.retry} testId="realcam-retry" label="Retry the camera">
              <RotateCcw size={14} /> Retry camera
            </Btn>
          )}
          <input ref={file} type="file" accept="image/*" hidden data-testid="realcam-file" onChange={(e) => void upload(e.target.files?.[0]).finally(() => (e.target.value = ""))} />
        </div>
        {frameError && (
          <p className="mt-1 text-[11px] text-danger" role="alert">
            {frameError}
          </p>
        )}

        <fieldset className="mt-3 min-w-0 border-0 p-0">
          <legend className="label mb-1">
            Prompts <span className="text-dim">(up to {MAX_PROMPTS}, one SAM 3.1 request each)</span>
          </legend>
          <div className="flex flex-wrap gap-1.5">
            {PROMPT_CHIPS.map((p) => {
              const on = picked.includes(p);
              return (
                <button
                  key={p}
                  type="button"
                  aria-pressed={on}
                  data-testid="realcam-chip"
                  data-prompt={p}
                  disabled={!on && full}
                  onClick={() => toggle(p)}
                  className={clsx(
                    "border px-2 py-[3px] text-left text-[11px] transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50",
                    on ? "border-teal bg-teal/10 text-teal" : "border-line text-muted hover:border-teal hover:text-text",
                  )}
                >
                  {p}
                </button>
              );
            })}
          </div>
          <label htmlFor={`${titleId}-custom`} className="sr-only">
            Your own prompt
          </label>
          <input
            id={`${titleId}-custom`}
            type="text"
            data-testid="realcam-custom"
            maxLength={MAX_PROMPT_CHARS}
            value={custom}
            disabled={picked.length >= MAX_PROMPTS}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="or type what to find, e.g. oil sheen"
            className="mt-2 w-full border border-line-strong bg-panel-2 px-2 py-1.5 text-[12px] leading-snug text-text outline-none placeholder:text-dim focus:border-teal disabled:opacity-50"
          />
          <p className="mt-1 text-[10px] leading-snug text-dim" data-testid="realcam-prompts">
            {prompts.length === 0 ? "Pick or type a prompt to enable the shutter." : `Next shutter: ${prompts.join(" + ")}`}
            {full && ` (${MAX_PROMPTS} is the limit per shutter)`}
          </p>
        </fieldset>

        <span className="sr-only" role="status">
          {sending ? "Asking SAM 3.1" : shot?.response ? `${shot.response.segments.reduce((n, s) => n + s.instances.length, 0)} masks drawn` : ""}
        </span>
        {shot && <Result shot={shot} onUnlock={() => useMissionStore.getState().setUnlockOpen(true)} />}
      </motion.div>
    </motion.div>
  );
}
