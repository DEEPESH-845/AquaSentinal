"""Work orders: the schema, the grounding checks, the offline rule table, and the live Muse Spark structured-output call (scripted over a
mocked httpx transport) through the credit governor. No test touches the network."""

import json
from dataclasses import replace

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.main import create_app
from app.meta.spark import HINDI_INSTRUCTION
from app.mission.ask import NoAnswer
from app.mission.workorders import MAX_ORDERS, NOTHING_TO_ORDER, WORKORDERS_SYSTEM, offline_orders, validate_orders
from app.schemas import WorkOrder

from .conftest import chat_json
from .test_ask import CABLE_DET, seed, seeded
from .test_governor import FRAME_C, PASSCODE, capture_form, post

GHOST = "cap_deadbeef0001"


def orders(c: TestClient, mid: str, language: str = "en", **kw) -> dict:
    r = c.post(f"/api/inspection/{mid}/work-orders", json={"language": language}, **kw)
    assert r.status_code == 200, r.text
    return r.json()


def tracks_of(c: TestClient, mid: str) -> dict[str, dict]:
    """The mission's tracked objects by class, from the report."""
    return {a["label"]: a for a in c.get(f"/api/inspection/{mid}/report").json()["assets"]}


def row(priority="P2", evidence=None, **kw) -> dict:
    return {"priority": priority, "title": "Remove the object", "location": {"x": 60.0, "y": 10.0}, "evidence": evidence or [], "action": "Remove it.", "effort": "S", "rationale": "Seen once.", **kw}


# ---------------------------------------------------------------- the schema


def test_the_schema_accepts_a_well_formed_order_and_rejects_everything_else():
    ok = WorkOrder.model_validate({**row(evidence=["cap_a"]), "id": "WO-01", "surprise": "ignored"})
    assert ok.priority == "P2" and ok.location.x == 60.0 and "surprise" not in ok.model_dump()
    assert ok.model_dump(by_alias=True)["evidence"] == ["cap_a"]
    for bad in (
        {"priority": "P4"}, {"effort": "XL"}, {"title": ""}, {"action": "x" * 301}, {"rationale": ""},
        {"location": {"x": -1, "y": 5}}, {"location": {"x": 50, "y": 41}}, {"location": {"x": 50}}, {"evidence": [f"cap_{i}" for i in range(7)]},
    ):
        with pytest.raises(ValidationError):
            WorkOrder.model_validate({**row(), "id": "WO-01", **bad})


def test_unknown_evidence_invalid_rows_and_unevidenced_orders_are_dropped_never_repaired():
    good = row("P2", ["cap_real1"])
    raw = [
        row("P3", ["cap_real1"], title="Routine"),
        good,
        row("P1", ["cap_real1", GHOST], title="Half invented"),  # one invented id sinks the whole order
        row("P1", [GHOST], title="All invented"),
        row("P1", [], title="No evidence"),
        row("P9", ["cap_real1"], title="Bad priority"),
        row("P1", ["cap_real1"], location={"x": 500, "y": 10}, title="Off the tank"),
        "not an object",
    ]
    kept, unknown, dropped = validate_orders(raw, {"cap_real1"})
    assert [(o.id, o.priority, o.title) for o in kept] == [("WO-01", "P2", "Remove the object"), ("WO-02", "P3", "Routine")], "most urgent first, numbered after the checks"
    assert unknown == [GHOST] and dropped == 6
    with pytest.raises(NoAnswer, match="no orders array"):
        validate_orders({"orders": []}, set())
    assert validate_orders([], {"cap_real1"}) == ([], [], 0)
    many = [row("P3", ["cap_real1"], title=f"t{i}") for i in range(MAX_ORDERS + 5)]
    assert len(validate_orders(many, {"cap_real1"})[0]) == MAX_ORDERS


# ---------------------------------------------------------------- offline rules


def test_the_offline_rule_table_maps_each_class_to_its_order():
    def track(label, **kw):
        return {"trackId": f"asset_{label}", "label": label, "x": 10.0, "y": 5.0, "observations": 2, "status": "OBSERVED", "sources": ["SIM_DETECTOR"], "bestConfidence": 0.8,
                "confidenceSource": "SIM_DETECTOR", "captureIds": ["cap_1", "cap_2", "cap_3", "cap_4"], **kw}

    got = offline_orders([track("valve"), track("foreign_object", status="UNVERIFIED_ANOMALY_CANDIDATE"), track("pipe_joint"), track("loose_cable", status="UNVERIFIED_ANOMALY_CANDIDATE", bestConfidence=None)])
    assert [(o.id, o.priority, o.title, o.effort) for o in got] == [
        ("WO-01", "P1", "Secure and re-route the loose cable", "M"),
        ("WO-02", "P2", "Remove the foreign object", "S"),
        ("WO-03", "P3", "Inspect the valve", "S"),
        ("WO-04", "P3", "Inspect the pipe joint", "S"),
    ], "P1 cable, P2 foreign object, every other class a P3 inspection, in that order"
    cable = got[0]
    assert cable.evidence == ["cap_1", "cap_2", "cap_3"] and (cable.location.x, cable.location.y) == (10.0, 5.0)
    assert "unverified anomaly candidate" in cable.rationale.lower() and "confirmed" not in cable.rationale.lower() and "confidence" not in cable.rationale
    assert "best confidence 80 percent" in got[2].rationale and "the simulated detector" in got[2].rationale
    assert offline_orders([]) == []


def test_no_key_writes_the_orders_from_the_rules_and_says_so(settings):
    with TestClient(create_app(settings)) as c:
        mid = seed(c)
        real = {cap["id"] for cap in c.app.state.s.repo.captures_for(mid)}
        tr = tracks_of(c, mid)
        r = orders(c, mid)
        assert r["provider"] == "OFFLINE_RULES" and r["model"] is None and r["fallback"] == "NO_KEY" and "MODEL_API_KEY" in r["note"]
        assert r["classification"] is None and r["executionIds"] == [] and r["language"] == "en" and r["droppedEvidence"] == [] and r["droppedOrders"] == 0
        cable, foreign = r["orders"]
        assert (cable["id"], cable["priority"], cable["title"]) == ("WO-01", "P1", "Secure and re-route the loose cable")
        assert (foreign["id"], foreign["priority"], foreign["title"]) == ("WO-02", "P2", "Remove the foreign object")
        assert cable["location"] == {"x": tr["loose_cable"]["x"], "y": tr["loose_cable"]["y"]} and cable["evidence"] == tr["loose_cable"]["captureIds"]
        assert foreign["location"] == {"x": tr["foreign_object"]["x"], "y": tr["foreign_object"]["y"]}
        assert set(cable["evidence"] + foreign["evidence"]) <= real
        # Hindi is asked for, English is delivered, and the response says which
        assert orders(c, mid, "hi")["language"] == "en"


def test_the_route_validates_the_request_and_the_mission(settings):
    with TestClient(create_app(settings)) as c:
        assert c.post("/api/inspection/mis_nope/work-orders", json={}).status_code == 404
        mid = seed(c)
        assert c.post(f"/api/inspection/{mid}/work-orders", json={}).json()["language"] == "en", "language defaults to English"
        assert c.post(f"/api/inspection/{mid}/work-orders", json={"language": "fr"}).status_code == 422
        assert c.post(f"/api/inspection/{mid}/work-orders", json={"language": "en", "extra": 1}).status_code == 422


# ---------------------------------------------------------------- live


def live_reply(captures: dict[str, list[str]], extra: list[dict] | None = None) -> httpx.Response:
    """What Muse Spark might write: a cable order and a foreign object order citing the real captures, plus whatever else `extra` adds."""
    cable = row("P1", captures["loose_cable"][:1], title="Re-route cable", location={"x": 20.0, "y": 22.0}, action="Verify, then secure the cable.", effort="M")
    wrench = row("P3", captures["foreign_object"][:1], title="Fetch the wrench", location={"x": 60.0, "y": 10.0})
    return chat_json({"orders": [wrench, cable, *(extra or [])]})


def test_live_orders_come_from_one_structured_output_call_and_are_grounded_logged_and_cached(settings, live_settings, meta):
    seeded(settings)
    with TestClient(create_app(live_settings, meta_transport=meta.transport)) as c:
        mid = c.get("/api/missions").json()[0]["id"]
        tr = tracks_of(c, mid)
        caps = {k: v["captureIds"] for k, v in tr.items()}
        meta.add("/chat/completions", live_reply(caps, [row("P1", [GHOST], title="Invented evidence"), row("P7", caps["loose_cable"], title="Bad priority"), row("P2", [], title="No evidence")]))
        r = orders(c, mid)
        assert r["provider"] == "MUSE_SPARK" and r["model"] == "muse-spark-1.3" and r["fallback"] is None and r["note"] == ""
        assert [(o["id"], o["priority"], o["title"]) for o in r["orders"]] == [("WO-01", "P1", "Re-route cable"), ("WO-02", "P3", "Fetch the wrench")], "most urgent first"
        assert r["orders"][0]["evidence"] == caps["loose_cable"][:1] and r["orders"][0]["location"] == {"x": 20.0, "y": 22.0}
        assert r["droppedEvidence"] == [GHOST] and r["droppedOrders"] == 3 and r["language"] == "en"

        # one bounded request: the schema is the response format, the records are the user message, the ids it may cite are in them
        (body,) = meta.bodies("/chat/completions")
        assert body["response_format"]["type"] == "json_schema" and body["response_format"]["json_schema"]["name"] == "WorkOrders"
        assert body["response_format"]["json_schema"]["schema"]["properties"]["orders"]["items"]["properties"]["priority"]["enum"] == ["P1", "P2", "P3"]
        assert body["max_tokens"] == 1500 and "tools" not in body
        assert body["messages"][0] == {"role": "system", "content": WORKORDERS_SYSTEM}
        records = json.loads(body["messages"][1]["content"])
        assert {t["label"] for t in records["trackedObjects"]} == {"loose_cable", "foreign_object"} and records["trackedObjects"][0]["captureIds"] == caps["loose_cable"]
        assert set(records) == {"missionId", "instruction", "trackedObjects", "uninspectedStrips", "disclaimer"}, "only stored records go to the model"

        # the log holds exactly this call, classified from the transport; a mock reads as MOCKED, never LIVE_META
        log = [e for e in c.get("/api/evidence/model-executions").json()["executions"] if e["operation"] == "work_orders"]
        assert [e["id"] for e in log] == r["executionIds"] and r["classification"] == "MOCKED" and log[0]["inputRef"] == f"workorders:mission={mid} lang=en"

        # the same records again are replayed from the cache: no request, and the list says so
        again = orders(c, mid)
        assert len(meta.requests) == 1 and again["orders"] == r["orders"] and again["classification"] == "CACHED_MOCKED" and again["provider"] == "MUSE_SPARK"
        cached = [e for e in c.get("/api/evidence/model-executions").json()["executions"] if e["id"] in again["executionIds"]]
        assert cached and all(e["cachedFrom"] in r["executionIds"] and e["costUsd"] == 0 for e in cached)


def test_a_hindi_request_asks_for_hindi_in_a_request_of_its_own(settings, live_settings, meta):
    seeded(settings)
    with TestClient(create_app(live_settings, meta_transport=meta.transport)) as c:
        mid = c.get("/api/missions").json()[0]["id"]
        caps = {k: v["captureIds"] for k, v in tracks_of(c, mid).items()}
        meta.add("/chat/completions", live_reply(caps))
        meta.add("/chat/completions", chat_json({"orders": [row("P1", caps["loose_cable"], title="केबल को सुरक्षित करें", action="केबल को जाँचें और बाँधें।", rationale="एक बार देखा गया।")]}))
        orders(c, mid)
        hi = orders(c, mid, "hi")
        assert hi["language"] == "hi" and hi["provider"] == "MUSE_SPARK" and hi["orders"][0]["title"] == "केबल को सुरक्षित करें" and hi["orders"][0]["priority"] == "P1"
        first, second = meta.bodies("/chat/completions")
        assert second["messages"][0]["content"] == WORKORDERS_SYSTEM + "\n" + HINDI_INSTRUCTION and first["messages"][0]["content"] == WORKORDERS_SYSTEM
        assert "Hindi" in HINDI_INSTRUCTION and "ids" in HINDI_INSTRUCTION, "ids, enums and coordinates stay as given"


@pytest.mark.parametrize(
    "reply, fallback, why",
    [
        (chat_json({"orders": [row("P1", [GHOST]), row("P2", [GHOST])]}), "NO_ANSWER", "none of its 2 order(s) survived"),
        (chat_json({"orders": []}), "NO_ANSWER", "it wrote no orders"),
        (chat_json({"orders": "none"}), "NO_ANSWER", "no orders array"),
        (httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "not json"}}], "usage": {}}), "LIVE_META_FAILED", "502"),
    ],
    ids=["all-ungrounded", "empty", "not-an-array", "not-json"],
)
def test_a_reply_with_no_surviving_order_falls_back_to_the_rules_and_keeps_the_execution(settings, live_settings, meta, reply, fallback, why):
    seeded(settings)
    with TestClient(create_app(live_settings, meta_transport=meta.transport)) as c:
        mid = c.get("/api/missions").json()[0]["id"]
        meta.add("/chat/completions", reply)
        r = orders(c, mid)
        assert r["provider"] == "OFFLINE_RULES" and r["fallback"] == fallback and why in r["note"] and r["classification"] is None
        assert [o["title"] for o in r["orders"]] == ["Secure and re-route the loose cable", "Remove the foreign object"], "the fallback still writes the orders"
        assert len(r["executionIds"]) == 1, "the call that was made stays on the record"


def test_a_failed_meta_call_falls_back_and_says_so(settings, live_settings, meta):
    seeded(settings)
    with TestClient(create_app(live_settings, meta_transport=meta.transport)) as c:
        mid = c.get("/api/missions").json()[0]["id"]
        meta.add("/chat/completions", httpx.Response(400, json={"error": {"message": "bad request", "type": "invalid_request_error", "code": "bad"}}))
        r = orders(c, mid)
        assert r["provider"] == "OFFLINE_RULES" and r["fallback"] == "LIVE_META_FAILED" and "(400 bad)" in r["note"] and len(r["orders"]) == 2
        assert len(r["executionIds"]) == 1 and r["classification"] is None


def test_a_mission_without_observations_makes_no_request_and_orders_nothing(live_settings, meta):
    with TestClient(create_app(live_settings, meta_transport=meta.transport)) as c:
        mid = c.post("/api/ai/interpret?offline=true", json={"instruction": "inspect cables only"}).json()["mission"]["id"]
        r = orders(c, mid)
        assert r["orders"] == [] and r["provider"] == "OFFLINE_RULES" and r["fallback"] is None and r["note"] == NOTHING_TO_ORDER and meta.requests == []


# ---------------------------------------------------------------- the governor: lock and budget


def test_locked_orders_make_no_meta_call_and_say_locked(settings, live_settings, meta):
    seeded(settings)
    with TestClient(create_app(replace(live_settings, live_passcode=PASSCODE), meta_transport=meta.transport)) as c:
        mid = c.get("/api/missions").json()[0]["id"]
        for headers in ({}, {"X-Aqua-Passcode": "wrong"}):
            r = orders(c, mid, headers=headers)
            assert r["provider"] == "OFFLINE_RULES" and r["fallback"] == "LIVE_LOCKED" and "locked" in r["note"] and r["executionIds"] == [] and len(r["orders"]) == 2
        assert meta.requests == [], "a locked request never reaches Meta"
        caps = {k: v["captureIds"] for k, v in tracks_of(c, mid).items()}
        meta.add("/chat/completions", live_reply(caps))
        r = orders(c, mid, headers={"X-Aqua-Passcode": PASSCODE})
        assert r["provider"] == "MUSE_SPARK" and r["fallback"] is None and len(meta.requests) == 1


def test_orders_over_budget_are_refused_before_any_request_and_written_offline(settings, live_settings, meta):
    seeded(settings)
    with TestClient(create_app(replace(live_settings, meta_budget_usd=0.0001), meta_transport=meta.transport)) as c:
        mid = c.get("/api/missions").json()[0]["id"]
        r = orders(c, mid)
        assert r["provider"] == "OFFLINE_RULES" and r["fallback"] == "BUDGET_EXCEEDED" and "budget" in r["note"] and r["executionIds"] == [] and len(r["orders"]) == 2
        assert meta.requests == [] and c.get("/api/system/status").json()["credits"]["saved"]["byReason"]["budget"] == 1


def test_a_second_capture_of_the_same_object_adds_evidence_not_orders(settings):
    with TestClient(create_app(settings)) as c:
        mid = seed(c, frames=((FRAME_C, CABLE_DET),))
        assert post(c, capture_form(mid, 1, 40, detections=CABLE_DET), FRAME_C).status_code == 200
        (cable,) = orders(c, mid)["orders"]
        assert cable["id"] == "WO-01" and len(cable["evidence"]) == 2
