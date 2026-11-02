import { mkdirSync, writeFileSync } from "node:fs";
import { compareStrategies } from "../lib/sim/compare";
import { DEMO_FIXTURE_PLAN } from "../lib/sim/demo";
import { SCENARIO_PRESETS, presetScenario } from "../lib/sim/scenario";

/**
 * Fixed-speed versus adaptive inspection on every scenario preset, same plan (shared/fixtures/pipeline-plan.json), same seed.
 * SIMULATED: the digital twin's detector and water model, not a camera or a model. Each preset runs twice to prove replay.
 * Writes docs/evidence/adaptive-vs-fixed.json and prints a Markdown table.
 */
const keys = ["outcome", "captures", "unreliableCaptures", "reobservations", "pauses", "confirmedTargets", "falsePositives", "coverage", "durationS"] as const;
const rows = SCENARIO_PRESETS.map((p) => {
  const a = compareStrategies(presetScenario(p.id), DEMO_FIXTURE_PLAN);
  const b = compareStrategies(presetScenario(p.id), DEMO_FIXTURE_PLAN);
  const deterministic = JSON.stringify(a) === JSON.stringify(b);
  if (!deterministic) throw new Error(`preset ${p.id} is not reproducible`);
  const pick = (r: typeof a.adaptive) => Object.fromEntries(keys.map((k) => [k, typeof r[k] === "number" ? Math.round((r[k] as number) * 1000) / 1000 : r[k]]));
  return { preset: p.id, name: p.name, deterministic, fixed: pick(a.fixed), adaptive: pick(a.adaptive) };
});
mkdirSync("docs/evidence", { recursive: true });
writeFileSync(
  "docs/evidence/adaptive-vs-fixed.json",
  JSON.stringify({ classification: "SIMULATED", plan: DEMO_FIXTURE_PLAN.missionId, generatedBy: "npm run eval:adaptive", rows }, null, 2) + "\n",
);
console.log("| Preset | Strategy | Outcome | Captures | Unreliable | Re-obs | Pauses | Targets | False pos. | Coverage | Duration s |");
console.log("|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const r of rows)
  for (const [k, v] of [["fixed", r.fixed], ["adaptive", r.adaptive]] as const)
    console.log(`| ${r.preset} ${r.name} | ${k} | ${v.outcome} | ${v.captures} | ${v.unreliableCaptures} | ${v.reobservations} | ${v.pauses} | ${v.confirmedTargets} | ${v.falsePositives} | ${v.coverage} | ${v.durationS} |`);
console.log(`\nall ${rows.length} presets replayed identically; wrote docs/evidence/adaptive-vs-fixed.json`);
