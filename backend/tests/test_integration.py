"""End-to-end pipeline with mocked Meta HTTP:
voice -> Muse Voice Transcribe -> Muse Spark (tool calls) -> validated mission -> twin execution -> camera frame
-> Muse Spark frame reasoning -> SAM 3.1 -> track association -> observations -> report -> Muse Spark summary.
Plus the backend executor on the simulated gantry, and the negative paths for unsafe model output.
"""

import asyncio
import json
import time

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.events import EventBus
from app.hardware.drivers import SimulatedGantryDriver
from app.hardware.motion import MotionController
from app.main import create_app
from app.mission.executor import BackendExecutor
from app.schemas import MissionSpec

from .conftest import DEMO_INSTRUCTION, chat_json, chat_tool_call, demo_wav, id_mask_png, sam_line, sse, synthetic_frame

CABLE_BOX = (100, 200, 260, 260)
ROPE_BOX = (400, 120, 470, 200)


def capture_meta(mid: str, seq: int) -> str:
    return json.dumps(
        {
            "missionId": mid, "seq": seq, "reason": "SCAN", "waypointIndex": seq, "time": 3.0, "gantryX": 26.0, "gantryY": 20.0, "visibility": 0.91,
            "turbidity": 0.15, "lighting": 0.8, "perception": "NORMAL_VISIBILITY", "cameraOnline": True,
            "detections": [{"objectId": "cable-1", "trueType": "LOOSE_CABLE", "class": "LOOSE_CABLE", "confidence": 0.74, "bbox": [0.15, 0.4, 0.25, 0.12], "estX": 20, "estY": 22}],
            "idMap": [{"index": 1, "objectId": "cable-1", "type": "LOOSE_CABLE"}, {"index": 2, "objectId": "rope-1", "type": "DEBRIS"}],
            "targets": ["loose_cable", "foreign_object", "pipe_joint"],
        }
    )


def test_full_voice_to_report_pipeline(live_settings, meta):
    # 1. transcription
    meta.add("/asr/transcribe", httpx.Response(200, json={"sessionId": "asr-1", "transcript": DEMO_INSTRUCTION, "audioDurationMs": 4200, "turns": []}))
    # 2. planning: read the environment, then create the mission
    meta.add("/chat/completions", chat_tool_call("get_environment_conditions", {}, "c1"))
    meta.add(
        "/chat/completions",
        chat_tool_call(
            "create_inspection_mission",
            {"objective": "pipeline_inspection", "targets": ["loose_cable", "foreign_object", "pipe_joint"], "scan_pattern": "left_to_right", "priority": "high",
             "visibility_policy": {"reduce_speed_on_degradation": True, "stop_on_unsafe_visibility": True}, "explanation": "Single left-to-right lane over the pipeline."},
            "c2",
        ),
    )
    # 3. frame reasoning, then one SAM request per phrase
    meta.add("/chat/completions", chat_json({"scene_summary": "A pipe crosses the frame; a cable lies beside it.", "phrases": [{"phrase": "cable", "target_class": "loose_cable", "rationale": "dark strand on the sand"}]}))
    cable = np.zeros((480, 640), bool)
    x0, y0, x1, y1 = CABLE_BOX
    cable[y0 + 4 : y1 - 4, x0 + 6 : x1 - 6] = True  # slightly inside the truth box: IoU below 1, as with a real model
    meta.add("/responses", sse(["<0f>" + sam_line(0, cable, 0.91)]))
    meta.add("/responses", sse([]))  # fallback phrase for foreign_object finds nothing
    meta.add("/responses", sse([]))  # fallback phrase for pipe_joint finds nothing
    # 4. summary
    meta.add("/chat/completions", chat_json({"summary": "One loose cable candidate was segmented beside the pipeline.", "key_findings": ["loose cable near (20, 22) cm"], "limitations": ["only one capture"], "recommended_followups": ["verify the cable"]}))

    with TestClient(create_app(live_settings, meta_transport=meta.transport)) as c:
        status = c.get("/api/system/status").json()
        assert all(p["status"] == "LIVE" for p in status["providers"].values())

        t = c.post("/api/voice/transcribe", files={"audio": ("cmd.wav", demo_wav(1.5), "audio/wav")}).json()
        assert t["provider"] == "MUSE_VOICE_TRANSCRIBE" and t["transcript"] == DEMO_INSTRUCTION

        r = c.post("/api/ai/interpret", json={"instruction": t["transcript"], "context": {"gantryX": 50, "gantryY": 20, "turbidity": 0.15, "lighting": 0.8, "visibility": 0.91}}).json()
        m = r["mission"]
        assert r["provider"] == "MUSE_SPARK" and r["model"] == "muse-spark-1.3"
        assert [x["name"] for x in m["timeline"]] == ["get_environment_conditions", "create_inspection_mission"]
        assert m["timeline"][0]["result"]["source"] == "SIMULATED"
        assert m["spec"]["targets"] == ["loose_cable", "foreign_object", "pipe_joint"] and m["planSummary"]["captureCount"] == 6
        assert m["explanation"] == "Single left-to-right lane over the pipeline."
        mid = m["id"]

        assert c.post(f"/api/missions/{mid}/start", json={"executor": "TWIN"}).json()["status"] == "RUNNING"
        files = {"frame": ("f.jpg", synthetic_frame(), "image/jpeg"), "idmask": ("i.png", id_mask_png({1: CABLE_BOX, 2: ROPE_BOX}), "image/png")}
        cap = c.post("/api/inspection/capture", data={"meta": capture_meta(mid, 0)}, files=files).json()
        assert cap["reasoning"]["provider"] == "MUSE_SPARK" and cap["reasoning"]["phrases"][0]["phrase"] == "cable"
        prompts = [s["prompt"] for s in cap["segmentations"]]
        assert prompts == ["cable", "debris", "pipe flange"], "unmentioned targets still get their fallback phrase"
        seg = cap["segmentations"][0]
        assert seg["provider"] == "SAM_3_1" and seg["status"] == "OK" and seg["latencyMs"] is not None
        inst = seg["instances"][0]
        assert inst["confidence"] == pytest.approx(0.91) and inst["matchedObjectId"] == "cable-1" and 0.7 < inst["iou"] < 1.0
        assert inst["polygons"] and inst["targetClass"] == "loose_cable"
        from app.geometry import pixel_to_gantry

        bx0, by0, bx1, by1 = inst["box"]
        ex, ey = pixel_to_gantry((bx0 + bx1) / 2, (by0 + by1) / 2, 640, 480, 26.0, 20.0)
        assert (inst["worldX"], inst["worldY"]) == (round(ex, 2), round(ey, 2)), "box centre back-projected onto the sand"
        assert [s["status"] for s in cap["segmentations"][1:]] == ["EMPTY", "EMPTY"]
        obs = cap["observations"]
        assert len(obs) == 1 and obs[0]["source"] == "SAM_3_1" and obs[0]["confidenceSource"] == "SAM_3_1" and obs[0]["status"] == "UNVERIFIED_ANOMALY_CANDIDATE"

        result = {"missionId": mid, "adaptive": True, "outcome": "COMPLETED", "waypointsVisited": 6, "waypointsPlanned": 6, "captures": 1, "unreliableCaptures": 0,
                  "reobservations": 0, "pauses": 0, "confirmedTargets": 1, "falsePositives": 0, "avgConfidence": 0.74, "coverage": 1.0, "minVisibility": 0.9, "durationS": 20}
        c.post(f"/api/missions/{mid}/complete", json=result)
        deadline = time.time() + 5
        while time.time() < deadline and c.get(f"/api/inspection/{mid}/report").json()["summary"]["provider"] != "MUSE_SPARK":
            time.sleep(0.1)
        rep = c.get(f"/api/inspection/{mid}/report").json()
        assert rep["summary"]["provider"] == "MUSE_SPARK" and "loose cable" in rep["summary"]["summary"]
        assert rep["segmentation"]["provider"] == "SAM_3_1" and 0.7 < rep["segmentation"]["meanIouVsTwinTruth"] < 1.0
        assert rep["anomalyCandidates"][0]["confidenceSource"] == "SAM_3_1"
        summary_req = meta.bodies("/chat/completions")[-1]
        assert summary_req["response_format"]["json_schema"]["name"] == "InspectionSummary"
        usage = c.get("/api/system/status").json()["usage"]
        assert usage["sam-3.1"]["images"] == 3 and usage["muse-voice-transcribe-1.0"]["audioMs"] == 4200 and usage["muse-spark-1.3"]["requests"] == 4
    assert not [q for q in meta.queues.values() if q], "every mocked response was consumed"


def test_unsafe_model_output_never_becomes_a_mission(live_settings, meta):
    for _ in range(6):
        meta.add("/chat/completions", chat_tool_call("move_to_waypoint", {"x": 99, "y": 39, "speed_fraction": 1.0}))
    with TestClient(create_app(live_settings, meta_transport=meta.transport)) as c:
        r = c.post("/api/ai/interpret", json={"instruction": "move the gantry to the corner now"})
        assert r.status_code == 502
        timeline = r.json()["detail"]["timeline"]
        assert len(timeline) == 6 and all(not t["ok"] and "not permitted" in t["error"] for t in timeline)
        assert c.get("/api/missions").json() == []
        assert c.get("/api/telemetry").json()["gantry"]["status"]["x"] == 50, "nothing moved"


def test_spark_failure_is_reported_not_faked(live_settings, meta):
    meta.add("/chat/completions", httpx.Response(401, json={"error": {"message": "Unauthorized", "type": "authentication_error", "code": "invalid_api_key"}}))
    with TestClient(create_app(live_settings, meta_transport=meta.transport)) as c:
        r = c.post("/api/ai/interpret", json={"instruction": DEMO_INSTRUCTION})
        assert r.status_code == 401 and "Muse Spark request failed" in r.json()["error"]
        # The operator can explicitly choose the labelled offline parser instead.
        r = c.post("/api/ai/interpret?offline=true", json={"instruction": DEMO_INSTRUCTION})
        assert r.status_code == 200 and r.json()["provider"] == "OFFLINE_RULE_PARSER"


def test_segmentation_timeout_and_rate_limit_are_isolated_per_request(live_settings, meta):
    meta.add("/chat/completions", chat_json({"scene_summary": "", "phrases": [{"phrase": "cable", "target_class": "loose_cable", "rationale": ""}]}))
    meta.add("/responses", httpx.Response(429, json={"error": {"message": "slow", "type": "rate_limit_error", "code": "rate_limit_exceeded"}}))
    meta.add("/responses", httpx.Response(400, json={"error": {"message": "invalid prompt", "type": "invalid_request_error"}}))
    with TestClient(create_app(live_settings, meta_transport=meta.transport)) as c:
        mid = c.post("/api/ai/interpret?offline=true", json={"instruction": "inspect cables only"}).json()["mission"]["id"]
        meta_json = json.loads(capture_meta(mid, 0))
        meta_json["targets"] = ["loose_cable"]
        cap = c.post("/api/inspection/capture", data={"meta": json.dumps(meta_json)}, files={"frame": ("f.jpg", synthetic_frame(), "image/jpeg")}).json()
        seg = cap["segmentations"][0]
        assert seg["status"] == "FAILED" and "invalid prompt" in seg["error"]
        assert cap["observations"] == [] and cap["quality"] is not None, "a failed model call never loses the frame or its quality record"


@pytest.mark.anyio
async def test_backend_executor_on_the_simulated_gantry(settings):
    """Hardware-path executor: interlocked moves, frame-derived visibility, a pause in murky water, then completion."""
    from app.db import Repository
    from app.perception.pipeline import PerceptionPipeline

    driver = SimulatedGantryDriver()
    motion = MotionController(driver, EventBus(), hardware=False)
    repo = Repository(settings.sqlite_path, settings.data_dir)
    try:
        await _executor_scenarios(settings, repo, driver, motion)
    finally:
        repo.close()


async def _executor_scenarios(settings, repo, driver, motion):
    from app.perception.pipeline import PerceptionPipeline

    pipeline = PerceptionPipeline(settings, repo, EventBus(), None, None)
    from app.mission.compiler import compile_plan
    from app.schemas import MissionRecord

    spec = MissionSpec(mission_id="exec-test", targets=["loose_cable"], capture_spacing_cm=40)
    plan, summary = compile_plan(spec)
    rec = MissionRecord(id="exec-test", created_at=0, instruction="", provider="OPERATOR", status="RUNNING", spec=spec, plan=plan, plan_summary=summary)
    repo.save_mission(rec)
    # Clear, clear, murky x6 (pause), clear...: contrast scales the synthetic frame toward flat murk.
    contrasts = iter([1.0, 1.0] + [0.05] * 6 + [1.0] * 40)
    grabs = []

    async def grab():
        k = next(contrasts)
        grabs.append(k)
        return synthetic_frame(contrast=k), 640, 480

    ex = BackendExecutor(motion, grab, pipeline, poll_dt=0.5, tick=lambda: driver.advance(0.05))
    res = await ex.run(rec)
    assert res.outcome == "COMPLETED" and res.waypoints_visited == len(plan.waypoints) and res.captures == len(plan.waypoints)
    assert res.pauses == 1 and "INSPECTION_PAUSED" in res.states and res.unreliable_captures == 0
    assert (driver.x.pos, driver.y.pos) == (plan.waypoints[-1].x, plan.waypoints[-1].y)
    assert len(repo.captures_for("exec-test")) == len(plan.waypoints)

    # An emergency stop mid-mission ends it and nothing moves afterwards.
    driver2 = SimulatedGantryDriver()
    motion2 = MotionController(driver2, EventBus(), hardware=False)

    async def grab_then_estop():
        if driver2.x.pos < 40 and driver2.moving:
            await motion2.emergency_stop("test")
        return synthetic_frame(), 640, 480

    ex2 = BackendExecutor(motion2, grab_then_estop, pipeline, tick=lambda: driver2.advance(0.05))
    await motion2.emergency_stop("pre-latched")
    res2 = await ex2.run(rec)
    assert res2.outcome == "EMERGENCY_STOP" and res2.waypoints_visited == 0
