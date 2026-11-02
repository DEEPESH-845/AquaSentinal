"use client";

import clsx from "clsx";
import { BarChart3, Compass, Home, Square } from "lucide-react";
import Link from "next/link";
import { useState, type KeyboardEvent, type MouseEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { compareStrategies } from "@/lib/sim/compare";
import { GANTRY } from "@/lib/sim/constants";
import { DEMO_FIXTURE_PLAN } from "@/lib/sim/demo";
import { SCENARIO_PRESETS, type PresetId } from "@/lib/sim/scenario";
import { useSimStore, type ComponentId } from "@/lib/sim/store";
import type { MissionResult } from "@/lib/sim/types";
import { useMissionStore } from "@/lib/store/mission";
import { Btn, CardHead, Chip, Dot, ObjectChips, SourceTag, clampNum, f1, f2, pad2, pct, useObjects, isTargetClass } from "./shared";
import { C } from "@/lib/theme";

// ---------------------------------------------------------------- 01 MISSION OVERVIEW

export function OverviewCard() {
  const setScene = useSimStore((s) => s.setScene);
  const m = useSimStore((s) => s.mission);
  const running = useSimStore((s) => s.mode === "MISSION");
  const env = useSimStore(useShallow((s) => s.telemetry.environment));
  const record = useMissionStore((s) => s.mission);
  return (
    <div>
      <CardHead
        title="Underwater inspection lab"
        note="An XY gantry carries a downward camera over a pipeline in a test tank. Describe an inspection; Meta models plan it, segment what the camera sees and track it; the controller adapts to visibility; every finding is recorded with its evidence."
      />
      <div className="grid grid-cols-[auto_1fr_auto_1fr] gap-x-3 gap-y-[3px] border-t border-line pt-2">
        <span className="label">Mission</span>
        <span className="value truncate text-[11px] text-text">{record ? `${record.id} ${record.status}` : "none planned"}</span>
        <span className="label">Progress</span>
        <span className="value text-[11px] text-text">{m && running ? `${Math.min(m.waypointIndex + 1, m.waypointsPlanned)} / ${m.waypointsPlanned}` : "-"}</span>
        <span className="label">Perception</span>
        <span className={clsx("value truncate text-[11px]", m && running && m.perception !== "NORMAL_VISIBILITY" ? "text-amber" : "text-teal")}>{m && running ? m.perception.replace(/_/g, " ") : "IDLE"}</span>
        <span className="label">Visibility</span>
        <span className="value text-[11px] text-text">
          {pct(env.visibility, 0)} <span className="text-dim">sim</span>
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Btn primary onClick={() => setScene(5)}>
          Plan an inspection
        </Btn>
        <Btn onClick={() => useSimStore.getState().setTourStep(0)} label="Take the guided tour">
          <Compass size={14} /> Guided tour
        </Btn>
        <Link href="/walkthrough" className="label ml-1 underline-offset-4 transition-colors hover:text-text hover:underline">
          How it works -&gt;
        </Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 02 SYSTEM ARCHITECTURE

const COMPONENTS: { id: ComponentId; name: string; text: string }[] = [
  { id: "gantry", name: "XY gantry", text: "2020 frame, MGN12 rails, NEMA17 + GT2. 100 x 40 cm travel, 15 cm/s, 30 cm/s^2 (reference spec)." },
  { id: "camera", name: "Camera housing", text: "Pi Camera Module 3 Wide in an acrylic tube, 42 cm above the sand, 75 degree underwater FOV." },
  { id: "aquarium", name: "Tank and pipeline", text: "120 x 60 x 60 cm tank, 50 cm of water, a flanged pipeline with a valve on sand." },
  { id: "raspberry-pi", name: "Raspberry Pi", text: "Runs the backend: perception pipeline, mission service, hardware gateway." },
  { id: "arduino", name: "Arduino + CNC shield", text: "Two A4988 drivers. Serial driver speaks GRBL 1.1; unverified on the physical rig." },
  { id: "test-objects", name: "Inspection targets", text: "Loose cable, rope offcut, dropped wrench, crate, concrete panel, rocks." },
];

type ServiceStatus = "LIVE" | "OFFLINE" | "ON" | "OFF" | "UNKNOWN";

/** One dependency. UNKNOWN (not checked, or the backend that would check it is unreachable) is grey, never green. */
function Service({ name, status, detail }: { name: string; status: ServiceStatus; detail: string }) {
  const on = status === "LIVE" || status === "ON";
  const unknown = status === "UNKNOWN";
  return (
    <div className="grid grid-cols-[10px_1fr_auto] items-center gap-x-2 border-b border-line py-[3px]" data-status={status}>
      <Dot tone={unknown ? "dim" : on ? "teal" : "amber"} />
      <span className="min-w-0">
        <span className="label text-text">{name}</span>
        <span className="block truncate text-[10px] text-muted" title={detail}>
          {detail}
        </span>
      </span>
      <span className={clsx("label text-[9px]", unknown ? "text-dim" : on ? "text-teal" : "text-amber")}>{status}</span>
    </div>
  );
}

const ago = (ms: number | null) => (ms === null ? "never" : `${Math.max(0, Math.round((Date.now() - ms) / 1000))} s ago`);

export function SystemCard() {
  const setHighlight = useSimStore((s) => s.setHighlight);
  const highlight = useSimStore((s) => s.highlight);
  const [sticky, setSticky] = useState<ComponentId | null>(null);
  const sys = useMissionStore((s) => s.system);
  const backend = useMissionStore((s) => s.backend);
  const lastOk = useMissionStore((s) => s.lastStatusOkAt);
  const preflight = useMissionStore((s) => s.preflight);
  const mission = useMissionStore((s) => s.mission);
  const p = sys?.providers;
  const known = !!sys;
  const metaLive = preflight?.checks.find((c) => c.id === "meta_live");
  const hw = sys?.gantry.status;
  return (
    <div>
      <CardHead title="System health and architecture" note="Live dependency status from the backend, then the physical components: hover or focus one to highlight it in the scene, select it to keep it highlighted." />
      <div className="mb-3 grid grid-cols-2 gap-x-4 max-[759px]:grid-cols-1" data-testid="system-health">
        <Service name="Backend" status={backend === "ONLINE" ? "ON" : backend === "OFFLINE" ? "OFF" : "UNKNOWN"} detail={backend === "ONLINE" ? `FastAPI ${sys?.version ?? ""}, last answer ${ago(lastOk)}` : backend === "OFFLINE" ? `not reachable; last answer ${ago(lastOk)}` : "connecting"} />
        <Service
          name="Meta API connectivity"
          status={!metaLive ? "UNKNOWN" : metaLive.ok ? "LIVE" : "OFFLINE"}
          detail={metaLive ? metaLive.detail : "not checked: backend preflight has not answered"}
        />
        <Service name="Muse Spark 1.3" status={known ? p!.spark.status : "UNKNOWN"} detail={!known ? "unknown until the backend answers" : p!.spark.status === "LIVE" ? "mission planning, frame reasoning, summaries" : "offline: labelled keyword parser"} />
        <Service name="SAM 3.1" status={known ? p!.sam.status : "UNKNOWN"} detail={!known ? "unknown until the backend answers" : p!.sam.status === "LIVE" ? "text-prompted masks" : "offline: twin-geometry outlines"} />
        <Service name="Voice Transcribe" status={known ? p!.voice.status : "UNKNOWN"} detail={!known ? "unknown until the backend answers" : p!.voice.status === "LIVE" ? "push-to-talk speech to text" : "offline: type instead"} />
        <Service name="Camera" status={!known ? "UNKNOWN" : sys!.camera.online ? "ON" : "OFF"} detail={known ? `${sys!.camera.source.replace(/_/g, " ").toLowerCase()}${sys!.camera.resolution ? ` ${sys!.camera.resolution}` : ""}` : "unknown"} />
        <Service
          name="Gantry driver"
          status={!known ? "UNKNOWN" : sys!.hardwareActive ? (hw?.connected ? "ON" : "OFF") : "OFF"}
          detail={!known ? "unknown" : sys!.hardwareActive ? `serial GRBL ${hw?.connected ? "connected" : "not connected"}${hw?.homed ? ", homed" : ", not homed"} (unverified rig)` : "simulated twin; hardware disabled by default"}
        />
        <Service name="Active mission" status={!mission ? "OFF" : ["RUNNING", "PAUSED"].includes(mission.status) ? "ON" : "OFF"} detail={mission ? `${mission.id} ${mission.status.toLowerCase()}` : "none"} />
      </div>
      <ul className="grid grid-cols-2 gap-x-4 border-t border-line max-[759px]:grid-cols-1">
        {COMPONENTS.map((c, i) => {
          const on = highlight === c.id;
          return (
            <li key={c.id}>
              <button
                type="button"
                aria-pressed={sticky === c.id}
                className={clsx("grid w-full grid-cols-[22px_1fr] gap-x-1.5 border-b border-line py-1 pr-1 pl-1 text-left transition-colors duration-150", on ? "bg-panel-2" : "hover:bg-panel-2/60")}
                onMouseEnter={() => setHighlight(c.id)}
                onMouseLeave={() => setHighlight(sticky)}
                onFocus={() => setHighlight(c.id)}
                onBlur={() => setHighlight(sticky)}
                onClick={() => {
                  const next = sticky === c.id ? null : c.id;
                  setSticky(next);
                  setHighlight(next);
                }}
              >
                <span className={clsx("value text-[11px]", on ? "text-teal" : "text-dim")}>{pad2(i + 1)}</span>
                <span className={clsx("label", on ? "text-teal" : "text-text")}>{c.name}</span>
                <span />
                <span className="text-[11px] leading-snug text-muted">{c.text}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- 04 GANTRY AND NAVIGATION

const PAD_W = 250;
const PAD_H = (PAD_W * GANTRY.travelY) / GANTRY.travelX;

function XYPad() {
  // Re-render on every telemetry publish (20 Hz) so the target ring read off the engine is never stale.
  const pos = useSimStore((s) => s.telemetry.gantry);
  const plan = useSimStore((s) => s.plan);
  const estop = useSimStore((s) => s.telemetry.estop);
  const moveGantryTo = useSimStore((s) => s.moveGantryTo);
  const objects = useObjects();
  const g = useSimStore.getState().engine.gantry;
  const px = (x: number) => (x / GANTRY.travelX) * 100;
  const py = (y: number) => (y / GANTRY.travelY) * 100;

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (estop) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = clampNum(((e.clientX - r.left) / r.width) * GANTRY.travelX, 0, GANTRY.travelX);
    const y = clampNum(((e.clientY - r.top) / r.height) * GANTRY.travelY, 0, GANTRY.travelY);
    moveGantryTo(Math.round(x * 10) / 10, Math.round(y * 10) / 10);
  };

  // Arrow keys jog 5 cm (Shift: 1 cm) from the current target, so held keys queue a path rather than fighting the motion.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 1 : 5;
    const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const v = d[e.key];
    if (!v) return;
    e.preventDefault();
    e.stopPropagation();
    if (estop) return;
    moveGantryTo(clampNum(g.x.target + v[0], 0, GANTRY.travelX), clampNum(g.y.target + v[1], 0, GANTRY.travelY));
  };

  return (
    <div
      role="application"
      tabIndex={0}
      aria-label={`Gantry plan view. Carriage at ${f1(pos.x)}, ${f1(pos.y)} cm. Click a point or use the arrow keys to move; Shift for 1 cm steps.`}
      onKeyDown={onKey}
      className={clsx("relative shrink-0 border border-line-strong bg-panel-2/60 transition-colors focus-visible:border-teal", estop ? "cursor-not-allowed" : "cursor-crosshair")}
      style={{
        width: PAD_W,
        height: PAD_H,
        backgroundImage: "linear-gradient(to right, var(--color-line) 1px, transparent 1px), linear-gradient(to bottom, var(--color-line) 1px, transparent 1px)",
        backgroundSize: `${PAD_W / 10}px ${PAD_H / 4}px`,
        backgroundPosition: "-1px -1px",
      }}
      onClick={onClick}
      title={estop ? "Emergency stop latched" : "Click to move the gantry"}
      data-testid="xy-pad"
    >
      {plan && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          <polyline points={plan.waypoints.map((w) => `${px(w.x)},${py(w.y)}`).join(" ")} fill="none" stroke={C.amber} strokeOpacity={0.6} strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      {plan?.waypoints.map((w, i) => (
        <span key={i} className="absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-amber" style={{ left: `${px(w.x)}%`, top: `${py(w.y)}%` }} />
      ))}
      {objects.map((o) => (
        <span key={o.id} className={clsx("absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2", isTargetClass(o.type) ? "bg-amber" : "bg-muted")} style={{ left: `${px(o.x)}%`, top: `${py(o.y)}%` }} title={o.label} />
      ))}
      <span className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-amber" style={{ left: `${px(g.x.target)}%`, top: `${py(g.y.target)}%` }} />
      <span className="absolute h-px w-3 -translate-x-1/2 -translate-y-1/2 bg-teal" style={{ left: `${px(pos.x)}%`, top: `${py(pos.y)}%` }} />
      <span className="absolute h-3 w-px -translate-x-1/2 -translate-y-1/2 bg-teal" style={{ left: `${px(pos.x)}%`, top: `${py(pos.y)}%` }} />
    </div>
  );
}

export function GantryCard() {
  const t = useSimStore(useShallow((s) => ({ x: s.telemetry.gantry.x, y: s.telemetry.gantry.y, vx: s.telemetry.gantry.vx, vy: s.telemetry.gantry.vy, moving: s.telemetry.gantry.moving, atHome: s.telemetry.gantry.atHome, estop: s.telemetry.estop, mode: s.mode, phase: s.phase })));
  const { moveGantryTo, stop, trackObject } = useSimStore(useShallow((s) => ({ moveGantryTo: s.moveGantryTo, stop: s.stop, trackObject: s.trackObject })));
  const selected = useSimStore((s) => s.selectedObjectId);
  const hw = useMissionStore((s) => s.system?.gantry);
  const g = useSimStore.getState().engine.gantry;
  const remaining = Math.hypot(g.x.target - t.x, g.y.target - t.y);
  const rows: [string, string, string][] = [
    ["Coordinate", `${f1(t.x)}, ${f1(t.y)} cm`, "text-text"],
    ["Target", `${f1(g.x.target)}, ${f1(g.y.target)} cm`, "text-amber"],
    ["Path", `${f1(remaining)} cm left`, remaining > GANTRY.arriveTolerance ? "text-teal" : "text-muted"],
    ["Velocity", `${f1(t.vx)}, ${f1(t.vy)} cm/s`, t.moving ? "text-teal" : "text-text"],
    ["Limits", `X 0..${GANTRY.travelX}, Y 0..${GANTRY.travelY} cm (soft)`, "text-muted"],
    ["Homing", t.atHome ? "AT HOME" : "twin: always referenced", "text-muted"],
    ["Hardware", hw?.hardware ? `${hw.status?.driver} ${hw.status?.homed ? "homed" : "NOT HOMED"}` : "disabled (simulation)", hw?.hardware ? "text-text" : "text-dim"],
  ];
  return (
    <div>
      <CardHead
        title="Gantry and navigation"
        right={
          <span className="value text-[10px] text-muted">
            MODE <span className="text-teal">{t.mode}</span>&nbsp;&nbsp;PHASE <span className="text-teal">{t.phase}</span>
          </span>
        }
      />
      <div className="flex gap-4 max-[759px]:flex-col">
        <div className="shrink-0">
          <XYPad />
          <div className="value mt-0.5 flex justify-between text-[9px] text-dim">
            <span>home (0, 0)</span>
            <span>100 x 40 cm</span>
          </div>
        </div>
        <div className="grid min-w-0 flex-1 grid-cols-[auto_1fr] content-start gap-x-3 gap-y-[3px]">
          {rows.map(([k, v, cls]) => (
            <div key={k} className="contents">
              <span className="label">{k}</span>
              <span className={clsx("value truncate text-[11px]", cls)}>{v}</span>
            </div>
          ))}
        </div>
      </div>
      {t.estop && <p className="mt-2 text-[11px] text-danger">Emergency stop latched: manual moves and missions are refused until it is cleared from the top bar.</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Btn onClick={() => moveGantryTo(0, 0)} disabled={t.estop}>
          <Home size={14} /> Home
        </Btn>
        <Btn onClick={stop}>
          <Square size={14} /> Stop
        </Btn>
        <ObjectChips label="Centre on" activeId={selected} onPick={trackObject} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 06 ENVIRONMENT AND SCENARIO

function Slider({ label, value, min, max, step, show, onChange, disabled }: { label: string; value: number; min: number; max: number; step: number; show: string; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <label className={clsx("block", disabled && "opacity-50")}>
      <div className="mb-0.5 flex items-center justify-between">
        <span className="label">{label}</span>
        <span className="value text-[11px] text-text">{show}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(clampNum(parseFloat(e.target.value), min, max))} />
    </label>
  );
}

/** Uncontrolled number input that commits on blur or Enter and clamps to its range. Remounts when the store value changes. */
function NumField({ value, min, max, onCommit, label }: { value: number; min: number; max: number; onCommit: (v: number) => void; label: string }) {
  const commit = (el: HTMLInputElement) => {
    const n = Math.round(parseFloat(el.value));
    if (!Number.isFinite(n)) {
      el.value = String(value);
      return;
    }
    const v = clampNum(n, min, max);
    el.value = String(v);
    if (v !== value) onCommit(v);
  };
  return (
    <input
      key={value}
      type="number"
      aria-label={label}
      min={min}
      max={max}
      defaultValue={value}
      onBlur={(e) => commit(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      className="value w-14 border border-line-strong bg-panel-2 px-1 py-[2px] text-[11px] text-text outline-none [appearance:textfield] focus:border-teal [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
    />
  );
}

function ObjectRow({ index }: { index: number }) {
  const o = useSimStore(useShallow((s) => ({ id: s.scenario.objects[index].id, label: s.scenario.objects[index].label, type: s.scenario.objects[index].type, x: s.scenario.objects[index].x, y: s.scenario.objects[index].y })));
  const moveObject = useSimStore((s) => s.moveObject);
  return (
    <div className="grid grid-cols-[1fr_auto_auto] items-center gap-2 border-b border-line py-[3px]">
      <span className="min-w-0">
        <span className="value block truncate text-[10px] leading-tight text-text">{o.label}</span>
        <span className={clsx("label block text-[9px]", isTargetClass(o.type) ? "text-amber" : "text-muted")}>{o.type}</span>
      </span>
      <span className="flex items-center gap-1">
        <span className="label">X</span>
        <NumField label={`${o.label} X`} value={Math.round(o.x)} min={3} max={GANTRY.travelX - 3} onCommit={(v) => moveObject(o.id, v, o.y)} />
      </span>
      <span className="flex items-center gap-1">
        <span className="label">Y</span>
        <NumField label={`${o.label} Y`} value={Math.round(o.y)} min={3} max={GANTRY.travelY - 3} onCommit={(v) => moveObject(o.id, o.x, v)} />
      </span>
    </div>
  );
}

const COMPARE_ROWS: Array<[string, (r: MissionResult) => string, "higher" | "lower" | null]> = [
  ["Targets confirmed", (r) => String(r.confirmedTargets), "higher"],
  ["False positives", (r) => String(r.falsePositives), "lower"],
  ["Unreliable frames", (r) => String(r.unreliableCaptures), "lower"],
  ["Captures", (r) => String(r.captures), null],
  ["Re-observations", (r) => String(r.reobservations), null],
  ["Pauses", (r) => String(r.pauses), null],
  ["Duration", (r) => `${f1(r.durationS)} s`, null],
];

export function EnvironmentCard() {
  const sc = useSimStore(useShallow((s) => ({ turbidity: s.scenario.turbidity, lighting: s.scenario.lighting, threshold: s.scenario.threshold, gantrySpeed: s.scenario.gantrySpeed, count: s.scenario.objects.length, disturbances: s.scenario.disturbances })));
  const preset = useSimStore((s) => s.preset);
  const missionRunning = useSimStore((s) => s.mode === "MISSION");
  const { setScenario, applyPreset } = useSimStore(useShallow((s) => ({ setScenario: s.setScenario, applyPreset: s.applyPreset })));
  const plan = useMissionStore((s) => s.mission?.plan) ?? null;
  const [cmp, setCmp] = useState<{ adaptive: MissionResult; fixed: MissionResult; preset: PresetId | null; planId: string } | null>(null);
  const [objectsOpen, setObjectsOpen] = useState(false);
  const p = SCENARIO_PRESETS.find((x) => x.id === preset);

  const runCompare = () => {
    const usePlan = plan ?? DEMO_FIXTURE_PLAN;
    setCmp({ ...compareStrategies(useSimStore.getState().engine.scenario, usePlan), preset, planId: usePlan.missionId });
  };

  return (
    <div>
      <CardHead
        title="Environment and scenario"
        note="Every value here is synthetic and drives both the detector and the rendered water. Presets are the ten reproducible test scenarios."
        right={<SourceTag source="SIMULATED" />}
      />
      <div className="flex flex-wrap gap-1">
        {SCENARIO_PRESETS.map((x) => (
          <Chip key={x.id} tone="teal" active={preset === x.id} onClick={() => applyPreset(preset === x.id ? null : x.id)} disabled={missionRunning} title={x.text}>
            {x.id} {x.name}
          </Chip>
        ))}
      </div>
      <p className="mt-1 min-h-[16px] text-[11px] leading-snug text-muted">
        {p ? p.text : "Default layout, no scripted disturbances."}
        {sc.disturbances.length > 0 && <span className="text-dim"> Scripted: {sc.disturbances.map((d) => `${d.kind.toLowerCase().replace("_", " ")} at ${d.atS} s`).join(", ")}.</span>}
      </p>
      <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 max-[759px]:grid-cols-1">
        <Slider label="Turbidity" value={sc.turbidity} min={0} max={1} step={0.05} show={f2(sc.turbidity)} onChange={(v) => setScenario({ turbidity: v })} disabled={missionRunning && sc.disturbances.length > 0} />
        <Slider label="Lighting" value={sc.lighting} min={0} max={1} step={0.05} show={f2(sc.lighting)} onChange={(v) => setScenario({ lighting: v })} disabled={missionRunning && sc.disturbances.length > 0} />
        <Slider label="Detector threshold" value={sc.threshold} min={0.3} max={0.95} step={0.05} show={pct(sc.threshold, 0)} onChange={(v) => setScenario({ threshold: v })} />
        <Slider label="Manual gantry speed" value={sc.gantrySpeed} min={0.2} max={1} step={0.05} show={pct(sc.gantrySpeed, 0)} onChange={(v) => setScenario({ gantrySpeed: v })} />
      </div>

      <div className="mt-3 border-t border-line pt-2">
        <div className="flex flex-wrap items-center gap-2">
          <Btn onClick={runCompare} disabled={missionRunning} title="Runs the plan twice on private copies of the twin, with and without the visibility policy">
            <BarChart3 size={14} /> Compare strategies
          </Btn>
          <span className="text-[11px] text-muted">{plan ? `Uses plan ${plan.missionId}.` : "Uses the contract fixture plan (no mission planned yet)."}</span>
        </div>
        {cmp && (
          <div className="mt-2">
            <div className="grid grid-cols-[1fr_80px_80px] gap-x-3 gap-y-[2px]">
              <span className="label text-dim">Scenario {cmp.preset ?? "default"}, seed fixed</span>
              <span className="label text-right text-teal">Adaptive</span>
              <span className="label text-right">Fixed</span>
              {COMPARE_ROWS.map(([k, fmt, better]) => {
                const a = fmt(cmp.adaptive);
                const f = fmt(cmp.fixed);
                const an = parseFloat(a);
                const fn = parseFloat(f);
                const win = better === "higher" ? an > fn : better === "lower" ? an < fn : false;
                return (
                  <div key={k} className="contents">
                    <span className="label">{k}</span>
                    <span className={clsx("value text-right text-[11px]", win ? "text-teal" : "text-text")}>{a}</span>
                    <span className="value text-right text-[11px] text-text">{f}</span>
                  </div>
                );
              })}
            </div>
            <p className="mt-1 text-[10px] leading-snug text-dim">Measured just now on the simulated detector, not estimated. Rerunning gives identical numbers.</p>
          </div>
        )}
      </div>

      <button type="button" className="label mt-2 flex items-center gap-1.5 hover:text-text" onClick={() => setObjectsOpen((v) => !v)} aria-expanded={objectsOpen}>
        <span className="value text-[10px] text-dim">{objectsOpen ? "-" : "+"}</span> Object positions ({sc.count})
      </button>
      {objectsOpen && (
        <div className="mt-1 grid grid-cols-2 gap-x-6 border-t border-line max-[759px]:grid-cols-1">
          {Array.from({ length: sc.count }, (_, i) => (
            <ObjectRow key={i} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}
