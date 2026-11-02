"use client";

import clsx from "clsx";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { useSimStore } from "@/lib/sim/store";
import { useMissionStore } from "@/lib/store/mission";
import { f1, f2, pad2, pct } from "./shared";

function Row({ k, v, tone }: { k: string; v: ReactNode; tone?: "teal" | "amber" }) {
  return (
    <>
      <span className="label truncate">{k}</span>
      <span className={clsx("value whitespace-nowrap text-right text-[11px] tabular-nums", tone === "teal" ? "text-teal" : tone === "amber" ? "text-amber" : "text-text")}>{v}</span>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-t border-line px-2.5 py-1 first:border-t-0">
      <div className="label mb-0.5 text-[9px] text-dim">{title}</div>
      <div className="grid grid-cols-[auto_1fr_auto_1fr] gap-x-3 gap-y-[2px]">{children}</div>
    </div>
  );
}

/** Slices are selected with useShallow so the panel re-renders only when a displayed value changes. */
export function Telemetry() {
  const paused = useSimStore((s) => s.demo.active && s.demo.paused);
  const g = useSimStore(
    useShallow((s) => ({ x: s.telemetry.gantry.x, y: s.telemetry.gantry.y, vx: s.telemetry.gantry.vx, vy: s.telemetry.gantry.vy, moving: s.telemetry.gantry.moving, atHome: s.telemetry.gantry.atHome })),
  );
  const cam = useSimStore(useShallow((s) => ({ fps: s.telemetry.camera.fps, res: s.telemetry.camera.resolution })));
  const vis = useSimStore(useShallow((s) => ({ count: s.telemetry.vision.count, inFrame: s.telemetry.vision.inFrame, best: s.telemetry.vision.bestConfidence, hz: s.telemetry.vision.hz })));
  const env = useSimStore(useShallow((s) => s.telemetry.environment));
  const m = useSimStore(useShallow((s) => (s.mission ? { status: s.mission.status, perception: s.mission.perception, wp: s.mission.waypointIndex, n: s.mission.waypointsPlanned, speed: s.mission.speedFraction, live: s.mode === "MISSION" } : null)));
  const estop = useSimStore((s) => s.telemetry.estop);
  const time = useSimStore((s) => Math.floor(s.telemetry.time * 10) / 10);
  const ai = useMissionStore(
    useShallow((s) => {
      const u = s.system?.usage ?? {};
      const sam = Object.entries(u).find(([k]) => k.startsWith("sam"))?.[1];
      const cost = Object.values(u).reduce((a, v) => a + v.estimatedCostUsd, 0);
      return { live: s.system?.providers.sam.status === "LIVE", backend: s.backend, samReq: sam?.requests ?? 0, samLat: sam?.avgLatencyMs ?? null, cost, active: s.system?.inference.active ?? 0 };
    }),
  );

  const open = useSimStore((s) => s.panels.telemetry);
  const setPanels = useSimStore((s) => s.setPanels);

  return (
    <div className="panel">
      <div className={clsx("flex items-center justify-between gap-2 px-2.5 py-1.5", open && "border-b border-line")}>
        <span className="label text-text">Telemetry</span>
        <span className="flex items-center gap-1.5">
          <span className="sim-tag">SIMULATED</span>
          <button type="button" className="btn btn-icon p-0.5!" aria-expanded={open} aria-label={open ? "Collapse telemetry" : "Expand telemetry"} onClick={() => setPanels({ telemetry: !open })}>
            {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        </span>
      </div>
      {open && (
        <>
      <Section title="Gantry">
        <Row k="X" v={`${f1(g.x)} cm`} />
        <Row k="Y" v={`${f1(g.y)} cm`} />
        <Row k="VX" v={`${f1(g.vx)} cm/s`} />
        <Row k="VY" v={`${f1(g.vy)} cm/s`} />
        <Row k="State" v={estop ? "E-STOP" : paused ? "PAUSED" : g.moving ? "MOVING" : "HOLDING"} tone={estop ? "amber" : g.moving && !paused ? "teal" : undefined} />
        <Row k="At home" v={g.atHome ? "YES" : "NO"} />
      </Section>
      <Section title="Environment (simulated)">
        <Row k="Turbidity" v={f2(env.turbidity)} />
        <Row k="Lighting" v={f2(env.lighting)} />
        <Row k="Visibility" v={pct(env.visibility, 0)} tone={env.visibility < 0.45 ? "amber" : "teal"} />
        <Row k="Camera" v={`${cam.fps} fps`} />
      </Section>
      <Section title="Sim detector">
        <Row k="Detected" v={pad2(vis.count)} tone={vis.count > 0 ? "amber" : undefined} />
        <Row k="Best" v={pct(vis.best)} />
        <Row k="In frame" v={pad2(vis.inFrame)} />
        <Row k="Rate" v={`${vis.hz} Hz`} />
      </Section>
      <Section title="Mission">
        <Row k="Status" v={m?.live ? m.status : "IDLE"} tone={m?.live ? "teal" : undefined} />
        <Row k="Waypoint" v={m?.live ? `${Math.min(m.wp + 1, m.n)}/${m.n}` : "-"} />
        <Row k="State" v={m?.live ? m.perception.split("_")[0] : "-"} tone={m?.live && m.perception !== "NORMAL_VISIBILITY" ? "amber" : undefined} />
        <Row k="Speed" v={m?.live ? pct(m.speed, 0) : "-"} />
      </Section>
      <Section title="AI">
        <Row k="SAM" v={ai.live ? "LIVE" : ai.backend === "ONLINE" ? "OFFLINE" : "-"} tone={ai.live ? "teal" : "amber"} />
        <Row k="Requests" v={ai.samReq} />
        <Row k="Latency" v={ai.samLat !== null ? `${Math.round(ai.samLat)} ms` : "-"} />
        <Row k="Cost est." v={`$${ai.cost.toFixed(3)}`} />
        <Row k="In flight" v={ai.active} />
        <Row k="Sim time" v={`${f1(time)} s`} />
      </Section>
        </>
      )}
    </div>
  );
}

const KIND_TONE: Record<string, string> = { PHASE: "text-text", WAYPOINT: "text-muted", DETECT: "text-amber", TARGET: "text-amber", RL: "text-dim", RESULT: "text-teal" };

/** The twin's own event log: what the controller did and when, in sim seconds. Newest first. */
export function MissionLog() {
  const events = useSimStore((s) => s.events);
  const last = events.slice(-7).reverse();
  return (
    <div className="panel" data-testid="mission-log">
      <div className="flex items-center justify-between border-b border-line px-2.5 py-1.5">
        <span className="label text-text">Twin event log</span>
        <span className="sim-tag">SIMULATED</span>
      </div>
      <ol className="px-2.5 py-1" aria-live="off">
        {last.length === 0 && <li className="py-0.5 text-[11px] text-dim">No events yet. Move the gantry or run a mission.</li>}
        {last.map((e, i) => (
          <li key={`${e.t}-${i}-${e.text}`} className="grid grid-cols-[38px_1fr] gap-x-2 py-[2px]">
            <span className="value text-[10px] text-dim">{f1(e.t)}s</span>
            <span className={clsx("value truncate text-[10px]", KIND_TONE[e.kind])} title={e.text}>
              {e.text}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
