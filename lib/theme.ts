/**
 * Semantic colours for code that cannot read CSS variables: SVG attributes, canvas and Three.js materials.
 * Mirrors the @theme tokens in app/globals.css; change both together.
 * Teal = active or healthy, amber = inspection target or warning, danger = a real fault or safety condition.
 */
export const C = {
  ground: "#080f16",
  ground2: "#0c1620",
  panel: "#101d28",
  panel2: "#162633",
  line: "#22323e",
  lineStrong: "#344857",
  text: "#e9f0f4",
  muted: "#94a6b2",
  dim: "#7a8e9b",
  teal: "#42d6c5",
  cyan: "#31afc8",
  amber: "#f2b45d",
  danger: "#f16f70",
  ok: "#59d5a0",
} as const;
