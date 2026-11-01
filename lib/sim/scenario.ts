import type { Disturbance, Scenario, TestObject } from "./types";
import { TEST } from "./constants";

/**
 * HydraLoom's original layout (HydraLoom docs/BLUEPRINT.md 2.6), kept verbatim apart from the `model` field.
 * It is no longer shown in the product; `npm run sim:check` runs the original golden calibration against it so the
 * migrated detection, gantry and controller maths are proven unchanged.
 */
export const REFERENCE_OBJECTS: TestObject[] = [
  { id: "wreck-01", type: "SHIPWRECK", model: "wreck", label: "Shipwreck section", x: 60, y: 26, z: 0.035, halfExtents: [0.11, 0.035, 0.05], rotation: 25, detectability: 0.98, burial: 0.3 },
  { id: "mine-01", type: "MINE", model: "mine", label: "Training mine (inert)", x: 32, y: 8, z: 0.04, halfExtents: [0.05, 0.05, 0.05], rotation: 0, detectability: 0.95, burial: 0.05 },
  { id: "debris-pipe", type: "DEBRIS", model: "pipe", label: "Pipe section", x: 45, y: 33, z: 0.015, halfExtents: [0.06, 0.015, 0.015], rotation: -40, detectability: 0.7, burial: 0.1, confusableAs: "MINE" },
  { id: "debris-bracket", type: "DEBRIS", model: "bracket", label: "Steel bracket", x: 85, y: 8, z: 0.012, halfExtents: [0.04, 0.012, 0.03], rotation: 70, detectability: 0.72, burial: 0.2 },
  { id: "debris-rocks", type: "DEBRIS", model: "rocks", label: "Rock cluster", x: 15, y: 31, z: 0.02, halfExtents: [0.05, 0.02, 0.04], rotation: 10, detectability: 0.6, burial: 0.35 },
  { id: "debris-crate", type: "DEBRIS", model: "crate", label: "Plastic crate", x: 93, y: 35, z: 0.025, halfExtents: [0.04, 0.025, 0.03], rotation: -15, detectability: 0.85, burial: 0.4 },
];

/**
 * AquaSentinal inspection layout. A 5 cm pipeline runs the length of the tank at y = 20 in three 28 cm sections joined by
 * flanges, with a gate valve on the middle section. Around it: a loose cable, a rope offcut that a detector can mistake for
 * a cable, foreign objects, a concrete inspection panel and rocks. Positions are gantry cm; extents are world metres.
 */
export const INSPECTION_OBJECTS: TestObject[] = [
  { id: "pipe-a", type: "PIPE_SEGMENT", model: "pipe-segment", label: "Pipe section A", x: 20, y: 20, z: 0.025, halfExtents: [0.14, 0.025, 0.025], rotation: 0, detectability: 0.9, burial: 0.2 },
  { id: "joint-1", type: "PIPE_JOINT", model: "pipe-joint", label: "Flange joint 1", x: 35, y: 20, z: 0.025, halfExtents: [0.012, 0.04, 0.04], rotation: 0, detectability: 0.86, burial: 0.2 },
  { id: "pipe-b", type: "PIPE_SEGMENT", model: "pipe-segment", label: "Pipe section B", x: 50, y: 20, z: 0.025, halfExtents: [0.14, 0.025, 0.025], rotation: 0, detectability: 0.9, burial: 0.2 },
  { id: "valve-1", type: "VALVE", model: "valve", label: "Gate valve", x: 50, y: 20, z: 0.055, halfExtents: [0.035, 0.055, 0.04], rotation: 0, detectability: 0.93, burial: 0.05 },
  { id: "joint-2", type: "PIPE_JOINT", model: "pipe-joint", label: "Flange joint 2", x: 65, y: 20, z: 0.025, halfExtents: [0.012, 0.04, 0.04], rotation: 0, detectability: 0.86, burial: 0.2 },
  { id: "pipe-c", type: "PIPE_SEGMENT", model: "pipe-segment", label: "Pipe section C", x: 80, y: 20, z: 0.025, halfExtents: [0.14, 0.025, 0.025], rotation: 0, detectability: 0.9, burial: 0.2 },
  { id: "cable-1", type: "LOOSE_CABLE", model: "cable", label: "Loose cable", x: 66, y: 30, z: 0.006, halfExtents: [0.1, 0.006, 0.05], rotation: 20, detectability: 0.84, burial: 0.1 },
  { id: "rope-1", type: "DEBRIS", model: "rope", label: "Rope offcut", x: 41, y: 7, z: 0.005, halfExtents: [0.05, 0.005, 0.02], rotation: -15, detectability: 0.76, burial: 0.1, confusableAs: "LOOSE_CABLE" },
  { id: "crate-1", type: "FOREIGN_OBJECT", model: "crate", label: "Plastic crate", x: 25, y: 32, z: 0.025, halfExtents: [0.04, 0.025, 0.03], rotation: -12, detectability: 0.86, burial: 0.3 },
  { id: "wrench-1", type: "FOREIGN_OBJECT", model: "wrench", label: "Dropped wrench", x: 85, y: 9, z: 0.006, halfExtents: [0.045, 0.006, 0.015], rotation: 35, detectability: 0.8, burial: 0 },
  { id: "panel-1", type: "INSPECTION_PANEL", model: "panel", label: "Inspection panel", x: 10, y: 8, z: 0.01, halfExtents: [0.06, 0.01, 0.05], rotation: 8, detectability: 0.88, burial: 0.2 },
  { id: "rocks-1", type: "DEBRIS", model: "rocks", label: "Rock cluster", x: 76, y: 33, z: 0.02, halfExtents: [0.05, 0.02, 0.04], rotation: 10, detectability: 0.6, burial: 0.35 },
];

const clone = (objs: TestObject[]) => objs.map((o) => ({ ...o, halfExtents: [...o.halfExtents] as TestObject["halfExtents"] }));

const BASE = { turbidity: 0.15, lighting: 0.8, threshold: 0.6, gantrySpeed: 0.65, seed: TEST.seed } as const;

/** The product's default: pipeline inspection, clear water, no disturbances. */
export function defaultScenario(): Scenario {
  return { objects: clone(INSPECTION_OBJECTS), ...BASE, disturbances: [], perceptionFault: "NONE" };
}

/** HydraLoom's calibration scenario, used by sim:check to prove the migrated maths unchanged. */
export function referenceScenario(): Scenario {
  return { objects: clone(REFERENCE_OBJECTS), ...BASE, disturbances: [], perceptionFault: "NONE" };
}

export type PresetId = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J";

export interface ScenarioPreset {
  id: PresetId;
  name: string;
  text: string;
  turbidity?: number;
  lighting?: number;
  disturbances?: Disturbance[];
  perceptionFault?: Scenario["perceptionFault"];
  objectPatches?: Record<string, Partial<TestObject>>;
  extraObjects?: TestObject[];
}

/** The brief's ten reproducible scenarios. Every one is a pure function of this table and the seed. */
export const SCENARIO_PRESETS: ScenarioPreset[] = [
  { id: "A", name: "Clear-water pipeline", text: "Baseline: clear water, good light, nothing scripted.", turbidity: 0.1, lighting: 0.85 },
  { id: "B", name: "Loose cable", text: "The cable has drifted across the pipeline next to the valve.", objectPatches: { "cable-1": { x: 46, y: 26, rotation: -30 } } },
  { id: "C", name: "Foreign objects", text: "The wrench lies against the pipe and the crate sits on the line.", objectPatches: { "wrench-1": { x: 57, y: 15 }, "crate-1": { x: 30, y: 25 } } },
  { id: "D", name: "Partial occlusion", text: "The cable is half buried in sand, so less of it is visible.", objectPatches: { "cable-1": { burial: 0.55, detectability: 0.72 } } },
  {
    id: "E",
    name: "Turbidity increase",
    text: "Silt rises mid-scan, peaks past the unsafe limit, then settles.",
    disturbances: [
      { kind: "TURBIDITY", atS: 4, value: 0.55, rampS: 4 },
      { kind: "TURBIDITY", atS: 10, value: 0.9, rampS: 3 },
      { kind: "TURBIDITY", atS: 26, value: 0.2, rampS: 4 },
    ],
  },
  { id: "F", name: "Lighting degradation", text: "The tank lights fade to 15 percent during the scan.", disturbances: [{ kind: "LIGHTING", atS: 10, value: 0.15, rampS: 8 }] },
  { id: "G", name: "Segmentation failure", text: "Test fixture: the backend's offline segmentation provider fails every request.", perceptionFault: "SEGMENTATION_FAILURE" },
  { id: "H", name: "Camera disconnect", text: "The camera drops out for 5 seconds mid-scan.", disturbances: [{ kind: "CAMERA_DROPOUT", atS: 12, durationS: 5 }] },
  { id: "I", name: "Gantry limit", text: "The wrench sits in the far corner, so the scan must reach the soft travel limits.", objectPatches: { "wrench-1": { x: 97, y: 37 } } },
  {
    id: "J",
    name: "Multiple targets",
    text: "A second cable and a second foreign object share the field of view.",
    extraObjects: [
      { id: "cable-2", type: "LOOSE_CABLE", model: "cable", label: "Loose cable 2", x: 30, y: 12, z: 0.006, halfExtents: [0.08, 0.006, 0.04], rotation: -25, detectability: 0.82, burial: 0.1 },
      { id: "crate-2", type: "FOREIGN_OBJECT", model: "crate", label: "Plastic crate 2", x: 70, y: 9, z: 0.025, halfExtents: [0.04, 0.025, 0.03], rotation: 30, detectability: 0.86, burial: 0.3 },
    ],
  },
];

/** Builds the scenario for a preset from the defaults, so presets never compound. */
export function presetScenario(id: PresetId): Scenario {
  const p = SCENARIO_PRESETS.find((x) => x.id === id);
  const s = defaultScenario();
  if (!p) return s;
  for (const o of s.objects) Object.assign(o, p.objectPatches?.[o.id] ?? {});
  if (p.extraObjects) s.objects.push(...clone(p.extraObjects));
  return {
    ...s,
    turbidity: p.turbidity ?? s.turbidity,
    lighting: p.lighting ?? s.lighting,
    disturbances: (p.disturbances ?? []).map((d) => ({ ...d })),
    perceptionFault: p.perceptionFault ?? "NONE",
  };
}
