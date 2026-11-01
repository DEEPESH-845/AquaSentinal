"use client";

import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import { DEMO_PHASES, createDemoDirector, stepDemo } from "@/lib/sim/demo";
import { useSimStore } from "@/lib/sim/store";

const PUBLISH_HZ = 20;

/**
 * The only simulation loop. Lives inside the R3F canvas so the engine, the 3D view
 * and the DOM read one consistent state. Publishes a snapshot to zustand at 20 Hz;
 * 3D components read engine fields directly in their own useFrame.
 */
export function SimDriver() {
  const acc = useRef(0);
  const director = useRef(createDemoDirector());
  const lastPhase = useRef(-1);
  const lastRun = useRef(-1);
  const demoClock = useRef(0);

  useFrame((_, delta) => {
    const s = useSimStore.getState();
    const dt = Math.min(delta, 0.1);

    if (s.demo.active) {
      if (s.demo.run !== lastRun.current) {
        director.current = createDemoDirector();
        lastPhase.current = -1;
        lastRun.current = s.demo.run;
        demoClock.current = 0;
      }
      if (!s.demo.paused) {
        const t = (demoClock.current += dt);
        const idx = stepDemo(director.current, t, s.engine, s.demo.plan);
        if (director.current.usedFixture !== s.demo.usedFixture) s.setDemoUsedFixture(director.current.usedFixture);
        if (idx !== lastPhase.current) {
          lastPhase.current = idx;
          s.setDemoPhase(idx);
          s.setScene(DEMO_PHASES[idx].scene);
        }
        s.engine.tick(dt);
      }
    } else {
      s.engine.tick(dt);
    }

    acc.current += dt;
    if (acc.current >= 1 / PUBLISH_HZ) {
      acc.current = 0;
      if (s.demo.active) s.setDemoTime(demoClock.current);
      s.publish();
    }
  });

  return null;
}
