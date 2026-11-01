"""Offline parser, tool allowlist and the Python visibility controller."""

import pytest

from app.mission.offline import parse_instruction
from app.mission.tools import TOOLS, NoArgs, ToolRegistry
from app.perception.controller import VisibilityController
from app.schemas import PlanPolicy

from .conftest import DEMO_INSTRUCTION


def test_offline_parser_on_the_demo_instruction():
    spec, notes = parse_instruction(DEMO_INSTRUCTION)
    assert spec.objective == "pipeline_inspection"
    assert spec.targets == ["loose_cable", "foreign_object", "pipe_joint"]
    assert spec.scan_pattern == "left_to_right"
    assert spec.visibility_policy.reduce_speed_on_degradation and spec.visibility_policy.stop_on_unsafe_visibility
    assert "no language model" in spec.notes
    assert any("flange joints" in n for n in notes)


def test_offline_parser_respects_explicit_opt_outs_and_patterns():
    spec, _ = parse_instruction("Survey the whole tank quickly for debris, do not stop for murky water")
    assert spec.objective == "area_survey" and spec.scan_pattern == "serpentine" and spec.speed_fraction == 0.85
    assert spec.visibility_policy.stop_on_unsafe_visibility is False
    spec, _ = parse_instruction("check the valve right to left slowly")
    assert spec.targets[:1] == ["valve"] and spec.scan_pattern == "right_to_left" and spec.speed_fraction == 0.45


def test_model_only_sees_planning_tools():
    names = {t["function"]["name"] for t in ToolRegistry.schemas("PLANNING")}
    assert names == {"get_telemetry", "get_environment_conditions", "get_camera_status", "create_inspection_mission"}
    assert len(TOOLS) == 12
    for t in ToolRegistry.schemas("PLANNING"):
        assert t["type"] == "function" and t["function"]["parameters"]["type"] == "object"


@pytest.mark.anyio
async def test_dispatch_refuses_wrong_phase_unknown_tools_and_bad_args():
    reg = ToolRegistry()
    moved = []

    async def move(args):
        moved.append(args)

    async def tel(_: NoArgs):
        return {"x": 1}

    reg.bind("move_to_waypoint", move)
    reg.bind("get_telemetry", tel)
    r = await reg.dispatch("move_to_waypoint", {"x": 10, "y": 10}, "PLANNING", "MUSE_SPARK")
    assert not r.ok and "not permitted during PLANNING" in r.error and not moved
    r = await reg.dispatch("rm_rf", {}, "PLANNING", "MUSE_SPARK")
    assert not r.ok and "does not exist" in r.error
    r = await reg.dispatch("move_to_waypoint", {"x": 500, "y": 10}, "EXECUTION", "OPERATOR")
    assert not r.ok and "invalid arguments" in r.error and not moved
    r = await reg.dispatch("get_telemetry", '{"sneaky": 1}', "PLANNING", "MUSE_SPARK")
    assert not r.ok and "invalid arguments" in r.error
    r = await reg.dispatch("get_telemetry", "{}", "PLANNING", "MUSE_SPARK")
    assert r.ok and r.result == {"x": 1}
    r = await reg.dispatch("move_to_waypoint", {"x": 10, "y": 10}, "EXECUTION", "OPERATOR")
    assert r.ok and len(moved) == 1


def test_visibility_controller_states():
    policy = PlanPolicy(reduce_speed_on_degradation=True, stop_on_unsafe_visibility=True, degraded_visibility=0.75, unsafe_visibility=0.45, reduced_speed_fraction=0.35)
    c = VisibilityController(policy, 0.65)
    assert c.step(0.9, True, 0.5).speed_fraction == 0.65
    d = c.step(0.6, True, 0.5)
    assert d.state == "REDUCED_VISIBILITY" and d.speed_fraction == 0.35
    d = c.step(0.3, True, 0.5)
    assert d.paused and d.state == "INSPECTION_PAUSED" and c.pauses == 1
    for _ in range(40):
        d = c.step(0.3, True, 0.5)
    assert d.state == "OPERATOR_INTERVENTION_REQUIRED"
    c.step(0.9, True, 1.0)
    d = c.step(0.9, True, 1.0)
    assert not d.paused, "resumes after resumeAfterS of normal visibility"
    assert c.step(0.9, False, 0.5).paused, "camera loss pauses"
