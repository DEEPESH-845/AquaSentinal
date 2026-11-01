"use client";

import clsx from "clsx";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { OctagonX, Play, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useSimStore, type SceneId } from "@/lib/sim/store";
import { useMissionStore } from "@/lib/store/mission";
import { BackendBridge } from "./bridge";
import { CameraFeed } from "./CameraFeed";
import { IntelligenceCard, OriginTag } from "./intelligence";
import { MissionCard } from "./mission";
import { DemoCard, VisionMoment } from "./overlays";
import { PerceptionCard } from "./perception";
import { ReportCard } from "./report";
import { EnvironmentCard, GantryCard, OverviewCard, SystemCard } from "./scenes";
import { Btn, Dot } from "./shared";
import { Telemetry } from "./Telemetry";

const SCENES: { id: SceneId; name: string }[] = [
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

/** DOM overlay over the 3D scene. Pointer events pass through everywhere except the panels. */
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

export function LabUI() {
  const scene = useSimStore((s) => s.scene);
  const demoActive = useSimStore((s) => s.demo.active);
  const showVision = useSimStore((s) => s.showVision);
  const setScene = useSimStore((s) => s.setScene);
  const visionColumnWidth = useVisionColumnWidth();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const s = useSimStore.getState();
      if (s.demo.active || s.showVision) return;
      const cur = s.scene;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") s.setScene(Math.min(8, cur + 1) as SceneId);
      else if (e.key === "ArrowUp" || e.key === "ArrowLeft") s.setScene(Math.max(1, cur - 1) as SceneId);
      else if (e.key >= "1" && e.key <= "8") s.setScene(Number(e.key) as SceneId);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const Card = CARDS[scene];
  const wide = WIDE[scene] && !demoActive;

  return (
    <MotionConfig reducedMotion="user">
      <div className="pointer-events-none absolute inset-0 select-none overflow-hidden max-[999px]:flex max-[999px]:flex-col">
        <TopBar />

        {/* left rail: scene index. Below 1000 px it is a horizontal strip directly above the card. */}
        <nav
          data-lab="nav"
          className="pointer-events-auto absolute left-4 top-1/2 flex -translate-y-1/2 flex-col gap-0.5 bg-ground/60 py-1.5 max-[999px]:static max-[999px]:py-0 max-[999px]:mx-auto max-[999px]:mt-auto max-[999px]:w-[calc(100%-2rem)] max-[999px]:max-w-[620px] max-[999px]:translate-y-0 max-[999px]:flex-row max-[999px]:gap-0 max-[999px]:border max-[999px]:border-b-0 max-[999px]:border-line max-[999px]:bg-panel/92 max-[999px]:px-1"
          aria-label="Scenes"
        >
          {SCENES.map((s) => {
            const on = s.id === scene;
            return (
              <button
                key={s.id}
                type="button"
                disabled={demoActive}
                onClick={() => setScene(s.id)}
                className={clsx(
                  "group flex items-center gap-2 border-l-2 py-1 pl-2 pr-3 text-left transition-colors duration-100 max-[999px]:border-b-2 max-[999px]:border-l-0 max-[999px]:px-2 max-[999px]:py-2",
                  on ? "border-teal" : "border-transparent hover:border-line-strong",
                  demoActive && "cursor-default opacity-50",
                )}
              >
                <span className={clsx("value text-[10px]", on ? "text-teal" : "text-dim")}>{String(s.id).padStart(2, "0")}</span>
                <span className={clsx("label", on ? "text-teal" : "text-muted group-hover:text-text max-[759px]:hidden")}>{s.name}</span>
              </button>
            );
          })}
        </nav>

        {/* right column: feed + telemetry. Wider in VISION so the feed is the focus. */}
        <motion.div
          data-lab="column"
          className="pointer-events-auto absolute right-4 top-14 flex max-h-[calc(100%-4.5rem)] flex-col gap-2 max-[999px]:w-[220px]! max-[759px]:w-[176px]!"
          initial={false}
          animate={{ width: scene === 3 ? visionColumnWidth : 300 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
        >
          <CameraFeed />
          {scene !== 3 && (
            <div className="min-h-0 overflow-y-auto max-[999px]:hidden">
              <Telemetry />
            </div>
          )}
        </motion.div>

        {/* bottom centre: context card or demo controller. Between 1000 and 1259 px it sits between the rail and the column; below 1000 px it is the last block of the stack. */}
        <div data-lab="card" className={clsx("pointer-events-none absolute bottom-6 left-1/2 w-[calc(100%-2rem)] -translate-x-1/2", wide ? "max-w-[780px]" : "max-w-[620px]", " max-[1259px]:left-32 max-[1259px]:right-[332px] max-[1259px]:w-auto max-[1259px]:max-w-none max-[1259px]:translate-x-0 max-[999px]:static max-[999px]:mx-auto max-[999px]:mb-4 max-[999px]:w-[calc(100%-2rem)] max-[999px]:max-w-[620px] max-[999px]:translate-x-0")}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={demoActive ? "demo" : scene}
              className="panel pointer-events-auto max-h-[calc(100vh-9rem)] overflow-y-auto p-4 max-[999px]:max-h-[55vh] max-[759px]:max-h-[42vh]"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
            >
              {demoActive ? (
                <DemoCard />
              ) : (
                <>
                  <div className="float-right ml-3">
                    <OriginTag scene={scene} />
                  </div>
                  <Card />
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        <AnimatePresence>{showVision && <VisionMoment key="vision" />}</AnimatePresence>
      </div>
      <BackendBridge />
    </MotionConfig>
  );
}

function StatusChip({ name, value, tone }: { name: string; value: string; tone: "teal" | "amber" | "danger" | "dim" }) {
  return (
    <span className="flex items-center gap-1.5 border border-line px-2 py-1" data-testid={`chip-${name.toLowerCase()}`}>
      <Dot tone={tone} />
      <span className="label text-text">{name}</span>
      <span className="label text-[9px] text-dim">{value}</span>
    </span>
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
      <OctagonX size={14} /> E-stop
    </Btn>
  );
}

function TopBar() {
  const demoActive = useSimStore((s) => s.demo.active);
  const startDemo = useSimStore((s) => s.startDemo);
  const reset = useSimStore((s) => s.reset);
  const backend = useMissionStore((s) => s.backend);
  const sys = useMissionStore((s) => s.system);
  const ai = sys?.providers.spark.status === "LIVE";

  return (
    <header data-lab="header" className="pointer-events-none absolute inset-x-0 top-0 flex h-12 items-center justify-between gap-4 border-b border-line/70 bg-ground/55 px-4 max-[999px]:static max-[999px]:shrink-0 max-[439px]:gap-2 max-[439px]:px-3">
      <div className="pointer-events-auto flex min-w-0 items-baseline gap-3 overflow-hidden">
        <span className="whitespace-nowrap font-mono text-[13px] font-semibold tracking-[0.28em] text-text max-[439px]:tracking-[0.12em]">AQUASENTINAL</span>
        <span className="label whitespace-nowrap max-[1399px]:hidden">AI underwater inspection</span>
        <span className="hidden truncate whitespace-nowrap text-[12px] text-muted min-[1500px]:block">Meta models on a camera gantry.</span>
      </div>
      <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">
        {/* secondary status, dropped below 1000 px so the brand always has room */}
        <div className="contents max-[999px]:hidden">
          <StatusChip name="Mode" value={sys?.mode ?? "SIMULATION"} tone={sys?.hardwareActive ? "amber" : "teal"} />
          <StatusChip name="Backend" value={backend} tone={backend === "ONLINE" ? "teal" : backend === "OFFLINE" ? "danger" : "dim"} />
          <StatusChip name="AI" value={!sys ? "UNKNOWN" : ai ? "META LIVE" : "OFFLINE"} tone={ai ? "teal" : "amber"} />
          <span className="mx-1 h-5 w-px bg-line" />
        </div>
        <Btn primary onClick={startDemo} disabled={demoActive} label={demoActive ? "Demo running" : "Run demo"}>
          <Play size={14} /> <span className="max-[439px]:hidden">{demoActive ? "Demo running" : "Run demo"}</span>
          <span className="min-[440px]:hidden">Demo</span>
        </Btn>
        <Btn onClick={reset} disabled={demoActive} label="Reset lab">
          <RotateCcw size={14} /> <span className="max-[759px]:hidden">Reset</span>
        </Btn>
        <EstopButton />
      </div>
    </header>
  );
}
