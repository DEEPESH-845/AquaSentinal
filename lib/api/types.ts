/**
 * Wire types for the backend. Mirrors backend/app/schemas.py (camelCase). Only fields the UI reads are listed for the
 * large report object; everything else is typed exactly.
 */
import type { MissionPlan } from "@/lib/sim/types";

export type ProviderStatus = { status: "LIVE" | "OFFLINE"; model: string; fallback: string | null };

export interface SystemStatus {
  version: string;
  mode: "SIMULATION" | "HARDWARE";
  hardwareEnabled: boolean;
  hardwareActive: boolean;
  providers: { spark: ProviderStatus; sam: ProviderStatus; voice: ProviderStatus };
  usage: Record<string, { requests: number; errors: number; retries: number; promptTokens: number; completionTokens: number; images: number; audioMs: number; avgLatencyMs: number | null; estimatedCostUsd: number; lastError: string | null }>;
  inference: { active: number; concurrency: number };
  gantry: { estop: boolean; fault: string | null; hardware: boolean; status: GantryStatus | null };
  camera: { source: string; online: boolean; lastFrameAgeS: number | null; resolution: string | null; error: string | null; verifiedHardware: boolean };
  db: boolean;
}

export interface GantryStatus {
  driver: "SIMULATED" | "SERIAL_GRBL";
  connected: boolean;
  homed: boolean;
  requiresHoming: boolean;
  x: number;
  y: number;
  moving: boolean;
  state: string;
  fault: string | null;
  lastCommand: string | null;
}

export type TargetClass = "pipe_segment" | "pipe_joint" | "valve" | "loose_cable" | "foreign_object" | "inspection_panel" | "debris";
export type Provider = "MUSE_SPARK" | "OFFLINE_RULE_PARSER" | "OPERATOR";

export interface MissionSpec {
  missionId: string;
  objective: "pipeline_inspection" | "area_survey" | "target_search";
  targets: TargetClass[];
  scanPattern: "left_to_right" | "right_to_left" | "serpentine";
  region: { xMin: number; xMax: number; yMin: number; yMax: number };
  laneSpacingCm: number;
  captureSpacingCm: number;
  speedFraction: number;
  priority: "low" | "normal" | "high";
  recordEvidence: boolean;
  visibilityPolicy: { reduceSpeedOnDegradation: boolean; stopOnUnsafeVisibility: boolean; degradedVisibility: number; unsafeVisibility: number; reducedSpeedFraction: number };
  notes: string;
}

export interface ToolCallRecord {
  name: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  result: unknown;
  error: string | null;
  phase: "PLANNING" | "EXECUTION" | "REPORTING";
  by: "MUSE_SPARK" | "OFFLINE_RULE_PARSER" | "OPERATOR" | "SYSTEM";
  at: number;
}

export interface MissionRecord {
  id: string;
  createdAt: number;
  instruction: string;
  provider: Provider;
  status: "DRAFT" | "PLANNED" | "APPROVED" | "RUNNING" | "PAUSED" | "COMPLETED" | "ABORTED" | "FAILED";
  spec: MissionSpec;
  plan: MissionPlan;
  planSummary: { waypointCount: number; captureCount: number; pathLengthCm: number; estimatedDurationS: number; lanes: number };
  explanation: string;
  warnings: string[];
  timeline: ToolCallRecord[];
  result: Record<string, unknown> | null;
  executor: "TWIN" | "BACKEND" | null;
}

export interface InterpretResponse {
  mission: MissionRecord;
  provider: Provider;
  model: string | null;
}

export interface ImageQuality {
  brightness: number;
  contrast: number;
  sharpness: number;
  redBlueRatio: number;
  visibilityEstimate: number;
  band: "GOOD" | "DEGRADED" | "UNRELIABLE";
  source: "IMAGE_DERIVED_ESTIMATE";
}

export interface SegInstance {
  instanceId: string;
  prompt: string;
  targetClass: TargetClass | null;
  box: [number, number, number, number];
  confidence: number | null;
  areaPx: number;
  polygons: Array<Array<[number, number]>>;
  worldX: number;
  worldY: number;
  matchedObjectId: string | null;
  iou: number | null;
}

export interface Segmentation {
  id: string;
  captureId: string;
  provider: "SAM_3_1" | "OFFLINE_FIXTURE";
  prompt: string;
  status: "OK" | "EMPTY" | "FAILED" | "SKIPPED_BUDGET" | "REUSED";
  latencyMs: number | null;
  error: string | null;
  instances: SegInstance[];
}

export interface Observation {
  id: string;
  missionId: string;
  captureId: string | null;
  assetId: string;
  source: "SAM_3_1" | "SIM_DETECTOR" | "OPERATOR";
  label: string;
  confidence: number | null;
  confidenceSource: "SAM_3_1" | "SIM_DETECTOR" | null;
  x: number;
  y: number;
  status: "OBSERVED" | "UNVERIFIED_ANOMALY_CANDIDATE" | "LOW_CONFIDENCE";
  createdAt: number;
}

export interface FrameReasoning {
  provider: "MUSE_SPARK" | "UNAVAILABLE";
  sceneSummary: string;
  phrases: Array<{ phrase: string; target_class: string | null; rationale: string }>;
  latencyMs: number | null;
  error: string | null;
}

export interface CaptureResult {
  captureId: string;
  missionId: string;
  seq: number;
  quality: ImageQuality | null;
  reasoning: FrameReasoning | null;
  segmentations: Segmentation[];
  observations: Observation[];
  duplicateOf: string | null;
  notes: string[];
}

export interface TranscriptResult {
  transcript: string;
  provider: "MUSE_VOICE_TRANSCRIBE";
  model: string;
  sessionId: string;
  audioDurationMs: number;
  latencyMs: number;
}

export interface ReportAsset {
  assetId: string;
  label: string;
  x: number;
  y: number;
  observations: number;
  sources: string[];
  bestConfidence: number | null;
  confidenceSource: string | null;
  status: "UNVERIFIED_ANOMALY_CANDIDATE" | "OBSERVED";
  seenInMissions: string[];
  captureIds: string[];
}

export interface ReportPathPoint {
  captureId: string;
  seq: number;
  reason: string;
  x: number;
  y: number;
  t: number;
  perceptionState: string;
  cameraOnline: boolean;
  simulated: { turbidity: number | null; lighting: number | null; visibility: number; source: "SIMULATED" } | null;
  imageVisibility: number | null;
  imageBand: string | null;
  duplicateOf: string | null;
}

export interface InspectionReport {
  reportVersion: number;
  generatedAt: number;
  mission: { id: string; instruction: string; provider: Provider; createdAt: number; spec: MissionSpec; planSummary: MissionRecord["planSummary"]; executor: string | null };
  outcome: { status: MissionRecord["status"]; twinResult: Record<string, number | string | boolean> | null; waypointsPlanned: number; waypointsVisited: number | null };
  path: ReportPathPoint[];
  assets: ReportAsset[];
  anomalyCandidates: ReportAsset[];
  uninspectedAreas: Array<{ xMin: number; xMax: number; yMin: number; yMax: number }>;
  coverageEstimate: number;
  segmentation: { provider: string; requests: Record<string, number>; meanLatencyMs: number | null; meanIouVsTwinTruth: number | null; iouSamples: number };
  baselineVsSegmentation: Array<{ seq: number; simDetections: number; segmentedInstances: number }>;
  summary: { provider: string; model?: string; summary: string; keyFindings: string[]; limitations: string[]; recommendedFollowups: string[]; error?: string };
  disclaimers: string[];
}

export interface HistoryItem {
  id: string;
  createdAt: number;
  status: MissionRecord["status"];
  provider: Provider;
  instruction: string;
  captures: number;
  observations: number;
  assets: number;
  result: Record<string, number | string | boolean> | null;
}

export interface EventEnvelope<T = unknown> {
  v: 1;
  seq: number;
  type: string;
  ts: number;
  data: T;
}
