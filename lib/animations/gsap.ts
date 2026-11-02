"use client";

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useLayoutEffect, type DependencyList, type RefObject } from "react";
import { DUR, EASE } from "./motion";

/**
 * The only place GSAP plugins are registered. Import gsap from here, not from "gsap", in components.
 * Camera moves are wall-clock: without lagSmoothing(0) a slow frame makes GSAP step 33 ms per frame and a 1.4 s
 * camera move can take tens of seconds on a struggling GPU.
 */
if (typeof window !== "undefined") {
  gsap.registerPlugin(ScrollTrigger);
  gsap.ticker.lagSmoothing(0);
  gsap.defaults({ duration: DUR.base, ease: EASE.out });
}

export { gsap, ScrollTrigger };

/**
 * Runs `setup` inside a gsap.context scoped to `scope` and reverts it on unmount or when deps change, which kills
 * every tween, timeline and ScrollTrigger the setup created. Nothing survives a route change.
 * The setup may return a cleanup for listeners it added itself.
 */
export function useGsap(setup: (ctx: gsap.Context) => void | (() => void), deps: DependencyList, scope?: RefObject<Element | null>) {
  useLayoutEffect(() => {
    let extra: void | (() => void);
    const ctx = gsap.context((self) => {
      extra = setup(self);
    }, scope?.current ?? undefined);
    return () => {
      extra?.();
      ctx.revert();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
