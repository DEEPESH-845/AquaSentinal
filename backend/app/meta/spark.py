"""Muse Spark 1.3 integration: mission planning with tool calling, frame reasoning and report summaries.

Request shapes follow https://dev.meta.ai/docs/tool-calling (Chat Completions, nested `function` tools),
https://dev.meta.ai/docs/structured-output (`response_format` json_schema) and
https://dev.meta.ai/docs/image-understanding (image_url content parts in user messages).
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass, field
from typing import Any

from ..mission.tools import ToolRegistry
from ..schemas import Language, ToolCallRecord
from .client import MetaAPIError, MetaClient

PLANNER_SYSTEM = """You are the mission planner of AquaSentinal, an underwater inspection system: a camera on an XY gantry above a test tank.
Gantry coordinates are centimetres from the home corner: x 0 to 100 along the tank, y 0 to 40 across it. A 5 cm pipeline runs along y = 20 from x = 6 to x = 94.
Your job: turn the operator's instruction into exactly one call to create_inspection_mission.
You may first call get_telemetry, get_environment_conditions or get_camera_status if the instruction depends on the current state.
Only use the target classes the tool schema allows. Keep the visibility policy on unless the operator explicitly asks otherwise.
You cannot move the gantry; the operator reviews and approves the plan the backend compiles from your mission.
In `explanation`, say in one or two plain sentences how the instruction maps to the mission. Do not claim to have seen anything.
The operator's instruction may be in English, Hindi (Devanagari) or Hinglish (Hindi written in Latin letters, often mixed with English). Understand it in any of these.
Whatever the language of the instruction, every tool argument other than `explanation` stays in English: use only the allowed enum values and numbers from the tool schema."""

# Appended to a system prompt when the operator works in Hindi. English adds nothing, so English requests are unchanged.
HINDI_INSTRUCTION = (
    "Write every sentence you produce for the operator in Hindi, in Devanagari script and plain operator language. "
    "Keep enum values, JSON keys, ids, coordinates, numbers with units and model names exactly as given, in English."
)


def with_language(system: str, language: Language) -> str:
    """The one place a system prompt learns the operator's language. Summaries now; Ask answers and work orders reuse it."""
    return f"{system}\n{HINDI_INSTRUCTION}" if language == "hi" else system


FRAME_SYSTEM = """You look at one downward camera frame from an underwater inspection tank and name the objects worth segmenting.
Return short concrete noun phrases (one or two words, e.g. "cable", "wrench", "plastic crate", "pipe flange") that a segmentation model can match.
Map each phrase to one of the allowed target classes. Only list things you can actually see. Never assess damage or condition beyond what is visible."""

SUMMARY_SYSTEM = """You write the summary of an underwater inspection from structured records only.
Use only facts present in the records. Segmentation and detection are visual observations, not engineering diagnoses: never call anything a confirmed defect.
Say which findings are unverified, which areas were not inspected, and where visibility limited the evidence."""

FRAME_SCHEMA = {
    "type": "object",
    "properties": {
        "scene_summary": {"type": "string"},
        "phrases": {
            "type": "array",
            "maxItems": 4,
            "items": {
                "type": "object",
                "properties": {
                    "phrase": {"type": "string"},
                    "target_class": {
                        "type": "string",
                        "enum": ["pipe_segment", "pipe_joint", "valve", "loose_cable", "foreign_object", "inspection_panel", "debris"],
                    },
                    "rationale": {"type": "string"},
                },
                "required": ["phrase", "target_class", "rationale"],
            },
        },
    },
    "required": ["scene_summary", "phrases"],
}

SUMMARY_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "key_findings": {"type": "array", "items": {"type": "string"}},
        "limitations": {"type": "array", "items": {"type": "string"}},
        "recommended_followups": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["summary", "key_findings", "limitations", "recommended_followups"],
}


@dataclass
class PlanningOutcome:
    created: dict[str, Any] | None  # the successful create_inspection_mission result
    explanation: str
    timeline: list[ToolCallRecord] = field(default_factory=list)
    turns: int = 0


class PlanningFailed(Exception):
    def __init__(self, message: str, timeline: list[ToolCallRecord]):
        super().__init__(message)
        self.timeline = timeline


class Spark:
    def __init__(self, client: MetaClient, model: str):
        self.client = client
        self.model = model

    async def plan(self, instruction: str, registry: ToolRegistry, max_turns: int = 6, ref: str = "", language: Language = "en") -> PlanningOutcome:
        """Agent loop: the model may read state, then must call create_inspection_mission. Invalid calls go back to it as errors."""
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": with_language(PLANNER_SYSTEM, language)},
            {"role": "user", "content": instruction},
        ]
        tools = registry.schemas("PLANNING")
        timeline: list[ToolCallRecord] = []
        for turn in range(1, max_turns + 1):
            body, _ = await self.client.chat(
                {"model": self.model, "messages": messages, "tools": tools, "tool_choice": "auto"}, op="mission_planning", input_ref=f"{ref} turn={turn}".strip()
            )
            choice = (body.get("choices") or [{}])[0]
            msg = choice.get("message") or {}
            calls = msg.get("tool_calls") or []
            if not calls:
                raise PlanningFailed(
                    "Muse Spark answered without creating a mission: " + (msg.get("content") or "(empty reply)")[:300], timeline
                )
            messages.append({"role": "assistant", "content": msg.get("content") or "", "tool_calls": calls})
            created = None
            for call in calls:
                fn = call.get("function") or {}
                record = await registry.dispatch(fn.get("name", ""), fn.get("arguments") or "{}", "PLANNING", "MUSE_SPARK")
                timeline.append(record)
                payload = record.result if record.ok else {"error": record.error}
                messages.append({"role": "tool", "tool_call_id": call.get("id", ""), "content": json.dumps(payload, default=str)})
                if record.ok and record.name == "create_inspection_mission":
                    created = record.result
            if created is not None:
                explanation = str(json.loads(calls[-1]["function"].get("arguments") or "{}").get("explanation", "")) if calls else ""
                return PlanningOutcome(created=created, explanation=explanation or (msg.get("content") or ""), timeline=timeline, turns=turn)
        raise PlanningFailed(f"no valid mission after {max_turns} model turns", timeline)

    async def analyze_frame(self, jpeg: bytes, targets: list[str], ref: str = "") -> tuple[dict[str, Any], float | None]:
        url = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()
        body, latency = await self.client.chat(
            {
                "model": self.model,
                "messages": [
                    {"role": "system", "content": FRAME_SYSTEM},
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "Mission targets: " + ", ".join(targets) + ". Which of them, or other relevant objects, are visible?"},
                            {"type": "image_url", "image_url": {"url": url}},
                        ],
                    },
                ],
                "response_format": {"type": "json_schema", "json_schema": {"name": "FrameObservations", "schema": FRAME_SCHEMA}},
            },
            op="frame_reasoning",
            input_ref=ref,
        )
        return _json_content(body), latency

    async def summarize(self, records: dict[str, Any], ref: str = "", language: Language = "en") -> tuple[dict[str, Any], float | None]:
        body, latency = await self.client.chat(
            {
                "model": self.model,
                "messages": [
                    {"role": "system", "content": with_language(SUMMARY_SYSTEM, language)},
                    {"role": "user", "content": json.dumps(records, default=str)[:60000]},
                ],
                "response_format": {"type": "json_schema", "json_schema": {"name": "InspectionSummary", "schema": SUMMARY_SCHEMA}},
            },
            op="report_summary",
            input_ref=ref,
        )
        return _json_content(body), latency


def _json_content(body: dict[str, Any]) -> dict[str, Any]:
    content = ((body.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    try:
        data = json.loads(content)
    except json.JSONDecodeError as e:
        raise MetaAPIError(502, f"structured output was not valid JSON: {e}") from e
    if not isinstance(data, dict):
        raise MetaAPIError(502, "structured output was not a JSON object")
    return data
