"""Mission lifecycle: interpret -> plan -> approve -> run -> complete -> summarise.

Status transitions are enforced here; the HTTP layer only maps errors to status codes.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from typing import Any

from ..db import Repository
from ..events import EventBus
from ..meta.client import MetaAPIError
from ..meta.spark import PlanningFailed, Spark
from ..perception.pipeline import PerceptionPipeline
from ..reporting import build_report, template_summary
from ..schemas import InterpretRequest, MissionRecord, MissionSpec, Provider, ToolCallRecord, TwinContext, TwinMissionResult
from .compiler import PlanError, compile_plan
from .offline import parse_instruction
from .tools import CreateMissionArgs, NoArgs, ToolRegistry

log = logging.getLogger("aquasentinal.missions")


class MissionError(Exception):
    def __init__(self, status: int, message: str, detail: Any = None):
        super().__init__(message)
        self.status = status
        self.detail = detail


TRANSITIONS: dict[str, set[str]] = {
    "PLANNED": {"APPROVED", "RUNNING", "ABORTED"},
    "APPROVED": {"RUNNING", "ABORTED"},
    "RUNNING": {"PAUSED", "COMPLETED", "ABORTED", "FAILED"},
    "PAUSED": {"RUNNING", "COMPLETED", "ABORTED", "FAILED"},
}


class MissionService:
    def __init__(self, repo: Repository, events: EventBus, spark: Spark | None, pipeline: PerceptionPipeline, hardware_status):
        self.repo = repo
        self.events = events
        self.spark = spark
        self.pipeline = pipeline
        self.hardware_status = hardware_status  # async () -> dict, for get_telemetry when no twin context is given
        self._summaries: set[asyncio.Task] = set()

    def _transition(self, m: MissionRecord, to: str) -> None:
        if to not in TRANSITIONS.get(m.status, set()):
            raise MissionError(409, f"mission {m.id} is {m.status}; cannot move to {to}")
        m.status = to  # type: ignore[assignment]

    def get(self, mission_id: str) -> MissionRecord:
        m = self.repo.get_mission(mission_id)
        if m is None:
            raise MissionError(404, f"mission {mission_id} not found")
        return m

    def _unique_id(self, base: str) -> str:
        mid, n = base[:40], 2
        while self.repo.get_mission(mid):
            mid, n = f"{base[:40]}-{n}", n + 1
        return mid

    async def _store(self, instruction: str, provider: Provider, spec: MissionSpec, explanation: str, timeline: list[ToolCallRecord], warnings: list[str]) -> MissionRecord:
        try:
            plan, summary = compile_plan(spec)
        except PlanError as e:
            raise MissionError(422, str(e)) from e
        m = MissionRecord(
            id=spec.mission_id, created_at=time.time(), instruction=instruction, provider=provider, status="PLANNED",
            spec=spec, plan=plan, plan_summary=summary, explanation=explanation, warnings=warnings, timeline=timeline,
        )
        self.repo.save_mission(m)
        await self.events.publish("mission.planned", {"missionId": m.id, "provider": provider, "planSummary": summary.model_dump(by_alias=True)})
        return m

    async def interpret(self, req: InterpretRequest, force_offline: bool = False) -> tuple[MissionRecord, str | None]:
        ctx = req.context
        if self.spark is not None and not force_offline:
            return await self._interpret_spark(req.instruction, ctx), self.spark.model
        spec, notes = parse_instruction(req.instruction)
        spec = spec.model_copy(update={"mission_id": self._unique_id(spec.mission_id)})
        record = ToolCallRecord(
            name="create_inspection_mission", arguments=spec.model_dump(by_alias=True, exclude={"mission_id"}), ok=True,
            result={"missionId": spec.mission_id}, phase="PLANNING", by="OFFLINE_RULE_PARSER", at=time.time(),
        )
        warnings = ["Interpreted by the offline keyword parser, not by Muse Spark: set MODEL_API_KEY for language understanding.", *notes]
        explanation = "Keyword rules mapped the instruction to the fields below. Review them before approving."
        return await self._store(req.instruction, "OFFLINE_RULE_PARSER", spec, explanation, [record], warnings), None

    async def _interpret_spark(self, instruction: str, ctx: TwinContext | None) -> MissionRecord:
        assert self.spark is not None
        created: dict[str, MissionSpec] = {}
        registry = ToolRegistry()

        async def telemetry(_: NoArgs) -> dict:
            if ctx is None:
                return {"source": "BACKEND_DRIVER", **(await self.hardware_status())}
            return {"source": "SIMULATED", "x_cm": ctx.gantry_x, "y_cm": ctx.gantry_y, "moving": ctx.moving, "emergency_stop": ctx.estop}

        async def environment(_: NoArgs) -> dict:
            if ctx is None:
                return {"source": "UNAVAILABLE", "note": "no environment sensor is connected"}
            return {"source": "SIMULATED", "turbidity": ctx.turbidity, "lighting": ctx.lighting, "visibility_estimate": ctx.visibility}

        async def camera(_: NoArgs) -> dict:
            return {"online": ctx.camera_online if ctx else False, "source": "DIGITAL_TWIN" if ctx else "UNKNOWN", "resolution": "640x480"}

        async def create(args: CreateMissionArgs) -> dict:
            if created:
                raise ValueError("a mission was already created for this instruction")
            spec = args.to_spec(self._unique_id(f"{args.objective.split('_')[0]}-{int(time.time()) % 100000:05d}"))
            try:
                _, summary = compile_plan(spec)
            except PlanError as e:
                raise ValueError(str(e)) from e
            created["spec"] = spec
            return {"mission_id": spec.mission_id, "plan": summary.model_dump(), "status": "PLANNED: awaiting operator approval"}

        registry.bind("get_telemetry", telemetry)
        registry.bind("get_environment_conditions", environment)
        registry.bind("get_camera_status", camera)
        registry.bind("create_inspection_mission", create)
        try:
            outcome = await self.spark.plan(instruction, registry, ref=f"instruction:sha1={hashlib.sha1(instruction.encode()).hexdigest()[:10]} chars={len(instruction)}")
        except PlanningFailed as e:
            raise MissionError(502, str(e), {"timeline": [t.model_dump(by_alias=True, mode="json") for t in e.timeline]}) from e
        except MetaAPIError as e:
            raise MissionError(e.status if e.status in (400, 401, 402, 404, 429) else 502, f"Muse Spark request failed: {e}", e.public()) from e
        spec = created["spec"]
        return await self._store(instruction, "MUSE_SPARK", spec, outcome.explanation, outcome.timeline, [])

    async def create(self, spec: MissionSpec, instruction: str = "") -> MissionRecord:
        if self.repo.get_mission(spec.mission_id):
            raise MissionError(409, f"mission {spec.mission_id} already exists")
        rec = ToolCallRecord(name="create_inspection_mission", arguments=spec.model_dump(by_alias=True), ok=True, result={"missionId": spec.mission_id}, phase="PLANNING", by="OPERATOR", at=time.time())
        return await self._store(instruction or "(created by operator)", "OPERATOR", spec, "Created directly by the operator.", [rec], [])

    async def replan(self, mission_id: str, spec: MissionSpec | None) -> MissionRecord:
        m = self.get(mission_id)
        if m.status not in ("PLANNED", "APPROVED"):
            raise MissionError(409, f"mission {m.id} is {m.status}; only planned missions can be re-planned")
        spec = (spec or m.spec).model_copy(update={"mission_id": m.id})
        try:
            m.plan, m.plan_summary = compile_plan(spec)
        except PlanError as e:
            raise MissionError(422, str(e)) from e
        m.spec, m.status = spec, "PLANNED"
        self.repo.save_mission(m)
        return m

    async def set_status(self, mission_id: str, to: str, executor: str | None = None) -> MissionRecord:
        m = self.get(mission_id)
        self._transition(m, to)
        if executor:
            m.executor = executor  # type: ignore[assignment]
        m.timeline.append(ToolCallRecord(name={"RUNNING": "start_inspection", "PAUSED": "pause_inspection", "ABORTED": "stop_inspection"}.get(to, "set_status"), arguments={"mission_id": m.id}, ok=True, result={"status": to}, phase="EXECUTION", by="OPERATOR", at=time.time()))
        if to in ("ABORTED", "FAILED"):
            cancelled = self.pipeline.cancel(m.id)
            if cancelled:
                m.warnings.append(f"{cancelled} in-flight inference request(s) cancelled")
        self.repo.save_mission(m)
        await self.events.publish("mission.status", {"missionId": m.id, "status": to})
        return m

    async def complete(self, mission_id: str, result: TwinMissionResult) -> MissionRecord:
        m = self.get(mission_id)
        if m.status in ("COMPLETED", "ABORTED", "FAILED"):
            raise MissionError(409, f"mission {m.id} already finished as {m.status}")
        if result.mission_id != m.id:
            raise MissionError(422, "result belongs to a different mission")
        m.result = result.model_dump(by_alias=True)
        m.status = "COMPLETED" if result.outcome == "COMPLETED" else "ABORTED"
        if m.status == "ABORTED":
            self.pipeline.cancel(m.id)
        self.repo.save_mission(m)
        await self.events.publish("mission.status", {"missionId": m.id, "status": m.status, "outcome": result.outcome})
        task = asyncio.create_task(self.summarize(m.id))
        self._summaries.add(task)
        task.add_done_callback(self._summaries.discard)
        return m

    async def summarize(self, mission_id: str) -> dict[str, Any]:
        """Muse Spark summary from the stored records, or the labelled template when the model is unavailable or fails."""
        await asyncio.sleep(0.5)  # let the last capture finish processing
        report = build_report(self.repo, mission_id)
        if report is None:
            raise MissionError(404, "mission not found")
        summary: dict[str, Any]
        if self.spark is not None:
            try:
                data, latency = await self.spark.summarize({k: report[k] for k in ("mission", "outcome", "assets", "anomalyCandidates", "uninspectedAreas", "segmentation", "path", "disclaimers")}, ref=f"mission:{mission_id}")
                summary = {
                    "provider": "MUSE_SPARK",
                    "model": self.spark.model,
                    "latencyMs": round(latency, 1),
                    "summary": data.get("summary", ""),
                    "keyFindings": data.get("key_findings", []),
                    "limitations": data.get("limitations", []),
                    "recommendedFollowups": data.get("recommended_followups", []),
                }
            except MetaAPIError as e:
                summary = {**template_summary(report), "error": f"Muse Spark summary failed: {e}"}
        else:
            summary = template_summary(report)
        self.repo.save_summary(mission_id, summary)
        await self.events.publish("report.ready", {"missionId": mission_id, "provider": summary["provider"]})
        return summary
