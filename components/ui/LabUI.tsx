"use client";

import clsx from "clsx";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { Camera, ChevronDown, ChevronUp, Compass, Lock, LockOpen, Maximize2, Minimize2, OctagonX, Play, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { BEZIER, DUR } from "@/lib/animations/motion";
import { useSimStore, type SceneId } from "@/lib/sim/store";
import { useMissionStore } from "@/lib/store/mission";
import { BackendBridge } from "./bridge";
import { CameraFeed } from "./CameraFeed";
import { CreditChip, UnlockDialog, useLiveLock } from "./credits";
import { IntelligenceCard, OriginTag } from "./intelligence";
import { MissionCard } from "./mission";
import { DemoCard, VisionMoment } from "./overlays";
import { PerceptionCard } from "./perception";
import { RealWaterDialog } from "./realcam";
import { ReportCard } from "./report";
import { EnvironmentCard, GantryCard, OverviewCard, SystemCard } from "./scenes";
import { Btn, Dot } from "./shared";
import { MissionLog, Telemetry } from "./Telemetry";
import { Tour } from "./tour";

export const SCENES: { id: SceneId; name: string }[] = [
  { id: 1, name: "Overview" },
  { id: 2, name: "System" },
  { id: 3, name: "Perception" },
  { id: 4, name: "Navigation" },
  { id: 5, name: "Mission" },
  { id: 6, name: "Environment" },
  { id: 7, name: "Report" },
  { id: 8, name: "Intelligence" },
];

const CARDS: Record<SceneId, () => React.JSX.Element> = {
  1: OverviewCard,
  2: SystemCard,
  3: PerceptionCard,
  4: GantryCard,
  5: MissionCard,
  6: EnvironmentCard,
  7: ReportCard,
  8: IntelligenceCard,
};

/** Scenes whose card carries more than a paragraph get a wider card. */
const WIDE: Partial<Record<SceneId, boolean>> = { 3: true, 5: true, 7: true, 8: true };

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);

/** The VISION column grows with the viewport so its bottom never reaches the centred card: 440 px at 1440, 300 px below 1220. */
function useVisionColumnWidth() {
  const [w, setW] = useState(440);
  useEffect(() => {
    const update = () => setW(Math.min(440, Math.max(300, window.innerWidth - 920)));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return w;
}

/** DOM overlay over the 3D scene. Pointer events pass through everywhere except the panels. */
export function LabUI() {
  const scene = useSimStore((s) => s.scene);
  const demoActive = useSimStore((s) => s.demo.active);
  const showVision = useSimStore((s) => s.showVision);
  const panels = useSimStore((s) => s.panels);
  const setScene = useSimStore((s) => s.setScene);
  const unlockOpen = useMissionStore((s) => s.unlockOpen);
  const [camOpen, setCamOpen] = useState(false);
  const visionColumnWidth = useVisionColumnWidth();
  const columnWidth = scene === 3 ? visionColumnWidth : 300;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const s = useSimStore.getState();
      if (s.demo.active || s.showVision || s.tourStep !== null || useMissionStore.getState().unlockOpen) return;
      const cur = s.scene;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") s.setScene(Math.min(8, cur + 1) as SceneId);
      else if (e.key === "ArrowUp" || e.key === "ArrowLeft") s.setScene(Math.max(1, cur - 1) as SceneId);
      else if (e.key >= "1" && e.key <= "8") s.setScene(Number(e.key) as SceneId);
      else if (e.key === "f" || e.key === "F") {
        // focus view: both panels collapse together and come back together
        const open = s.panels.card || s.panels.telemetry;
        s.setPanels({ card: !open, telemetry: !open });
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const Card = CARDS[scene];
  const wide = WIDE[scene] && !demoActive;
  const cardOpen = panels.card || demoActive;

  return (
    <MotionConfig reducedMotion="user">
      <div
        data-lab-root
        className="pointer-events-none absolute inset-0 select-none overflow-hidden max-[999px]:flex max-[999px]:flex-col"
        style={{ "--col-w": `${columnWidth}px` } as React.CSSProperties}
      >
        <TopBar onCamera={() => setCamOpen(true)} />

        {/* left rail: scene index. Below 1000 px it is a horizontal strip directly above the card. */}
        <nav
          data-lab="nav"
          data-tour="nav"
          className="pointer-events-auto absolute left-4 top-1/2 flex w-[148px] -translate-y-1/2 flex-col gap-0.5 border border-line bg-ground/70 py-1.5 max-[999px]:static max-[999px]:mx-auto max-[999px]:mt-auto max-[999px]:w-[calc(100%-2rem)] max-[999px]:max-w-[620px] max-[999px]:translate-y-0 max-[999px]:flex-row max-[999px]:gap-0 max-[999px]:border-b-0 max-[999px]:bg-panel/92 max-[999px]:px-1 max-[999px]:py-0 max-[999px]:overflow-x-auto no-scrollbar short:ml-4 short:mr-[252px] short:w-auto short:max-w-none max-[759px]:short:mr-[208px]"
          aria-label="Scenes"
        >
          {SCENES.map((s) => {
            const on = s.id === scene;
            return (
              <button
                key={s.id}
                type="button"
                disabled={demoActive}
                aria-current={on ? "page" : undefined}
                onClick={() => setScene(s.id)}
                className={clsx(
                  "group relative flex items-center gap-2 border-l-2 py-1 pl-2 pr-3 text-left transition-colors duration-150 max-[999px]:border-b-2 max-[999px]:border-l-0 max-[999px]:px-2 max-[999px]:py-2 max-[399px]:flex-1 max-[399px]:justify-center max-[399px]:px-1",
                  on ? "border-teal bg-teal/[0.06]" : "border-transparent hover:border-line-strong hover:bg-panel-2/50",
                  demoActive && "cursor-default opacity-50",
                )}
              >
                <span className={clsx("value text-[10px]", on ? "text-teal" : "text-dim")}>{String(s.id).padStart(2, "0")}</span>
                <span className={clsx("label", on ? "text-teal max-[399px]:sr-only" : "text-muted group-hover:text-text max-[999px]:hidden")}>{s.name}</span>
              </button>
            );
          })}
        </nav>

        {/* right column: feed + telemetry + twin log. Wider in Perception so the feed is the focus. */}
        <motion.div
          data-lab="column"
          className="pointer-events-auto absolute right-4 top-14 flex max-h-[calc(100%-4.5rem)] flex-col gap-2 max-[999px]:w-[220px]! max-[759px]:w-[176px]!"
          initial={false}
          animate={{ width: columnWidth }}
          transition={{ duration: DUR.base, ease: BEZIER.out }}
        >
          <CameraFeed />
          {scene !== 3 && (
            <div className="flex min-h-0 flex-col gap-2 overflow-y-auto max-[999px]:hidden" data-tour="telemetry">
              <Telemetry />
              {panels.telemetry && <MissionLog />}
            </div>
          )}
        </motion.div>

        {/* bottom centre: context card or demo controller. Between 1000 and 1259 px it sits between the rail and the column; below 1000 px it is the last block of the stack. */}
        <div
          data-lab="card"
          data-tour="card"
          className={clsx(
            // centred in the space the rail and the column leave, so a wide card can never run under the feed
            "pointer-events-none absolute bottom-6 left-[176px] right-[calc(var(--col-w)+32px)] mx-auto",
            wide ? "max-w-[780px]" : "max-w-[620px]",
            "max-[1259px]:max-w-none",
            "max-[999px]:static max-[999px]:mb-4 max-[999px]:w-[calc(100%-2rem)] max-[999px]:max-w-[620px]",
            // phones on their side: the card sits left of the feed column instead of under it
            "short:mb-2 short:ml-4 short:mr-[252px] short:w-auto short:max-w-none max-[759px]:short:mr-[208px]",
          )}
        >
          <AnimatePresence mode="wait" initial={false}>
            {cardOpen ? (
              <motion.div
                key={demoActive ? "demo" : scene}
                className="panel pointer-events-auto relative max-h-[calc(100dvh-9rem)] overflow-y-auto p-4 max-[999px]:max-h-[55dvh] max-[759px]:max-h-[42dvh] short:max-h-[calc(100dvh-6.5rem)]! short:p-3"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: DUR.fast + 0.04, ease: BEZIER.out }}
              >
                {demoActive ? (
                  <DemoCard />
                ) : (
                  <>
                    <div className="float-right ml-3 flex items-center gap-1.5 max-[759px]:float-none max-[759px]:mb-2 max-[759px]:ml-0 max-[759px]:justify-between">
                      <OriginTag scene={scene} />
                      <button
                        type="button"
                        className="btn btn-icon -my-1 -mr-1"
                        aria-label="Collapse panel"
                        title="Collapse the panel (F toggles all panels)"
                        onClick={() => useSimStore.getState().setPanels({ card: false })}
                      >
                        <ChevronDown size={14} />
                      </button>
                    </div>
                    <Card />
                  </>
                )}
              </motion.div>
            ) : (
              <motion.button
                key="collapsed"
                type="button"
                className="panel pointer-events-auto mx-auto flex items-center gap-3 px-3 py-2 hover:border-line-strong"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: DUR.fast, ease: BEZIER.out }}
                onClick={() => useSimStore.getState().setPanels({ card: true })}
                aria-label={`Expand the ${SCENES[scene - 1].name} panel`}
              >
                <span className="value text-[10px] text-teal">{String(scene).padStart(2, "0")}</span>
                <span className="label text-text">{SCENES[scene - 1].name}</span>
                <ChevronUp size={14} className="text-muted" />
              </motion.button>
            )}
          </AnimatePresence>
        </div>

        <AnimatePresence>{showVision && <VisionMoment key="vision" />}</AnimatePresence>
        <AnimatePresence>{camOpen && <RealWaterDialog key="realcam" onClose={() => setCamOpen(false)} />}</AnimatePresence>
        <AnimatePresence>{unlockOpen && <UnlockDialog key="unlock" />}</AnimatePresence>
      </div>
      <Tour />
      <BackendBridge />
    </MotionConfig>
  );
}

function StatusChip({
  name,
  value,
  tone,
  title,
  pulse,
  icon,
  valueClass,
  onClick,
  className,
  collapse,
}: {
  name: string;
  value: string;
  tone: "teal" | "amber" | "danger" | "dim";
  title?: string;
  pulse?: boolean;
  /** replaces the status dot */
  icon?: React.ReactNode;
  valueClass?: string;
  /** makes the chip a button */
  onClick?: () => void;
  className?: string;
  /** below 1000 px only the icon stays; the button keeps its full name for assistive technology */
  collapse?: boolean;
}) {
  const hide = collapse && "max-[999px]:hidden";
  const cls = clsx("flex min-h-[25px] shrink-0 items-center gap-1.5 border border-line bg-ground/40 px-2 py-1", collapse && "max-[999px]:px-1.5", className);
  const inner = (
    <>
      {icon ?? <Dot tone={tone} pulse={pulse} />}
      {/* The name is spoken, not drawn, below 1600 px: the value says what the chip is, and the header needs the room for the full
          credit chip (from 1280 px). Header thresholds, all "narrower than N" in Tailwind 4: chip names 1600, full credit chip 1280,
          MISSION CONTROL label 1440. The camera button is always drawn, so below 1200 the focus toggle gives way to it, the Run demo word
          appears from 760 and the E-stop word from 380 (the icons keep their accessible names and titles). */}
      <span className={clsx("label text-text max-[1600px]:sr-only", hide)}>{name}</span>
      <span className={clsx("label text-[9px]", valueClass ?? "text-dim", hide)}>{value}</span>
    </>
  );
  const id = `chip-${name.toLowerCase()}`;
  return onClick ? (
    <button type="button" onClick={onClick} className={clsx(cls, "transition-colors duration-150")} data-testid={id} title={title} aria-label={`${name} ${value}. ${title ?? ""}`.trim()}>
      {inner}
    </button>
  ) : (
    <span className={cls} data-testid={id} title={title}>
      {inner}
    </span>
  );
}

/** AI provider chip. When live mode is locked it is the way in to the unlock dialog, at every width. */
function AiChip() {
  const sys = useMissionStore((s) => s.system);
  const lock = useLiveLock();
  const open = useMissionStore((s) => s.setUnlockOpen);
  const ai = sys?.providers.spark.status === "LIVE";
  if (lock === "LOCKED")
    return (
      <StatusChip
        name="AI"
        value="LIVE LOCKED"
        tone="amber"
        valueClass="text-amber!"
        icon={<Lock size={11} className="text-amber" aria-hidden />}
        collapse
        className="border-amber/50! hover:border-amber max-[600px]:hidden"
        onClick={() => open(true)}
        title="Live mode is locked: Meta calls need the passcode, so labelled offline fallbacks run. Click to unlock."
      />
    );
  if (lock === "UNLOCKED" && ai)
    return (
      <StatusChip
        name="AI"
        value="META LIVE"
        tone="teal"
        icon={<LockOpen size={11} className="text-teal" aria-hidden />}
        collapse
        className="max-[999px]:hidden hover:border-line-strong"
        onClick={() => open(true)}
        title="Muse Spark reachable with a key; this tab holds the passcode. Click to lock again."
      />
    );
  return (
    <StatusChip
      name="AI"
      value={!sys ? "UNKNOWN" : ai ? "META LIVE" : "OFFLINE"}
      tone={!sys ? "dim" : ai ? "teal" : "amber"}
      className="max-[999px]:hidden"
      title={!sys ? "Provider status unknown until the backend answers" : ai ? "Muse Spark reachable with a key" : "No MODEL_API_KEY: labelled offline fallbacks"}
    />
  );
}

/** Always visible, always enabled. Latches the twin immediately and the backend gate after; shows latched while either holds. */
function EstopButton() {
  const twin = useSimStore((s) => s.telemetry.estop);
  const backend = useMissionStore((s) => s.system?.gantry.estop ?? false);
  const { emergencyStop, clearEstop } = useMissionStore(useShallow((s) => ({ emergencyStop: s.emergencyStop, clearEstop: s.clearEstop })));
  const where = twin && backend ? "the digital twin and the backend motion controller" : twin ? "the digital twin" : "the backend motion controller";
  return twin || backend ? (
    <Btn onClick={clearEstop} className="border-danger! text-danger!" title={`Emergency stop is latched on ${where}. Clear it to allow motion again.`}>
      <OctagonX size={14} /> Clear e-stop
    </Btn>
  ) : (
    <Btn danger onClick={emergencyStop} label="Emergency stop" title="Stop all motion now">
      <OctagonX size={14} /> <span className="max-[379px]:sr-only">E-stop</span>
    </Btn>
  );
}

function TopBar({ onCamera }: { onCamera: () => void }) {
  const demoActive = useSimStore((s) => s.demo.active);
  const focus = useSimStore((s) => !s.panels.card && !s.panels.telemetry);
  const { startDemo, reset, setPanels, setTourStep } = useSimStore(useShallow((s) => ({ startDemo: s.startDemo, reset: s.reset, setPanels: s.setPanels, setTourStep: s.setTourStep })));
  const backend = useMissionStore((s) => s.backend);
  const sys = useMissionStore((s) => s.system);

  return (
    <header data-lab="header" className="pointer-events-none absolute inset-x-0 top-0 z-30 flex h-12 items-center justify-between gap-4 border-b border-line bg-ground/70 px-4 backdrop-blur-[2px] max-[999px]:relative max-[999px]:shrink-0 max-[439px]:gap-2 max-[439px]:px-3">
      <div className="pointer-events-auto flex min-w-0 items-center gap-4 overflow-hidden">
        <span className="whitespace-nowrap font-mono text-[13px] font-semibold tracking-[0.28em] text-text max-[439px]:tracking-[0.12em] max-[379px]:text-[11px] max-[379px]:tracking-[0.04em]">AQUASENTINAL</span>
        <span className="h-4 w-px bg-line-strong max-[1440px]:hidden" />
        <span className="label whitespace-nowrap text-teal max-[1440px]:hidden">Mission control</span>
        <Link href="/walkthrough" className="label whitespace-nowrap transition-colors hover:text-text max-[1099px]:hidden">
          Walkthrough
        </Link>
        <button type="button" onClick={() => setTourStep(0)} disabled={demoActive} className="label inline-flex items-center gap-1 whitespace-nowrap transition-colors hover:text-text disabled:opacity-50 max-[759px]:hidden" data-testid="start-tour">
          <Compass size={12} /> Guide
        </button>
      </div>
      <div className="pointer-events-auto flex shrink-0 items-center gap-1.5 max-[1200px]:gap-1 max-[600px]:[&_.btn]:px-2">
        {/* secondary status, dropped below 1000 px so the brand always has room. Unknown is grey, never green. */}
        <div className="contents max-[999px]:hidden">
          <StatusChip name="Mode" value={sys?.mode ?? "UNKNOWN"} tone={!sys ? "dim" : sys.hardwareActive ? "amber" : "teal"} title={sys ? `Backend reports ${sys.mode}` : "Backend status not read yet"} />
          <StatusChip name="Backend" value={backend} tone={backend === "ONLINE" ? "teal" : backend === "OFFLINE" ? "danger" : "dim"} pulse={backend === "ONLINE"} title="Polled every 5 s and on every event socket reconnect" />
        </div>
        <AiChip />
        <CreditChip />
        <span className="mx-1 h-5 w-px bg-line max-[1200px]:hidden" />
        <button
          type="button"
          className="btn btn-icon"
          onClick={onCamera}
          disabled={demoActive}
          aria-haspopup="dialog"
          aria-label="Real water camera"
          title="Real water camera: segment a phone or laptop camera frame with SAM 3.1"
          data-testid="realcam-open"
        >
          <Camera size={14} />
        </button>
        <button
          type="button"
          className="btn btn-icon max-[1200px]:hidden"
          onClick={() => setPanels({ card: focus, telemetry: focus })}
          aria-pressed={focus}
          aria-label={focus ? "Show panels" : "Focus the 3D view"}
          title={focus ? "Show panels (F)" : "Focus the 3D view (F)"}
          data-testid="focus-toggle"
        >
          {focus ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <Btn primary onClick={startDemo} disabled={demoActive} label={demoActive ? "Demo running" : "Run demo"}>
          <Play size={14} /> <span className="max-[759px]:hidden">{demoActive ? "Demo running" : "Run demo"}</span>
        </Btn>
        <Btn onClick={reset} disabled={demoActive} label="Reset lab">
          <RotateCcw size={14} /> <span className="max-[759px]:hidden">Reset</span>
        </Btn>
        <EstopButton />
      </div>
    </header>
  );
}
