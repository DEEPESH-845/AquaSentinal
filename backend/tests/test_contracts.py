"""Cross-language contracts: geometry, plan compilation and the simulated gantry must match the TypeScript twin."""

import json

import pytest
from pydantic import ValidationError

from app.config import SHARED_DIR
from app.geometry import pixel_to_gantry
from app.hardware.drivers import SimulatedGantryDriver
from app.mission.compiler import PlanError, compile_plan
from app.schemas import MissionSpec, Region, VisibilityPolicySpec


def fixture(name: str) -> dict:
    return json.loads((SHARED_DIR / "fixtures" / name).read_text())


def test_projection_matches_typescript():
    f = fixture("projection.json")
    for c in f["cases"]:
        x, y = pixel_to_gantry(c["px"], c["py"], f["width"], f["height"], c["gx"], c["gy"])
        assert x == pytest.approx(c["x"], abs=1e-9) and y == pytest.approx(c["y"], abs=1e-9)


def test_simulated_driver_matches_typescript_trajectory():
    f = fixture("trajectory.json")
    d = SimulatedGantryDriver(tuple(f["start"]))
    d.speed_fraction = f["speedFraction"]
    samples, step = [], 0
    for x, y in f["legs"]:
        d.x.target, d.y.target = x, y
        for _ in range(120 * 30):
            d.advance(1 / 120)
            step += 1
            if step % f["sampleEverySubsteps"] == 0:
                samples.append([d.x.pos, d.y.pos, d.x.vel, d.y.vel])
            if d.at_target():
                break
    assert len(samples) == len(f["samples"])
    for got, want in zip(samples, f["samples"]):
        assert got == pytest.approx(want, abs=1e-9)


def test_compiler_produces_the_contract_plan():
    spec = MissionSpec.model_validate(fixture("pipeline-spec.json"))
    plan, summary = compile_plan(spec)
    want = fixture("pipeline-plan.json")
    want.pop("$comment")
    assert plan.model_dump(by_alias=True) == want
    assert summary.capture_count == 6 and summary.lanes == 1


def test_serpentine_and_right_to_left_orders():
    spec = MissionSpec.model_validate({**fixture("pipeline-spec.json"), "scanPattern": "serpentine", "laneSpacingCm": 12})
    plan, summary = compile_plan(spec)
    assert summary.lanes == 2
    xs = [w.x for w in plan.waypoints]
    half = len(xs) // 2
    assert xs[:half] == sorted(xs[:half]) and xs[half:] == sorted(xs[half:], reverse=True)
    rtl, _ = compile_plan(spec.model_copy(update={"scan_pattern": "right_to_left"}))
    assert rtl.waypoints[0].x == 90 and rtl.waypoints[-1].x == 10


@pytest.mark.parametrize(
    "patch, message",
    [
        ({"targets": ["submarine"]}, "targets"),
        ({"targets": []}, "targets"),
        ({"region": {"xMin": 0, "xMax": 140, "yMin": 0, "yMax": 40}}, "x_max"),
        ({"region": {"xMin": 60, "xMax": 20, "yMin": 0, "yMax": 40}}, "x_min must be below"),
        ({"speedFraction": 3}, "speed_fraction"),
        ({"visibilityPolicy": {"degradedVisibility": 0.4, "unsafeVisibility": 0.6}}, "unsafe_visibility must be below"),
        ({"missionId": "../../etc"}, "mission_id"),
        ({"launchMissiles": True}, "launchMissiles"),
    ],
)
def test_invalid_specs_are_rejected(patch, message):
    with pytest.raises(ValidationError) as e:
        MissionSpec.model_validate({**fixture("pipeline-spec.json"), **patch})
    assert message.replace("_", "").lower() in str(e.value).replace("_", "").lower()


def test_plan_size_guards(monkeypatch):
    """Schema bounds cap a plan at 70 waypoints and about 260 s, so these guards are defence in depth: prove they fire."""
    import app.mission.compiler as compiler

    spec = MissionSpec(mission_id="dense-grid", targets=["debris"], region=Region(x_min=0, x_max=100, y_min=0, y_max=40), lane_spacing_cm=8, capture_spacing_cm=8, speed_fraction=0.2)
    plan, summary = compile_plan(spec)
    assert summary.waypoint_count == 70 and summary.estimated_duration_s < compiler.MAX_DURATION_S
    monkeypatch.setattr(compiler, "MAX_DURATION_S", 60.0)
    with pytest.raises(PlanError, match="duration"):
        compile_plan(spec)
    monkeypatch.setattr(compiler, "MAX_WAYPOINTS", 20)
    with pytest.raises(PlanError, match="waypoints"):
        compile_plan(spec)


def test_policy_defaults_come_from_shared_config():
    p = VisibilityPolicySpec()
    shared = json.loads((SHARED_DIR / "perception.json").read_text())
    assert (p.degraded_visibility, p.unsafe_visibility, p.reduced_speed_fraction) == (shared["degradedVisibility"], shared["unsafeVisibility"], shared["reducedSpeedFraction"])
