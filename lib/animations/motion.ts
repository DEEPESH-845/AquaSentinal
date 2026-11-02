/**
 * Motion tokens. One vocabulary for GSAP timelines, framer-motion presence transitions and CSS (app/globals.css).
 * Durations in seconds. Engineering instrumentation: no bounce, no elastic.
 */
export const DUR = {
  /** hover, press, toggles */
  fast: 0.18,
  /** state changes inside a panel */
  base: 0.3,
  /** panels opening, cards swapping */
  panel: 0.45,
  /** section entrances on the walkthrough */
  section: 0.7,
  /** camera moves and cinematic beats */
  cinematic: 1.1,
} as const;

export const EASE = {
  out: "power3.out",
  inOut: "power2.inOut",
  expo: "expo.out",
} as const;

/** The same curves for framer-motion, as cubic-beziers. */
export const BEZIER = {
  out: [0.215, 0.61, 0.355, 1] as [number, number, number, number],
  inOut: [0.455, 0.03, 0.515, 0.955] as [number, number, number, number],
} as const;

export const prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
