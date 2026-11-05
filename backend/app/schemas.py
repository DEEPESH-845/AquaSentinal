"""Typed API contracts. lib/api/types.ts mirrors these field for field (camelCase on the wire).

Every value that can reach the motion controller is bounded here, before any planning or execution code sees it.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel

from .geometry import perception_defaults, travel

TRAVEL_X, TRAVEL_Y = travel()
_P = perception_defaults()


class Wire(BaseModel):
    """camelCase on the wire, snake_case in Python, unknown fields rejected."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


TargetClass = Literal["pipe_segment", "pipe_joint", "valve", "loose_cable", "foreign_object", "inspection_panel", "debris"]
Objective = Literal["pipeline_inspection", "area_survey", "target_search"]
ScanPattern = Literal["left_to_right", "right_to_left", "serpentine"]
Priority = Literal["low", "normal", "high"]
Provider = Literal["MUSE_SPARK", "OFFLINE_RULE_PARSER", "OPERATOR"]
# The operator's language for Meta-written text and for Voice Transcribe's language bias. Offline templates stay English.
Language = Literal["en", "hi"]
MissionStatus = Literal["DRAFT", "PLANNED", "APPROVED", "RUNNING", "PAUSED", "COMPLETED", "ABORTED", "FAILED"]
PerceptionState = Literal[
    "NORMAL_VISIBILITY", "REDUCED_VISIBILITY", "LOW_CONFIDENCE", "REOBSERVATION_REQUIRED", "INSPECTION_PAUSED", "OPERATOR_INTERVENTION_REQUIRED"
]
DetectionSource = Literal["SAM_3_1", "SIM_DETECTOR"]
ObservationStatus = Literal["OBSERVED", "UNVERIFIED_ANOMALY_CANDIDATE", "LOW_CONFIDENCE"]

TARGET_TO_TYPE: dict[str, str] = {t: t.upper() for t in TargetClass.__args__}  # type: ignore[attr-defined]
TYPE_TO_TARGET: dict[str, str] = {v: k for k, v in TARGET_TO_TYPE.items()}
# A segmentation of these classes is a visual observation that may matter; it is never a confirmed defect.
ANOMALY_CANDIDATE_CLASSES = {"loose_cable", "foreign_object"}

# ---------------------------------------------------------------- mission spec (what the operator or model asks for)


class Region(Wire):
    x_min: float = Field(10, ge=0, le=TRAVEL_X)
    x_max: float = Field(90, ge=0, le=TRAVEL_X)
    y_min: float = Field(8, ge=0, le=TRAVEL_Y)
    y_max: float = Field(32, ge=0, le=TRAVEL_Y)

    @model_validator(mode="after")
    def _ordered(self) -> Region:
        if self.x_min >= self.x_max:
            raise ValueError("region x_min must be below x_max")
        if self.y_min > self.y_max:
            raise ValueError("region y_min must not exceed y_max")
        return self


class VisibilityPolicySpec(Wire):
    reduce_speed_on_degradation: bool = True
    stop_on_unsafe_visibility: bool = True
    degraded_visibility: float = Field(_P["degradedVisibility"], ge=0.3, le=0.95)
    unsafe_visibility: float = Field(_P["unsafeVisibility"], ge=0.1, le=0.9)
    reduced_speed_fraction: float = Field(_P["reducedSpeedFraction"], ge=0.2, le=0.6)

    @model_validator(mode="after")
    def _thresholds(self) -> VisibilityPolicySpec:
        if self.unsafe_visibility >= self.degraded_visibility:
            raise ValueError("unsafe_visibility must be below degraded_visibility")
        return self


class MissionSpec(Wire):
    """A structured inspection request. Produced by Muse Spark (create_inspection_mission), the offline parser or an operator."""

    mission_id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{2,47}$")
    objective: Objective = "pipeline_inspection"
    targets: list[TargetClass] = Field(min_length=1, max_length=7)
    scan_pattern: ScanPattern = "left_to_right"
    region: Region = Field(default_factory=Region)
    lane_spacing_cm: float = Field(24, ge=8, le=40)
    capture_spacing_cm: float = Field(16, ge=8, le=40)
    speed_fraction: float = Field(0.65, ge=0.2, le=1.0)
    priority: Priority = "normal"
    record_evidence: bool = True
    visibility_policy: VisibilityPolicySpec = Field(default_factory=VisibilityPolicySpec)
    notes: str = Field("", max_length=500)

    @field_validator("targets")
    @classmethod
    def _unique(cls, v: list[str]) -> list[str]:
        return list(dict.fromkeys(v))


# ---------------------------------------------------------------- compiled plan (what the twin or the executor runs)


class PlanWaypoint(Wire):
    x: float = Field(ge=0, le=TRAVEL_X)
    y: float = Field(ge=0, le=TRAVEL_Y)
    capture: bool


class PlanPolicy(Wire):
    reduce_speed_on_degradation: bool
    stop_on_unsafe_visibility: bool
    degraded_visibility: float
    unsafe_visibility: float
    reduced_speed_fraction: float


class PlanRegion(Wire):
    x_min: float
    x_max: float
    y_min: float
    y_max: float


class MissionPlan(Wire):
    """Mirrors lib/sim/types.ts MissionPlan exactly; the twin executes this object."""

    mission_id: str
    waypoints: list[PlanWaypoint] = Field(min_length=1, max_length=80)
    speed_fraction: float = Field(ge=0.2, le=1.0)
    targets: list[str]
    policy: PlanPolicy
    region: PlanRegion


class PlanSummary(Wire):
    waypoint_count: int
    capture_count: int
    path_length_cm: float
    estimated_duration_s: float
    lanes: int


# ---------------------------------------------------------------- tool timeline


class ToolCallRecord(Wire):
    name: str
    arguments: dict[str, Any]
    ok: bool
    result: Any = None
    error: str | None = None
    phase: Literal["PLANNING", "EXECUTION", "REPORTING", "ASK"]
    by: Literal["MUSE_SPARK", "OFFLINE_RULE_PARSER", "OFFLINE_RECORDS_QUERY", "OPERATOR", "SYSTEM"]
    at: float


class MissionRecord(Wire):
    id: str
    created_at: float
    instruction: str
    provider: Provider
    status: MissionStatus
    spec: MissionSpec
    plan: MissionPlan
    plan_summary: PlanSummary
    explanation: str = ""
    warnings: list[str] = Field(default_factory=list)
    timeline: list[ToolCallRecord] = Field(default_factory=list)
    result: dict[str, Any] | None = None
    executor: Literal["TWIN", "BACKEND"] | None = None
    # the operator's language when the mission was planned; a later summary is written in it
    language: Language = "en"


# ---------------------------------------------------------------- requests


class TwinContext(Wire):
    """Telemetry the browser twin attaches so read-only tools can answer. Always SIMULATED."""

    gantry_x: float = Field(ge=0, le=TRAVEL_X)
    gantry_y: float = Field(ge=0, le=TRAVEL_Y)
    moving: bool = False
    turbidity: float = Field(ge=0, le=1)
    lighting: float = Field(ge=0, le=1)
    visibility: float = Field(ge=0, le=1)
    camera_online: bool = True
    estop: bool = False


class InterpretRequest(Wire):
    instruction: str = Field(min_length=3, max_length=2000)
    context: TwinContext | None = None
    language: Language = "en"


class SummaryRequest(Wire):
    """Regenerating a summary. No language means the mission's own."""

    language: Language | None = None


class AskRequest(Wire):
    """A question about one mission's stored records. The answer is written in `language` when Muse Spark answers it."""

    question: str = Field(min_length=3, max_length=500)
    language: Language = "en"

    @field_validator("question", mode="before")
    @classmethod
    def _strip(cls, v: Any) -> Any:
        return v.strip() if isinstance(v, str) else v


class InterpretResponse(Wire):
    mission: MissionRecord
    provider: Provider
    model: str | None


class StartRequest(Wire):
    executor: Literal["TWIN", "BACKEND"] = "TWIN"


class TwinMissionResult(Wire):
    """The twin's MissionResult (lib/sim/types.ts), posted when a mission ends."""

    mission_id: str
    adaptive: bool
    outcome: Literal["COMPLETED", "ABORTED_BY_OPERATOR", "EMERGENCY_STOP", "STOPPED_UNSAFE_VISIBILITY"]
    waypoints_visited: int = Field(ge=0)
    waypoints_planned: int = Field(ge=0)
    captures: int = Field(ge=0)
    unreliable_captures: int = Field(ge=0)
    reobservations: int = Field(ge=0)
    pauses: int = Field(ge=0)
    confirmed_targets: int = Field(ge=0)
    false_positives: int = Field(ge=0)
    avg_confidence: float = Field(ge=0, le=1)
    coverage: float = Field(ge=0, le=1)
    min_visibility: float = Field(ge=0, le=1)
    duration_s: float = Field(ge=0)


class SimDetection(Wire):
    """One detection from the twin's geometric detector. Its confidence is the simulator's, not a model's."""

    object_id: str
    true_type: str
    cls: str = Field(alias="class")
    confidence: float = Field(ge=0, le=1)
    bbox: tuple[float, float, float, float]
    est_x: float
    est_y: float

    model_config = ConfigDict(populate_by_name=True, extra="ignore")


class IdMapEntry(Wire):
    index: int = Field(ge=1, le=250)
    object_id: str
    type: str


class CaptureMeta(Wire):
    mission_id: str = Field(max_length=64)
    seq: int = Field(ge=0)
    reason: Literal["SCAN", "REOBSERVE", "MANUAL"]
    waypoint_index: int
    time: float
    gantry_x: float = Field(ge=0, le=TRAVEL_X)
    gantry_y: float = Field(ge=0, le=TRAVEL_Y)
    visibility: float = Field(ge=0, le=1)
    # The twin's synthetic water state. None for real camera frames: there is no sensor for it.
    turbidity: float | None = Field(None, ge=0, le=1)
    lighting: float | None = Field(None, ge=0, le=1)
    perception: PerceptionState
    camera_online: bool
    source: Literal["DIGITAL_TWIN", "CAMERA"] = "DIGITAL_TWIN"
    detections: list[SimDetection] = Field(default_factory=list, max_length=64)
    id_map: list[IdMapEntry] = Field(default_factory=list, max_length=250)
    targets: list[TargetClass] = Field(default_factory=list)
    perception_fault: Literal["NONE", "SEGMENTATION_FAILURE"] = "NONE"
    prompts: list[str] = Field(default_factory=list, max_length=5)


class SegmentRequest(Wire):
    capture_id: str
    prompt: str = Field(min_length=1, max_length=60)


class ObservationCreate(Wire):
    mission_id: str
    label: TargetClass
    x: float = Field(ge=0, le=TRAVEL_X)
    y: float = Field(ge=0, le=TRAVEL_Y)
    note: str = Field("", max_length=500)


# ---------------------------------------------------------------- perception results


class ImageQuality(Wire):
    brightness: float
    contrast: float
    sharpness: float
    red_blue_ratio: float
    visibility_estimate: float
    band: Literal["GOOD", "DEGRADED", "UNRELIABLE"]
    source: Literal["IMAGE_DERIVED_ESTIMATE"] = "IMAGE_DERIVED_ESTIMATE"


class SegInstance(Wire):
    instance_id: str
    prompt: str
    target_class: TargetClass | None
    box: tuple[int, int, int, int]
    confidence: float | None
    area_px: int
    polygons: list[list[tuple[int, int]]]
    world_x: float
    world_y: float
    matched_object_id: str | None = None
    iou: float | None = None


class Segmentation(Wire):
    id: str
    capture_id: str
    provider: Literal["SAM_3_1", "OFFLINE_FIXTURE"]
    prompt: str
    status: Literal["OK", "EMPTY", "FAILED", "SKIPPED_BUDGET", "REUSED"]
    latency_ms: float | None
    error: str | None
    instances: list[SegInstance]


class Observation(Wire):
    id: str
    mission_id: str
    capture_id: str | None
    asset_id: str
    source: DetectionSource | Literal["OPERATOR"]
    label: str
    confidence: float | None
    confidence_source: DetectionSource | None
    x: float
    y: float
    status: ObservationStatus
    created_at: float


class Asset(Wire):
    id: str
    label: str
    x: float
    y: float
    observations: int
    first_seen: float
    last_seen: float
    missions: list[str]


class FrameReasoning(Wire):
    provider: Literal["MUSE_SPARK", "UNAVAILABLE"]
    scene_summary: str
    phrases: list[dict[str, Any]]
    latency_ms: float | None = None
    error: str | None = None


class CaptureResult(Wire):
    capture_id: str
    mission_id: str
    seq: int
    quality: ImageQuality | None
    reasoning: FrameReasoning | None
    segmentations: list[Segmentation]
    observations: list[Observation]
    duplicate_of: str | None = None
    notes: list[str] = Field(default_factory=list)


class TranscriptResult(Wire):
    transcript: str
    provider: Literal["MUSE_VOICE_TRANSCRIBE"]
    model: str
    session_id: str
    audio_duration_ms: int
    latency_ms: float | None  # None when the transcript came from the response cache


# ---------------------------------------------------------------- ask the inspector

AskProvider = Literal["MUSE_SPARK", "OFFLINE_RECORDS_QUERY"]
# Why an offline records query answered instead of Muse Spark. None when Muse Spark answered.
AskFallback = Literal["LIVE_LOCKED", "NO_KEY", "BUDGET_EXCEEDED", "LIVE_META_FAILED", "NO_ANSWER"]


class AskCitation(Wire):
    """A capture a tool returned and the answer rests on. x, y: gantry cm of the object observed in it (the capture position if nothing was)."""

    capture_id: str
    x: float
    y: float
    label: str


class AskResponse(Wire):
    answer: str
    citations: list[AskCitation]
    tool_calls: list[ToolCallRecord]
    provider: AskProvider
    model: str | None
    # every Meta execution this answer cost or replayed, so the log can be checked against it (also when a fallback answered)
    execution_ids: list[str]
    # how many of those were requests that actually went to Meta (LIVE_META or LIVE_META_FAILED); the rest were replayed from the cache
    requests_sent: int
    # how the Meta calls behind a MUSE_SPARK answer were made: LIVE_META, CACHED_LIVE, MOCKED ... None for an offline answer
    classification: str | None
    fallback: AskFallback | None
    note: str
    # capture ids the model cited that no tool returned; they are removed from the answer
    dropped_citations: list[str]
    # the language the answer is actually written in: offline answers are always English
    language: Language


# ---------------------------------------------------------------- work orders

WorkOrderPriority = Literal["P1", "P2", "P3"]
WorkOrderEffort = Literal["S", "M", "L"]
WorkOrderProvider = Literal["MUSE_SPARK", "OFFLINE_RULES"]


class WorkOrderLocation(Wire):
    """Gantry centimetres from the home corner, inside the travel (shared/geometry.json)."""

    x: float = Field(ge=0, le=TRAVEL_X)
    y: float = Field(ge=0, le=TRAVEL_Y)


class WorkOrder(Wire):
    """One job for a crew, resting on stored captures. Extra keys in a model's output are ignored, not trusted."""

    model_config = ConfigDict(extra="ignore")

    id: str
    priority: WorkOrderPriority
    title: str = Field(min_length=1, max_length=120)
    location: WorkOrderLocation
    evidence: list[str] = Field(max_length=6)  # capture ids
    action: str = Field(min_length=1, max_length=300)
    effort: WorkOrderEffort
    rationale: str = Field(min_length=1, max_length=400)


class WorkOrdersRequest(Wire):
    """Work orders for one mission, written in `language` when Muse Spark writes them."""

    language: Language = "en"


class WorkOrdersResponse(Wire):
    orders: list[WorkOrder]
    provider: WorkOrderProvider
    model: str | None
    # every Meta execution this list cost or replayed, also when a fallback produced it
    execution_ids: list[str]
    # how many of those were requests that actually went to Meta (LIVE_META or LIVE_META_FAILED); the rest were replayed from the cache
    requests_sent: int
    # how the Meta call behind a MUSE_SPARK list was made: LIVE_META, CACHED_LIVE, MOCKED ... None for an offline list
    classification: str | None
    # why the offline rules wrote the list instead of Muse Spark. None when Muse Spark wrote it (or there was nothing to order)
    fallback: AskFallback | None
    note: str
    # capture ids the model cited that no record holds, and how many orders were dropped (unknown evidence, no evidence, invalid fields)
    dropped_evidence: list[str]
    dropped_orders: int
    # the language the orders are written in: offline rules are always English
    language: Language


# ---------------------------------------------------------------- real water camera

MAX_REAL_PROMPTS = 2  # SAM 3.1 requests (one per prompt) a single shutter may cost
RealSegmentStatus = Literal["OK", "EMPTY", "FAILED", "SKIPPED_BUDGET"]


class RealInstance(Wire):
    """One mask SAM 3.1 returned for a phrase, in the pixels of the frame that was sent."""

    box: tuple[int, int, int, int]
    confidence: float | None  # the model's own score; None when it gave none (None is not zero)
    area_px: int
    polygons: list[list[tuple[int, int]]]


class RealSegment(Wire):
    """The answer to one phrase: one SAM 3.1 request, or the reason there was none."""

    prompt: str
    status: RealSegmentStatus
    latency_ms: float | None  # None for a replayed (cached) answer: nothing was measured
    error: str | None
    instances: list[RealInstance]


class RealSegmentResponse(Wire):
    width: int
    height: int
    segments: list[RealSegment]
    # SAM_3_1 when the model answered at least one phrase; UNAVAILABLE when no key, no passcode, or every request failed
    provider: Literal["SAM_3_1", "UNAVAILABLE"]
    model: str | None
    # every Meta execution this shutter cost or replayed
    execution_ids: list[str]
    # how many of those were requests that actually went to Meta (LIVE_META or LIVE_META_FAILED); the rest were replayed from the cache
    requests_sent: int
    # how the Meta calls behind the masks were made: LIVE_META, CACHED_LIVE, MOCKED ... None when none succeeded
    classification: str | None
    latency_ms: float | None  # the slowest phrase (they run side by side); None when every answer was replayed or none was asked
    cost_usd: float  # estimate from Meta list prices, summed over this shutter's LIVE_META executions (what the budget counts); a replay costs 0
    fallback: Literal["NO_KEY", "LIVE_LOCKED"] | None
    note: str


# ---------------------------------------------------------------- commands over /ws/commands and /api/gantry


class CmdMoveTo(Wire):
    type: Literal["MOVE_TO"]
    x: float
    y: float
    speed_fraction: float = 0.5


class CmdSimple(Wire):
    type: Literal["HOME", "STOP", "ESTOP", "CLEAR_ESTOP", "CONNECT", "DISCONNECT"]


Command = Annotated[CmdMoveTo | CmdSimple, Field(discriminator="type")]


class CommandEnvelope(Wire):
    v: Literal[1] = 1
    id: str = Field(min_length=1, max_length=64)
    command: Command
