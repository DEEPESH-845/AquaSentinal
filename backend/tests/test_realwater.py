"""Real water camera: POST /api/ai/segment-image. Prompt and frame validation, the two-prompt cap, the no-key and locked paths (nothing is sent),
the live path over a mocked Meta transport, and the governor (cache, budget, execution log) applied to every request. No test touches the network."""

import json
from dataclasses import replace

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.main import MAX_FRAME_BYTES, create_app
from app.perception.realwater import NOTES, clean_prompts

from .conftest import sam_line, sse, synthetic_frame
from .test_governor import PASSCODE, FakeNetwork

URL = "/api/ai/segment-image"
FRAME = synthetic_frame()
CABLE = np.zeros((480, 640), bool)
CABLE[200:260, 100:260] = True
BOTTLE = np.zeros((480, 640), bool)
BOTTLE[120:200, 400:470] = True


def shoot(c: TestClient, prompts=("cable",), frame: bytes = FRAME, **kw):
    return c.post(URL, files={"frame": ("frame.jpg", frame, "image/jpeg")}, data={"prompt": list(prompts)}, **kw)


def asked(meta) -> list[str]:
    """The phrase of every SAM request that reached the transport."""
    return [b["input"][0]["content"][0]["text"] for b in meta.bodies("/responses")]


def answers(meta, **by_prompt) -> None:
    """Queue one handler per request that answers by the phrase asked, so the test does not depend on which request is served first."""
    def handler(request: httpx.Request) -> httpx.Response:
        reply = by_prompt[json.loads(request.content)["input"][0]["content"][0]["text"].replace(" ", "_")]
        return reply(request) if callable(reply) else reply

    for _ in by_prompt:
        meta.add("/responses", handler)


# ---------------------------------------------------------------- prompts


def test_prompts_are_one_or_two_trimmed_and_asked_once():
    assert clean_prompts([" cable "]) == ["cable"]
    assert clean_prompts(["cable", "plastic bottle"]) == ["cable", "plastic bottle"]
    assert clean_prompts(["Cable", "cable"]) == ["Cable"], "a repeat would be a second request for the same answer"
    for bad in ([], ["a", "b", "c"], ["cable", "cable", "rope"], [""], ["  "], ["x" * 61]):
        with pytest.raises(ValueError):
            clean_prompts(bad)


def test_the_route_refuses_bad_prompts_before_anything_is_sent(live_settings, meta):
    with TestClient(create_app(live_settings, meta_transport=meta.transport)) as c:
        assert shoot(c, ("cable", "rope", "pipe")).status_code == 422, "a third prompt is refused, not dropped"
        assert shoot(c, ("   ",)).status_code == 422
        assert shoot(c, ("x" * 61,)).status_code == 422
        assert c.post(URL, files={"frame": ("f.jpg", FRAME, "image/jpeg")}).status_code == 422, "no prompt at all"
        assert meta.requests == []


# ---------------------------------------------------------------- frames


def test_the_route_applies_the_capture_frame_checks(live_settings, meta):
    with TestClient(create_app(live_settings, meta_transport=meta.transport)) as c:
        assert shoot(c, frame=b"").status_code == 413
        assert shoot(c, frame=b"\xff" * (MAX_FRAME_BYTES + 1)).status_code == 413
        r = shoot(c, frame=b"not an image")
        assert r.status_code == 422 and "decodable" in r.json()["detail"]
        assert c.post(URL, data={"prompt": ["cable"]}).status_code == 422, "no frame"
        assert meta.requests == []


# ---------------------------------------------------------------- no key, locked


def test_without_a_key_the_shutter_answers_with_the_label_and_draws_nothing(settings):
    with TestClient(create_app(settings)) as c:
        r = shoot(c, ("cable", "rope"))
        assert r.status_code == 200
        body = r.json()
        assert body["fallback"] == "NO_KEY" and body["note"] == NOTES["NO_KEY"] and body["note"].startswith("SAM 3.1 needs the Meta key")
        assert (body["width"], body["height"]) == (640, 480), "the still frame is still measured, so the overlay can be laid out"
        assert body["provider"] == "UNAVAILABLE" and body["model"] is None and body["segments"] == []
        assert body["classification"] is None and body["executionIds"] == [] and body["requestsSent"] == 0 and body["latencyMs"] is None and body["costUsd"] == 0
        assert c.get("/api/evidence/model-executions").json()["executions"] == []


def test_locked_sends_nothing_with_or_without_a_wrong_passcode_and_opens_with_the_right_one(live_settings, meta):
    answers(meta, cable=sse(["<0f>" + sam_line(1, CABLE, 0.9)]))
    with TestClient(create_app(replace(live_settings, live_passcode=PASSCODE), meta_transport=meta.transport)) as c:
        for headers in ({}, {"X-Aqua-Passcode": "wrong"}):
            r = shoot(c, headers=headers)
            assert r.status_code == 200 and r.json()["fallback"] == "LIVE_LOCKED" and r.json()["note"] == NOTES["LIVE_LOCKED"]
            assert r.json()["segments"] == [] and r.json()["provider"] == "UNAVAILABLE"
        assert meta.requests == []
        r = shoot(c, headers={"X-Aqua-Passcode": PASSCODE})
        assert r.json()["fallback"] is None and r.json()["provider"] == "SAM_3_1" and asked(meta) == ["cable"]


# ---------------------------------------------------------------- live (mocked Meta)


def test_one_sam_request_per_prompt_returns_polygons_boxes_confidences_and_the_execution_record(live_settings, meta):
    answers(meta, cable=sse(["<0f>" + sam_line(1, CABLE, 0.91)]), plastic_bottle=sse(["<0f>" + sam_line(1, BOTTLE, None)]))
    with TestClient(create_app(live_settings, meta_transport=FakeNetwork(meta.transport))) as c:
        r = shoot(c, ("cable", "plastic bottle"))
        assert r.status_code == 200
        body = r.json()
        assert sorted(asked(meta)) == ["cable", "plastic bottle"], "exactly one request per prompt"
        for req in meta.bodies("/responses"):
            part = req["input"][0]["content"][1]
            assert part["type"] == "input_image" and part["image_url"].startswith("data:image/jpeg;base64,")
        assert body["provider"] == "SAM_3_1" and body["model"] == live_settings.sam_model and body["fallback"] is None and body["note"] == ""
        cable, bottle = body["segments"]
        assert [cable["prompt"], bottle["prompt"]] == ["cable", "plastic bottle"] and cable["status"] == bottle["status"] == "OK"
        inst = cable["instances"][0]
        assert inst["box"] == [100, 200, 260, 260] and inst["confidence"] == pytest.approx(0.91) and inst["areaPx"] == 160 * 60
        xs = [p[0] for p in inst["polygons"][0]]
        ys = [p[1] for p in inst["polygons"][0]]
        assert (min(xs), min(ys), max(xs), max(ys)) == (100, 200, 259, 259), "the contour hugs the mask, in the pixels of the frame sent"
        assert bottle["instances"][0]["confidence"] is None, "no score from the model stays null, never 0"
        # evidence: two live executions, the cost of two images, the slowest phrase's latency
        assert body["classification"] == "LIVE_META" and len(body["executionIds"]) == 2 and body["requestsSent"] == 2
        assert body["costUsd"] == pytest.approx(2 * 2.5 / 1000) and body["latencyMs"] == max(cable["latencyMs"], bottle["latencyMs"]) > 0
        log = c.get("/api/evidence/model-executions").json()
        assert sorted(e["id"] for e in log["executions"]) == sorted(body["executionIds"]) and {e["operation"] for e in log["executions"]} == {"segmentation"}
        assert all(e["inputRef"].startswith("realcam sha1=") for e in log["executions"])


def test_a_repeated_prompt_costs_one_request_and_no_match_is_empty_not_an_error(live_settings, meta):
    meta.add("/responses", sse([]))
    with TestClient(create_app(live_settings, meta_transport=meta.transport)) as c:
        body = shoot(c, ("rope", "ROPE")).json()
        assert len(meta.requests) == 1 and [s["prompt"] for s in body["segments"]] == ["rope"]
        assert body["segments"][0]["status"] == "EMPTY" and body["segments"][0]["instances"] == [] and body["provider"] == "SAM_3_1"
        assert body["classification"] == "MOCKED", "a mocked transport can never read as live"
        assert body["costUsd"] == 0


def test_one_failed_phrase_does_not_hide_the_other(live_settings, meta):
    boom = httpx.Response(400, json={"error": {"message": "image rejected", "type": "invalid_request_error"}})
    answers(meta, cable=sse(["<0f>" + sam_line(1, CABLE, 0.8)]), rope=boom)
    with TestClient(create_app(live_settings, meta_transport=meta.transport)) as c:
        body = shoot(c, ("cable", "rope")).json()
        cable, rope = body["segments"]
        assert cable["status"] == "OK" and rope["status"] == "FAILED" and "image rejected" in rope["error"] and rope["instances"] == []
        assert body["provider"] == "SAM_3_1"


def test_every_phrase_failing_is_unavailable_with_the_reason(live_settings, meta):
    meta.add("/responses", httpx.Response(401, json={"error": {"message": "nope"}}))
    with TestClient(create_app(live_settings, meta_transport=FakeNetwork(meta.transport))) as c:
        body = shoot(c).json()
        assert body["provider"] == "UNAVAILABLE" and body["fallback"] is None and "authentication failed" in body["note"] and body["classification"] is None
        assert body["requestsSent"] == 1, "a request that went out and failed was still sent"
        assert body["segments"][0]["status"] == "FAILED"


# ---------------------------------------------------------------- governor


def test_the_response_cache_serves_the_same_shutter_again_with_no_request_cost_or_latency(live_settings, meta):
    answers(meta, cable=sse(["<0f>" + sam_line(1, CABLE, 0.9)]))
    answers(meta, cable=sse([]))
    with TestClient(create_app(live_settings, meta_transport=FakeNetwork(meta.transport))) as c:
        first = shoot(c).json()
        again = shoot(c).json()
        assert len(meta.requests) == 1
        assert first["classification"] == "LIVE_META" and again["classification"] == "CACHED_LIVE"
        assert first["requestsSent"] == 1 and again["requestsSent"] == 0, "a replay is an execution record of its own, but nothing was sent to Meta"
        assert len(again["executionIds"]) == 1 and again["executionIds"] != first["executionIds"]
        assert again["segments"][0]["instances"] == first["segments"][0]["instances"]
        assert again["segments"][0]["latencyMs"] is None and again["latencyMs"] is None and again["costUsd"] == 0
        credits = c.get("/api/system/status").json()["credits"]
        assert credits["liveCalls"] == 1 and credits["cachedCalls"] == 1 and credits["saved"]["byReason"]["cache_hit"] == 1
        assert credits["spentUsd"] == pytest.approx(2.5 / 1000)
        assert shoot(c, frame=synthetic_frame(seed=7)).status_code == 200 and len(meta.requests) == 2, "another frame is another request"


def test_a_shutter_with_one_phrase_replayed_and_one_live_counts_one_request_sent_and_costs_one(live_settings, meta):
    answers(meta, cable=sse(["<0f>" + sam_line(1, CABLE, 0.9)]))
    answers(meta, rope=sse(["<0f>" + sam_line(1, BOTTLE, 0.7)]))
    with TestClient(create_app(live_settings, meta_transport=FakeNetwork(meta.transport))) as c:
        shoot(c, ("cable",))
        body = shoot(c, ("cable", "rope")).json()
        assert asked(meta) == ["cable", "rope"], "the cached phrase was not asked again"
        cable, rope = body["segments"]
        assert cable["status"] == rope["status"] == "OK" and cable["latencyMs"] is None and rope["latencyMs"] is not None
        assert len(body["executionIds"]) == 2 and body["requestsSent"] == 1
        assert body["classification"] == "LIVE_META", "the weakest provenance wins: a live request is in this shutter"
        assert body["costUsd"] == pytest.approx(2.5 / 1000), "one request's cost, not two"
        assert body["latencyMs"] == rope["latencyMs"]
        credits = c.get("/api/system/status").json()["credits"]
        assert credits["liveCalls"] == 2 and credits["cachedCalls"] == 1 and credits["spentUsd"] == pytest.approx(2 * 2.5 / 1000)


def test_the_budget_cap_refuses_both_phrases_before_any_request(live_settings, meta):
    with TestClient(create_app(replace(live_settings, meta_budget_usd=0.001), meta_transport=meta.transport)) as c:
        body = shoot(c, ("cable", "rope")).json()
        assert [s["status"] for s in body["segments"]] == ["SKIPPED_BUDGET", "SKIPPED_BUDGET"] and "budget" in body["segments"][0]["error"]
        assert body["provider"] == "UNAVAILABLE" and "budget" in body["note"] and meta.requests == [] and body["requestsSent"] == 0
        assert c.get("/api/system/status").json()["credits"]["saved"]["byReason"]["budget"] == 2
