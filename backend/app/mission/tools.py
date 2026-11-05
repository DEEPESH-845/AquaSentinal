"""The allowlisted tools Muse Spark and the executor may call.

Every tool has a Pydantic argument model, a phase allowlist and a handler. The model is only ever offered the
PLANNING tools (read-only state plus create_inspection_mission) or, when it answers a question about a mission, the ASK
tools (read-only views of the stored records and nothing else); motion and execution tools exist for the operator-
approved executor and are refused if anything asks for them in the wrong phase. Nothing a model writes reaches the
motion controller without passing through these models and then the motion controller's own interlocks.
"""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ..schemas import TRAVEL_X, TRAVEL_Y, MissionSpec, Objective, Priority, Region, ScanPattern, TargetClass, ToolCallRecord, VisibilityPolicySpec

Phase = Literal["PLANNING", "EXECUTION", "REPORTING", "ASK"]
Caller = Literal["MUSE_SPARK", "OFFLINE_RULE_PARSER", "OFFLINE_RECORDS_QUERY", "OPERATOR", "SYSTEM"]


class Args(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NoArgs(Args):
    pass


class CreateMissionArgs(Args):
    """MissionSpec minus the id, which the backend assigns."""

    objective: Objective
    targets: list[TargetClass] = Field(min_length=1, max_length=7)
    scan_pattern: ScanPattern
    region: Region | None = None
    lane_spacing_cm: float | None = Field(None, ge=8, le=40)
    capture_spacing_cm: float | None = Field(None, ge=8, le=40)
    speed_fraction: float = Field(0.65, ge=0.2, le=1.0)
    priority: Priority = "normal"
    record_evidence: bool = True
    visibility_policy: VisibilityPolicySpec | None = None
    explanation: str = Field("", max_length=600, description="One or two sentences on how the instruction maps to this mission.")

    def to_spec(self, mission_id: str) -> MissionSpec:
        data: dict[str, Any] = self.model_dump(exclude_none=True, exclude={"explanation"})
        return MissionSpec(mission_id=mission_id, notes=self.explanation, **data)


class MoveArgs(Args):
    x: float = Field(ge=0, le=TRAVEL_X)
    y: float = Field(ge=0, le=TRAVEL_Y)
    speed_fraction: float = Field(0.5, ge=0.2, le=1.0)


class MissionRef(Args):
    mission_id: str = Field(max_length=64)


class CaptureArgs(Args):
    mission_id: str = Field(max_length=64)
    reason: Literal["SCAN", "REOBSERVE", "MANUAL"] = "MANUAL"


class SegmentArgs(Args):
    capture_id: str = Field(max_length=64)
    prompt: str = Field(min_length=1, max_length=60, description="A short concrete noun phrase, e.g. 'cable'.")


class ObservationArgs(Args):
    mission_id: str = Field(max_length=64)
    label: TargetClass
    x: float = Field(ge=0, le=TRAVEL_X)
    y: float = Field(ge=0, le=TRAVEL_Y)
    note: str = Field("", max_length=500)


class ListObservationsArgs(Args):
    label: TargetClass | None = Field(None, description="Only observations of this class. Omit for all of them.")


class CaptureRef(Args):
    capture_id: str = Field(max_length=64, description="A captureId returned by list_observations or get_mission_summary.")


class TrackRef(Args):
    track_id: str = Field(max_length=64, description="A trackId (asset id) returned by list_observations or get_mission_summary.")


Handler = Callable[[BaseModel], Awaitable[Any]]


@dataclass(frozen=True)
class ToolDef:
    name: str
    description: str
    args: type[BaseModel]
    phases: frozenset[Phase]


TOOLS: dict[str, ToolDef] = {
    t.name: t
    for t in [
        ToolDef("get_telemetry", "Current gantry position, motion state and emergency-stop state. Simulated values are labelled SIMULATED.", NoArgs, frozenset({"PLANNING", "EXECUTION"})),
        ToolDef("get_environment_conditions", "Turbidity, lighting and the 0..1 visibility estimate, with the source of each value.", NoArgs, frozenset({"PLANNING", "EXECUTION"})),
        ToolDef("get_camera_status", "Whether the inspection camera is online, its source and resolution.", NoArgs, frozenset({"PLANNING", "EXECUTION"})),
        ToolDef(
            "create_inspection_mission",
            "Create the structured inspection mission for the operator's instruction. The backend validates it, assigns an id and compiles bounded waypoints. Call exactly once.",
            CreateMissionArgs,
            frozenset({"PLANNING"}),
        ),
        ToolDef("capture_inspection_frame", "Capture one camera frame at the current position.", CaptureArgs, frozenset({"EXECUTION"})),
        ToolDef("segment_target", "Segment a named object in a captured frame with SAM 3.1.", SegmentArgs, frozenset({"EXECUTION"})),
        ToolDef("move_to_waypoint", "Move the gantry to a position inside the soft travel limits.", MoveArgs, frozenset({"EXECUTION"})),
        ToolDef("start_inspection", "Start an approved mission.", MissionRef, frozenset({"EXECUTION"})),
        ToolDef("pause_inspection", "Pause a running mission.", MissionRef, frozenset({"EXECUTION"})),
        ToolDef("stop_inspection", "Stop a running mission.", MissionRef, frozenset({"EXECUTION"})),
        ToolDef("record_observation", "Record an operator or system observation at gantry coordinates.", ObservationArgs, frozenset({"EXECUTION"})),
        ToolDef("generate_inspection_summary", "Generate the evidence-backed summary for a finished mission.", MissionRef, frozenset({"REPORTING"})),
        # ASK: read-only views of one mission's stored records. Nothing here writes, moves or calls a model.
        ToolDef("list_observations", "List the objects the camera observed in this mission (capture, track, class, position, confidence), optionally for one class.", ListObservationsArgs, frozenset({"ASK"})),
        ToolDef("get_capture", "One capture of this mission: where it was taken, the water and image quality, and what was observed and segmented in it.", CaptureRef, frozenset({"ASK"})),
        ToolDef("get_track", "One tracked object seen in this mission: class, position, every capture it appears in, best confidence and where it came from.", TrackRef, frozenset({"ASK"})),
        ToolDef("get_mission_summary", "Outcome, counts, coverage, uninspected strips and unverified anomaly candidates of this mission.", NoArgs, frozenset({"ASK"})),
        ToolDef("compare_with_previous_mission", "Compare this mission with the most recent earlier completed mission. Says so explicitly when there is none.", NoArgs, frozenset({"ASK"})),
    ]
}


class ToolNotPermitted(Exception):
    pass


class ToolRegistry:
    """Binds handlers to the fixed tool table. The table, not the registry, decides what exists and when."""

    def __init__(self) -> None:
        self._handlers: dict[str, Handler] = {}

    def bind(self, name: str, handler: Handler) -> None:
        if name not in TOOLS:
            raise KeyError(f"unknown tool {name}")
        self._handlers[name] = handler

    @staticmethod
    def schemas(phase: Phase) -> list[dict[str, Any]]:
        """Chat Completions tool definitions (nested `function` form) for one phase."""
        out = []
        for t in TOOLS.values():
            if phase not in t.phases:
                continue
            params = t.args.model_json_schema()
            params.setdefault("type", "object")
            out.append({"type": "function", "function": {"name": t.name, "description": t.description, "parameters": params}})
        return out

    async def dispatch(self, name: str, raw_args: dict[str, Any] | str | None, phase: Phase, by: Caller) -> ToolCallRecord:
        """Validates and runs one call. Never raises for model mistakes: they come back as a failed record the model can read."""
        args_dict: dict[str, Any] = {}
        try:
            if name not in TOOLS:
                raise ToolNotPermitted(f"tool '{name}' does not exist")
            tool = TOOLS[name]
            if phase not in tool.phases:
                raise ToolNotPermitted(f"tool '{name}' is not permitted during {phase}")
            if isinstance(raw_args, str):
                import json

                raw_args = json.loads(raw_args or "{}")
            args_dict = dict(raw_args or {})
            parsed = tool.args.model_validate(args_dict)
            handler = self._handlers.get(name)
            if handler is None:
                raise ToolNotPermitted(f"tool '{name}' is not available in this configuration")
            result = await handler(parsed)
            return ToolCallRecord(name=name, arguments=args_dict, ok=True, result=result, phase=phase, by=by, at=time.time())
        except ValidationError as e:
            msg = "; ".join(f"{'.'.join(str(p) for p in err['loc'])}: {err['msg']}" for err in e.errors())
            return ToolCallRecord(name=name, arguments=args_dict, ok=False, error=f"invalid arguments: {msg}", phase=phase, by=by, at=time.time())
        except (ToolNotPermitted, ValueError) as e:
            return ToolCallRecord(name=name, arguments=args_dict, ok=False, error=str(e), phase=phase, by=by, at=time.time())
