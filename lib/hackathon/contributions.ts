/**
 * What AquaSentinal adds to the HydraLoom testbed (commit d59308e), and what it inherits.
 * docs/HACKATHON_CONTRIBUTIONS.md is the long form; docs/evidence/provenance.tsv is the per-file diff.
 *
 * Status rules, applied by hand and checked in review:
 * - implemented: the code exists and runs in the app.
 * - tested: an automated test exercises it (mocked HTTP, the simulated gantry or the digital twin).
 * - verified: evidence from a live Meta API call or physical hardware. Nothing reaches this without such evidence;
 *   a UI component or a passing mocked test is not verification.
 */

export type ContributionCategory = "meta_ai" | "perception" | "adaptive_control" | "robotics" | "inspection" | "safety";
export type ContributionOrigin = "new" | "adapted" | "inherited";
export type ContributionStatus = "planned" | "implemented" | "tested" | "verified";

export interface HackathonContribution {
  id: string;
  name: string;
  category: ContributionCategory;
  description: string;
  origin: ContributionOrigin;
  status: ContributionStatus;
  /** tests, scripts or files that support the status */
  evidence?: string[];
  /** the limit of that evidence, stated plainly */
  limitation?: string;
}

const MOCKED_ONLY = "Tested with mocked Meta HTTP only. No MODEL_API_KEY was available, so no live request has been logged.";

export const CONTRIBUTIONS: HackathonContribution[] = [
  {
    id: "voice-mission",
    name: "Voice-controlled mission creation",
    category: "meta_ai",
    description: "Push-to-talk audio is resampled to 16 kHz WAV in the browser and transcribed by Muse Voice Transcribe on the backend; the transcript feeds the planner.",
    origin: "new",
    status: "tested",
    evidence: ["backend/tests/test_integration.py::test_full_voice_to_report_pipeline", "backend/app/meta/voice.py", "lib/audio/wav.ts"],
    limitation: MOCKED_ONLY,
  },
  {
    id: "spark-planning",
    name: "Muse Spark mission interpretation",
    category: "meta_ai",
    description: "An agent loop offers four allowlisted tools; Muse Spark reads telemetry and calls create_inspection_mission. Invalid calls go back to the model as errors, at most six turns.",
    origin: "new",
    status: "tested",
    evidence: ["backend/tests/test_integration.py::test_full_voice_to_report_pipeline", "backend/tests/test_integration.py::test_unsafe_model_output_never_becomes_a_mission", "backend/app/meta/spark.py"],
    limitation: MOCKED_ONLY,
  },
  {
    id: "validated-actions",
    name: "Natural language to validated robot actions",
    category: "safety",
    description: "Model output is a MissionSpec, never a motor command. Pydantic validation, a phase allowlist and the plan compiler bound every waypoint, speed and threshold before the operator approves.",
    origin: "new",
    status: "tested",
    evidence: ["backend/tests/test_mission_logic.py", "backend/tests/test_contracts.py", "backend/app/mission/compiler.py", "backend/app/mission/tools.py"],
  },
  {
    id: "frame-reasoning",
    name: "Muse Spark visual scene reasoning",
    category: "meta_ai",
    description: "On the first frame of a mission Muse Spark names the concrete noun phrases to segment, with structured JSON output; unmentioned targets keep a fallback phrase.",
    origin: "new",
    status: "tested",
    evidence: ["backend/tests/test_integration.py::test_full_voice_to_report_pipeline", "backend/app/perception/pipeline.py"],
    limitation: MOCKED_ONLY,
  },
  {
    id: "sam-segmentation",
    name: "SAM 3.1 underwater segmentation",
    category: "perception",
    description: "One text concept per request on each captured frame; masks parsed with Meta's meta-sam-parser, reduced to polygons, back-projected to gantry coordinates and scored against the twin's ID pass.",
    origin: "new",
    status: "tested",
    evidence: ["backend/tests/test_meta.py", "backend/tests/test_integration.py", "backend/app/meta/sam.py", "backend/app/evaluation.py (live IoU section)"],
    limitation: MOCKED_ONLY,
  },
  {
    id: "tracking",
    name: "Persistent inspection object tracking",
    category: "perception",
    description: "Observations are associated to persistent assets by position and label evidence across captures and across missions; an asset keeps its id between inspections.",
    origin: "new",
    status: "tested",
    evidence: ["backend/tests/test_tracking.py", "backend/app/perception/tracking.py"],
  },
  {
    id: "image-quality",
    name: "Image-quality-based inspection decisions",
    category: "perception",
    description: "OpenCV RMS contrast and Laplacian sharpness give a visibility estimate and a GOOD, DEGRADED or UNRELIABLE band for every capture; the backend executor's visibility controller slows or pauses on that estimate.",
    origin: "new",
    status: "tested",
    evidence: ["backend/tests/test_quality.py", "backend/tests/test_integration.py::test_backend_executor_on_the_simulated_gantry", "backend/app/perception/quality.py"],
    limitation: "Constants fitted to digital-twin frames; real underwater frames are unfitted. In twin missions the controller reads the twin's simulated visibility.",
  },
  {
    id: "adaptive-perception",
    name: "Sensor-conditioned adaptive inspection",
    category: "adaptive_control",
    description: "A deterministic visibility controller, not the language model, slows the scan in degraded water, pauses when unsafe, refuses operator resume while unsafe, and re-observes uncertain detections.",
    origin: "new",
    status: "tested",
    evidence: ["npm run sim:check (missions section)", "npm run eval:adaptive -> docs/evidence/adaptive-vs-fixed.json", "lib/sim/perception.ts", "backend/app/perception/controller.py"],
    limitation: "Simulated water and detector only. Visibility is an image-derived estimate, not a calibrated turbidity sensor.",
  },
  {
    id: "turbidity-telemetry",
    name: "Environmental telemetry and turbidity schedule",
    category: "adaptive_control",
    description: "Scripted turbidity, lighting and camera-dropout disturbances, live environment telemetry and per-capture water state. HydraLoom had a static turbidity value; the schedule and telemetry are new.",
    origin: "adapted",
    status: "tested",
    evidence: ["npm run sim:check", "lib/sim/engine.ts", "lib/sim/scenario.ts"],
    limitation: "SIMULATED: there is no physical turbidity sensor in this build.",
  },
  {
    id: "orchestration",
    name: "Adaptive inspection mission orchestration",
    category: "robotics",
    description: "Mission lifecycle with an operator approval gate, a MISSION mode in the twin that executes the compiled plan and captures at waypoints, and a backend executor for the gantry driver.",
    origin: "adapted",
    status: "tested",
    evidence: ["backend/tests/test_api.py", "backend/tests/test_integration.py::test_backend_executor_on_the_simulated_gantry", "e2e/mission.spec.ts"],
    limitation: "Twin execution only; the backend executor has run against the simulated driver, never a physical gantry.",
  },
  {
    id: "evidence",
    name: "Inspection evidence generation and storage",
    category: "inspection",
    description: "Every capture, segmentation, observation and summary is stored in SQLite with its frame on disk and its provider; reports mark anomaly candidates as unverified.",
    origin: "new",
    status: "tested",
    evidence: ["backend/tests/test_api.py::test_offline_mission_lifecycle_capture_and_report", "backend/app/reporting.py", "backend/app/db.py"],
  },
  {
    id: "history",
    name: "Inspection history and comparative reporting",
    category: "inspection",
    description: "Mission history, persistent assets across missions, JSON and Markdown reports, and the same plan replayed with and without the adaptive policy.",
    origin: "new",
    status: "tested",
    evidence: ["backend/tests/test_api.py::test_missions_and_assets_persist_across_restarts", "lib/sim/compare.ts"],
  },
  {
    id: "safety",
    name: "Safety mechanisms for AI-directed inspection",
    category: "safety",
    description: "Latching emergency stop in twin and backend, start refused while latched, soft limits, watchdog and a GRBL 1.1 driver behind interlocks, disabled by default.",
    origin: "new",
    status: "tested",
    evidence: ["backend/tests/test_hardware.py", "e2e/estop.spec.ts", "npm run sim:check"],
    limitation: "Driver tested against a fake GRBL controller. Never run on physical hardware.",
  },
  {
    id: "scenarios",
    name: "Inspection scenarios A to J",
    category: "robotics",
    description: "Ten reproducible presets on a new pipeline layout: loose cable, foreign objects, occlusion, turbidity, lighting, segmentation failure, camera dropout, gantry limit, multiple targets.",
    origin: "adapted",
    status: "tested",
    evidence: ["npm run sim:check", "npm run eval:adaptive", "lib/sim/scenario.ts"],
  },
  {
    id: "execution-log",
    name: "Model execution log and judge preflight",
    category: "meta_ai",
    description: "Every Meta request is logged with model, operation, references, timing, outcome and LIVE_META, LIVE_META_FAILED or MOCKED, decided by the transport. The preflight never counts a mocked call as connectivity.",
    origin: "new",
    status: "tested",
    evidence: ["backend/tests/test_integration.py", "backend/tests/test_api.py::test_preflight_reports_missing_credentials_as_blockers", "GET /api/evidence/model-executions"],
  },
  {
    id: "evaluation",
    name: "Evaluation harness",
    category: "inspection",
    description: "Hand-labelled mission-parsing set, SAM IoU on captured twin frames, voice-derived versus manual parameters, fixed versus adaptive sweep on all presets with a replay check.",
    origin: "new",
    status: "implemented",
    evidence: ["npm run eval:meta -> docs/evidence/evaluation.json", "npm run eval:adaptive"],
    limitation: "Live sections (Spark, Voice, SAM) have not run: they need MODEL_API_KEY.",
  },
];

/** Foundations reused from HydraLoom. Shown as context, never labelled hackathon-built. */
export const INHERITED: HackathonContribution[] = [
  { id: "scene-3d", name: "Three.js tank, gantry, electronics and camera rig", category: "robotics", description: "Aquarium.tsx, Gantry.tsx, Electronics.tsx and CameraRig.tsx are byte-identical to HydraLoom.", origin: "inherited", status: "implemented", evidence: ["docs/evidence/provenance.tsv"] },
  { id: "sim-core", name: "Deterministic engine core", category: "robotics", description: "Trapezoidal gantry motion, the geometric detection model, the seeded RNG and the step controller are unchanged.", origin: "inherited", status: "tested", evidence: ["lib/sim/gantry.ts", "lib/sim/detection.ts", "lib/sim/rng.ts", "lib/sim/policy.ts"] },
  { id: "feed", name: "Gantry camera feed renderer", category: "perception", description: "Scissored second render from the carriage lens. Capture of inspection frames was added on top.", origin: "inherited", status: "implemented", evidence: ["components/lab/FeedRenderer.tsx"] },
  { id: "ui-foundation", name: "Zustand store, design tokens and UI primitives", category: "inspection", description: "Store architecture, 20 Hz snapshot publishing, colours, type and panel styles.", origin: "inherited", status: "implemented", evidence: ["lib/sim/store.ts", "app/globals.css", "components/ui/shared.tsx"] },
];

/** Where each scene of the app comes from, for the provenance badge on its card. */
export const SCENE_ORIGIN: Record<number, { origin: ContributionOrigin; note: string }> = {
  1: { origin: "adapted", note: "HydraLoom overview card, rewritten for missions" },
  2: { origin: "inherited", note: "HydraLoom component list; the model and driver service list is new" },
  3: { origin: "new", note: "SAM 3.1 segmentation, frame reasoning and tracks" },
  4: { origin: "inherited", note: "HydraLoom gantry jog pad and travel map" },
  5: { origin: "new", note: "Voice, Muse Spark planning and validated execution" },
  6: { origin: "new", note: "Turbidity schedule and fixed versus adaptive comparison" },
  7: { origin: "new", note: "Evidence-backed report and history" },
  8: { origin: "new", note: "Pipeline status, execution log and judge preflight" },
};
