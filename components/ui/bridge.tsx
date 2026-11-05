"use client";

import { useEffect, useRef } from "react";
import { api } from "@/lib/api/client";
import { connectEvents } from "@/lib/api/events";
import { DEMO_INSTRUCTION, DEMO_PHASES } from "@/lib/sim/demo";
import { useSimStore } from "@/lib/sim/store";
import { useMissionStore } from "@/lib/store/mission";

/**
 * Headless glue between the twin and the backend:
 * - system status every 5 s and the /ws/events socket (backend chip, report.ready),
 * - posts the twin's MissionResult to the backend when the mission the backend planned ends (or aborts the record if the twin was reset),
 * - during the demo, sends the recorded instruction through Voice Transcribe when the key is set (the typed instruction otherwise,
 *   labelled as such), asks the backend to plan it and hands the plan to the director.
 */
export function BackendBridge() {
  useEffect(() => {
    const ms = useMissionStore.getState();
    ms.loadLanguage();
    void ms.refreshStatus();
    void ms.refreshEvidence();
    const timer = setInterval(() => {
      const s = useMissionStore.getState();
      void s.refreshStatus();
      void s.refreshEvidence(); // the execution log and preflight back every execution label in the UI
    }, 5000);
    const dispose = connectEvents(
      (e) => useMissionStore.getState().onEvent(e),
      (state) => state === "OPEN" && void useMissionStore.getState().refreshStatus(),
    );
    return () => {
      clearInterval(timer);
      dispose();
    };
  }, []);

  // Mission completion: the twin decides when a mission ends; the backend records it.
  useEffect(
    () =>
      useSimStore.subscribe((s, prev) => {
        if (s.missionResult && s.missionResult !== prev.missionResult) void useMissionStore.getState().finishMission(s.missionResult);
        // Reset lab (or a demo start) drops the twin's mission without a result: close the backend record too, so it is not left RUNNING with nothing executing it.
        if (prev.mode === "MISSION" && s.mode !== "MISSION" && !s.missionResult) {
          const m = useMissionStore.getState().mission;
          if (m && (m.status === "RUNNING" || m.status === "PAUSED")) void api.stop(m.id).then((mission) => useMissionStore.setState({ mission }), () => undefined);
        }
      }),
    [],
  );

  // Demo: plan the instruction once per demo run, then mark it running on the backend.
  const requested = useRef(-1);
  useEffect(
    () =>
      useSimStore.subscribe((s) => {
        const d = s.demo;
        if (!d.active || d.plan || requested.current === d.run || DEMO_PHASES[d.phase]?.id !== "COMMAND") return;
        requested.current = d.run;
        const ms = useMissionStore.getState();
        ms.setInstruction(DEMO_INSTRUCTION);
        useMissionStore.setState({ transcript: null, interpretError: null });
        const voiceLive = ms.system?.providers.voice.status === "LIVE";
        // A failed transcription is shown in the demo card and the typed instruction is used; nothing is substituted silently.
        void (voiceLive ? ms.transcribeRecorded() : Promise.resolve(null)).then(() => useMissionStore.getState().interpret()).then(async (mission) => {
          const now = useSimStore.getState();
          if (!mission || !now.demo.active || now.demo.run !== d.run) return;
          await api.start(mission.id).then((m) => useMissionStore.setState({ mission: m }), () => undefined);
          now.setDemoPlan(mission.plan);
        });
      }),
    [],
  );
  return null;
}
