"""HTTP and WebSocket contracts in offline SIMULATION mode (no credentials), plus persistence across restarts."""

import json

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

from .conftest import DEMO_INSTRUCTION, demo_wav, id_mask_png, synthetic_frame

CTX = {"gantryX": 50, "gantryY": 20, "turbidity": 0.15, "lighting": 0.8, "visibility": 0.91}


def capture_meta(mission_id: str, seq: int, **kw) -> str:
    meta = {
        "missionId": mission_id, "seq": seq, "reason": "SCAN", "waypointIndex": seq, "time": seq * 3.0, "gantryX": 26.0, "gantryY": 20.0,
        "visibility": 0.91, "turbidity": 0.15, "lighting": 0.8, "perception": "NORMAL_VISIBILITY", "cameraOnline": True,
        "detections": [
            {"objectId": "cable-1", "trueType": "LOOSE_CABLE", "class": "LOOSE_CABLE", "confidence": 0.74, "bbox": [0.15, 0.4, 0.25, 0.12], "estX": 20.0, "estY": 22.0},
            {"objectId": "rope-1", "trueType": "DEBRIS", "class": "UNKNOWN", "confidence": 0.61, "bbox": [0.62, 0.25, 0.11, 0.17], "estX": 34.0, "estY": 17.0},
        ],
        "idMap": [{"index": 1, "objectId": "cable-1", "type": "LOOSE_CABLE"}, {"index": 2, "objectId": "rope-1", "type": "DEBRIS"}],
        "targets": ["loose_cable", "foreign_object", "pipe_joint"],
    }
    meta.update(kw)
    return json.dumps(meta)


def post_capture(c: TestClient, mission_id: str, seq: int, **kw):
    files = {"frame": ("f.jpg", synthetic_frame(seed=seq), "image/jpeg"), "idmask": ("i.png", id_mask_png({1: (100, 200, 260, 260), 2: (400, 120, 470, 200)}), "image/png")}
    return c.post("/api/inspection/capture", data={"meta": capture_meta(mission_id, seq, **kw)}, files=files)


def recv(ws, skip=("hardware.status", "hardware.estop", "heartbeat")):
    while True:
        m = ws.receive_json()
        if m.get("type") not in skip:
            return m


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings)) as c:
        yield c


def test_health_status_and_config_expose_no_secrets(client):
    assert client.get("/api/health").json()["status"] == "ok"
    s = client.get("/api/system/status").json()
    assert s["mode"] == "SIMULATION" and not s["hardwareActive"]
    assert all(p["status"] == "OFFLINE" for p in s["providers"].values())
    cfg = client.get("/api/system/config").json()
    assert cfg["metaConfigured"] is False and "modelApiKey" not in json.dumps(cfg) and cfg["geometry"]["travelX"] == 100


def test_offline_mission_lifecycle_capture_and_report(client):
    r = client.post("/api/ai/interpret", json={"instruction": DEMO_INSTRUCTION, "context": CTX})
    assert r.status_code == 200
    m = r.json()["mission"]
    assert m["provider"] == "OFFLINE_RULE_PARSER" and m["status"] == "PLANNED"
    assert any("offline keyword parser" in w for w in m["warnings"])
    mid = m["id"]
    assert client.post(f"/api/missions/{mid}/pause").status_code == 409, "cannot pause a mission that is not running"
    assert client.post(f"/api/missions/{mid}/start", json={"executor": "BACKEND"}).status_code == 409, "backend executor needs hardware"
    assert client.post(f"/api/missions/{mid}/start", json={"executor": "TWIN"}).json()["status"] == "RUNNING"
    assert client.post(f"/api/missions/{mid}/pause").json()["status"] == "PAUSED"
    assert client.post(f"/api/missions/{mid}/resume").json()["status"] == "RUNNING"

    cap = post_capture(client, mid, 0).json()
    assert cap["quality"]["source"] == "IMAGE_DERIVED_ESTIMATE"
    assert cap["reasoning"]["provider"] == "UNAVAILABLE"
    seg = cap["segmentations"][0]
    assert seg["provider"] == "OFFLINE_FIXTURE" and seg["status"] == "OK"
    # Only the cable is a target class detected by the sim detector; UNKNOWN never gets a mask.
    assert [i["matchedObjectId"] for i in seg["instances"]] == ["cable-1"]
    assert all(i["confidence"] is None for i in seg["instances"]), "fixture masks carry no model confidence"
    obs = {o["label"]: o for o in cap["observations"]}
    assert obs["loose_cable"]["source"] == "SIM_DETECTOR" and obs["loose_cable"]["status"] == "UNVERIFIED_ANOMALY_CANDIDATE"
    assert obs["unknown"]["status"] == "LOW_CONFIDENCE"

    # The same view from the same place again (a held position): segmentation is reused, no new request.
    files = {"frame": ("f.jpg", synthetic_frame(seed=0), "image/jpeg")}
    dup = client.post("/api/inspection/capture", data={"meta": capture_meta(mid, 1)}, files=files).json()
    assert dup["duplicateOf"] == cap["captureId"] and all(s["status"] == "REUSED" for s in dup["segmentations"])
    moved = client.post(
        "/api/inspection/capture", data={"meta": capture_meta(mid, 2, gantryX=42.0)}, files={"frame": ("f.jpg", synthetic_frame(seed=0), "image/jpeg")}
    ).json()
    assert moved["duplicateOf"] is None, "an identical-looking frame from a different position is not a duplicate"

    fault = post_capture(client, mid, 3, gantryX=60.0, perceptionFault="SEGMENTATION_FAILURE").json()
    assert fault["segmentations"][0]["status"] == "FAILED" and "test fixture" in fault["segmentations"][0]["error"]

    result = {"missionId": mid, "adaptive": True, "outcome": "COMPLETED", "waypointsVisited": 6, "waypointsPlanned": 6, "captures": 4, "unreliableCaptures": 0,
              "reobservations": 1, "pauses": 0, "confirmedTargets": 3, "falsePositives": 0, "avgConfidence": 0.7, "coverage": 1.0, "minVisibility": 0.9, "durationS": 28.2}
    assert client.post(f"/api/missions/{mid}/complete", json=result).json()["status"] == "COMPLETED"
    assert client.post(f"/api/missions/{mid}/complete", json=result).status_code == 409

    rep = client.get(f"/api/inspection/{mid}/report").json()
    assert rep["outcome"]["status"] == "COMPLETED" and len(rep["path"]) == 4
    assert rep["anomalyCandidates"][0]["label"] == "loose_cable"
    assert rep["segmentation"]["provider"] == "OFFLINE_FIXTURE" and rep["segmentation"]["meanIouVsTwinTruth"] is None
    assert rep["summary"]["provider"] == "TEMPLATE_FROM_RECORDS"
    assert rep["path"][0]["simulated"]["source"] == "SIMULATED"
    assert isinstance(rep["uninspectedAreas"], list) and 0 < rep["coverageEstimate"] <= 1
    md = client.get(f"/api/inspection/{mid}/report?format=md")
    assert md.status_code == 200 and "Unverified anomaly candidates" in md.text and "\u2014" not in md.text
    assert client.get(f"/api/inspection/frames/{cap['captureId']}").headers["content-type"] == "image/jpeg"
    hist = client.get("/api/inspection/history").json()
    assert hist[0]["id"] == mid and hist[0]["captures"] == 4


def test_duplicate_reuse_requires_same_inputs_and_a_successful_result(client):
    """Regression: a scenario G capture at the same pose as an earlier good capture reused its OK segmentation, masking the fault."""
    frame = lambda: {"frame": ("f.jpg", synthetic_frame(seed=0), "image/jpeg"), "idmask": ("i.png", id_mask_png({1: (100, 200, 260, 260)}), "image/png")}
    send = lambda seq, **kw: client.post("/api/inspection/capture", data={"meta": capture_meta("manual", seq, **kw)}, files=frame()).json()
    first = send(0)
    assert first["segmentations"][0]["status"] == "OK"
    faulted = send(1, perceptionFault="SEGMENTATION_FAILURE")
    assert faulted["duplicateOf"] is None and faulted["segmentations"][0]["status"] == "FAILED"
    retried = send(2, perceptionFault="SEGMENTATION_FAILURE")
    assert retried["duplicateOf"] is None, "a failed result is retried, never reused"
    send(3)
    reused = send(4)
    assert reused["duplicateOf"] is not None and reused["segmentations"][0]["status"] == "REUSED"
    narrowed = send(5, targets=["valve"])
    assert narrowed["duplicateOf"] is None, "different targets are a different question"


def test_capture_validation_and_voice_offline(client):
    bad = client.post("/api/inspection/capture", data={"meta": json.dumps({"missionId": "x"})}, files={"frame": ("f.jpg", b"x", "image/jpeg")})
    assert bad.status_code == 422
    notimg = client.post("/api/inspection/capture", data={"meta": capture_meta("m", 0)}, files={"frame": ("f.jpg", b"not an image", "image/jpeg")})
    assert notimg.status_code == 422
    v = client.post("/api/voice/transcribe", files={"audio": ("a.wav", demo_wav(), "audio/wav")})
    assert v.status_code == 503 and "Type the instruction" in v.json()["detail"]
    assert client.post("/api/ai/segment", json={"captureId": "nope", "prompt": "cable"}).status_code == 404


def test_missions_and_assets_persist_across_restarts(settings):
    with TestClient(create_app(settings)) as c:
        mid = c.post("/api/ai/interpret", json={"instruction": "inspect the valve"}).json()["mission"]["id"]
        c.post(f"/api/missions/{mid}/start", json={})
        post_capture(c, mid, 0)
        assets = c.get("/api/inspection/assets").json()
    with TestClient(create_app(settings)) as c:
        assert c.get(f"/api/missions/{mid}").json()["status"] == "RUNNING"
        assert c.get("/api/inspection/assets").json() == assets
        # A second mission seeing the same cable joins the same asset: identity across inspection sessions.
        mid2 = c.post("/api/ai/interpret", json={"instruction": "inspect the valve again"}).json()["mission"]["id"]
        c.post(f"/api/missions/{mid2}/start", json={})
        post_capture(c, mid2, 0)
        cable = [a for a in c.get("/api/inspection/assets").json() if a["label"] == "loose_cable"]
        assert len(cable) == 1 and set(cable[0]["missions"]) == {mid, mid2}


def test_websockets_events_commands_and_invalid_messages(client):
    with client.websocket_connect("/ws/events") as ws:
        assert ws.receive_json()["type"] == "hello"
        ws.send_text("{not json")
        err = recv(ws)
        assert err["type"] == "error" and err["v"] == 1
        ws.send_text(json.dumps({"type": "ping"}))
        assert recv(ws)["type"] == "pong"
        client.post("/api/ai/interpret", json={"instruction": "inspect the pipeline"})
        ev = recv(ws)
        assert ev["type"] == "mission.planned" and ev["seq"] > 0
    with client.websocket_connect("/ws/events?since=0") as ws:
        assert recv(ws)["type"] == "hello"
        assert recv(ws)["type"] == "mission.planned", "a reconnecting client replays what it missed"
    with client.websocket_connect("/ws/commands") as ws:
        ws.send_text(json.dumps({"v": 1, "id": "1", "command": {"type": "SELF_DESTRUCT"}}))
        assert ws.receive_json()["ok"] is False
        ws.send_text(json.dumps({"v": 1, "id": "2", "command": {"type": "MOVE_TO", "x": 500, "y": 10}}))
        r = ws.receive_json()
        assert r["ok"] is False and "soft travel" in r["error"]
        ws.send_text(json.dumps({"v": 1, "id": "3", "command": {"type": "ESTOP"}}))
        assert ws.receive_json()["state"]["estop"] is True
        ws.send_text(json.dumps({"v": 1, "id": "4", "command": {"type": "MOVE_TO", "x": 10, "y": 10}}))
        assert "emergency stop" in ws.receive_json()["error"]
    mid = client.post("/api/ai/interpret", json={"instruction": "inspect the pipeline"}).json()["mission"]["id"]
    assert client.post(f"/api/missions/{mid}/start", json={}).status_code == 409, "no mission starts while the e-stop is latched"
    with client.websocket_connect("/ws/telemetry") as ws:
        t = ws.receive_json()
        assert t["type"] == "telemetry" and t["data"]["gantry"]["estop"] is True
