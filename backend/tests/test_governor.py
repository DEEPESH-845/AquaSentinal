"""Credit governor and live lock: budget cap, response cache, cascade gate, saved-calls counter, passcode, status shape.

No test touches the network. A `FakeNetwork` transport is not an httpx.MockTransport, so the client classifies its calls
LIVE_META (the classification is decided by transport type); it answers from a MetaMock exactly like the other tests.
"""

import asyncio
import json
from dataclasses import replace

import httpx
import pytest
from fastapi.testclient import TestClient

import app.meta.governor as governor_module
from app.db import Repository
from app.main import create_app
from app.meta.client import MetaBudgetExceeded, MetaClient
from app.meta.governor import SAVED_REASONS, AttemptLimiter, Governor, cache_key
from app.meta.sam import Sam

from .conftest import FAKE_KEY, chat_json, demo_wav, sse, synthetic_frame

PASSCODE = "open-sesame-7"
CHAT = {"model": "muse-spark-1.3", "messages": [{"role": "user", "content": "hello"}], "max_tokens": 50}


class FakeNetwork(httpx.AsyncBaseTransport):
    """Answers from a mock, but is not a MockTransport, so executions classify as LIVE_META."""

    def __init__(self, inner: httpx.MockTransport):
        self.inner = inner

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        return await self.inner.handle_async_request(request)


async def no_sleep(_: float) -> None:
    return None


@pytest.fixture
def repo(tmp_path):
    r = Repository(str(tmp_path / "gov.db"), tmp_path / "data")
    yield r
    r.close()


def governed(repo, transport, budget=1.0, **kw) -> tuple[MetaClient, Governor]:
    gov = Governor(repo, budget, **kw)
    return MetaClient(FAKE_KEY, transport=transport, sleep=no_sleep, max_retries=0, on_execution=repo.save_execution, governor=gov), gov


def seed_live_spend(repo, usd: float) -> None:
    repo.save_execution({"id": "exe_seed", "model": "m", "classification": "LIVE_META", "costUsd": usd, "success": True})


# ---------------------------------------------------------------- budget


@pytest.mark.anyio
async def test_budget_refuses_before_any_transport_call(repo, meta):
    client, gov = governed(repo, meta.transport, budget=0.001)  # one SAM image is estimated at $0.0025
    with pytest.raises(MetaBudgetExceeded) as e:
        await Sam(client, "sam-3.1").segment(b"jpeg", "cable", 640, 480)
    assert e.value.status == 402 and e.value.code == "budget_exceeded"
    assert meta.requests == [], "refused before the transport was touched"
    assert repo.executions() == [], "a refusal is not an execution"
    assert gov.credits()["saved"]["byReason"]["budget"] == 1
    await client.aclose()


@pytest.mark.anyio
async def test_budget_counts_only_live_meta_spend_and_survives_a_restart(repo, tmp_path, meta):
    seed_live_spend(repo, 0.99)
    client, gov = governed(repo, meta.transport, budget=1.0)
    meta.add("/chat/completions", chat_json({"ok": 1}))
    with pytest.raises(MetaBudgetExceeded):  # no output cap: worst case 4096 completion tokens, about $0.017
        await client.chat({"model": "muse-spark-1.3", "messages": [{"role": "user", "content": "hi"}]})
    assert meta.requests == []
    await client.chat(CHAT)  # an output cap of 50 tokens fits in the remaining cent
    assert len(meta.requests) == 1
    [mocked] = [x for x in repo.executions() if x["classification"] == "MOCKED"]
    assert mocked["costUsd"] > 0
    assert repo.spent_usd() == pytest.approx(0.99), "mocked requests cost nothing"
    # a new process on the same database sees the same spend
    reopened = Repository(str(tmp_path / "gov.db"), tmp_path / "data2")
    try:
        assert Governor(reopened, 1.0).credits()["spentUsd"] == pytest.approx(0.99)
    finally:
        reopened.close()
    await client.aclose()


@pytest.mark.anyio
async def test_concurrent_requests_cannot_overshoot_the_budget_together(repo):
    async def slow(_: httpx.Request) -> httpx.Response:
        await asyncio.sleep(0.05)
        return sse([])

    client, gov = governed(repo, httpx.MockTransport(slow), budget=0.003)  # room for one $0.0025 request, not two
    sam = Sam(client, "sam-3.1")
    results = await asyncio.gather(sam.segment(b"frame-a", "cable", 640, 480), sam.segment(b"frame-b", "cable", 640, 480), return_exceptions=True)
    assert sum(isinstance(r, MetaBudgetExceeded) for r in results) == 1 and sum(isinstance(r, tuple) for r in results) == 1
    assert gov._reserved == 0, "the reservation is released when the request ends"
    await client.aclose()


@pytest.mark.anyio
async def test_live_requests_record_their_cost_and_are_summed(repo, meta):
    meta.add("/responses", sse([]))
    client, gov = governed(repo, FakeNetwork(meta.transport))
    await Sam(client, "sam-3.1").segment(b"frame", "cable", 640, 480)
    [rec] = repo.executions()
    assert rec["classification"] == "LIVE_META" and rec["costUsd"] == pytest.approx(0.0025)
    c = gov.credits()
    assert c["spentUsd"] == pytest.approx(0.0025) and c["remainingUsd"] == pytest.approx(0.9975) and c["liveCalls"] == 1
    await client.aclose()


# ---------------------------------------------------------------- cache


@pytest.mark.anyio
async def test_cache_hit_replays_identical_payload_as_cached_live_with_no_transport_call(repo, meta):
    meta.add("/chat/completions", chat_json({"answer": 42}))
    client, gov = governed(repo, FakeNetwork(meta.transport))
    first, _ = await client.chat(CHAT, op="ask")
    second, latency = await client.chat(CHAT, op="ask")
    assert second == first and latency == 0.0
    assert len(meta.requests) == 1, "the second call never reached the transport"
    [original] = [x for x in repo.executions() if x["classification"] == "LIVE_META"]
    [hit] = [x for x in repo.executions() if x["classification"] == "CACHED_LIVE"]
    assert hit["costUsd"] == 0 and hit["cachedFrom"] == original["id"] and hit["success"] and hit["operation"] == "ask"
    assert hit["traceId"] == original["traceId"] and hit["outputRef"] == original["outputRef"]
    c = gov.credits()
    assert c["liveCalls"] == 1 and c["cachedCalls"] == 1 and c["saved"]["byReason"]["cache_hit"] == 1
    assert c["spentUsd"] == pytest.approx(original["costUsd"]), "a cache hit costs nothing"
    await client.aclose()


@pytest.mark.anyio
async def test_cache_hit_of_a_mocked_execution_is_cached_mocked_never_cached_live(repo, meta):
    meta.add("/chat/completions", chat_json({"answer": 1}))
    client, _ = governed(repo, meta.transport)
    await client.chat(CHAT)
    await client.chat(CHAT)
    assert sorted(x["classification"] for x in repo.executions()) == ["CACHED_MOCKED", "MOCKED"]
    await client.aclose()


@pytest.mark.anyio
async def test_cache_covers_streaming_and_multipart_and_does_not_inflate_usage(repo, meta):
    meta.add("/responses", sse([]))
    meta.add("/asr/transcribe", httpx.Response(200, json={"sessionId": "s1", "transcript": "scan the pipe", "audioDurationMs": 1000, "turns": []}))
    client, gov = governed(repo, meta.transport)
    sam = Sam(client, "sam-3.1")
    for _ in range(2):
        await sam.segment(b"frame", "cable", 640, 480)
    from app.meta.voice import Voice

    voice = Voice(client, "muse-voice-transcribe-1.0")
    a, _ = await voice.transcribe(demo_wav())
    b, _ = await voice.transcribe(demo_wav())
    assert a == b and len(meta.requests) == 2
    assert gov.credits()["cachedCalls"] == 2
    usage = client.usage.snapshot()
    assert usage["sam-3.1"]["images"] == 1 and usage["muse-voice-transcribe-1.0"]["audioMs"] == 1000, "a replayed answer is not new usage"
    await client.aclose()


def test_cache_key_changes_with_image_bytes_model_and_endpoint_but_not_with_key_order():
    def sam_payload(jpeg: bytes, model="sam-3.1") -> dict:
        import base64

        url = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()
        return {"model": model, "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "cable"}, {"type": "input_image", "image_url": url}]}]}

    a, b = sam_payload(b"\xff\xd8 frame A"), sam_payload(b"\xff\xd8 frame B")
    assert cache_key("responses", "sam-3.1", a) == cache_key("responses", "sam-3.1", sam_payload(b"\xff\xd8 frame A"))
    assert cache_key("responses", "sam-3.1", a) != cache_key("responses", "sam-3.1", b), "different image bytes, different key"
    assert cache_key("responses", "sam-3.1", a) != cache_key("responses", "sam-3.2", a)
    assert cache_key("responses", "sam-3.1", a) != cache_key("chat", "sam-3.1", a)
    assert cache_key("chat", "m", {"a": 1, "b": 2}) == cache_key("chat", "m", {"b": 2, "a": 1})
    files = lambda wav: {"request": (None, "{}", "application/json"), "audio": ("c.wav", wav, "audio/wav")}  # noqa: E731
    assert cache_key("multipart", "v", {"path": "/asr/transcribe", "files": files(b"RIFF1")}) != cache_key("multipart", "v", {"path": "/asr/transcribe", "files": files(b"RIFF2")})


@pytest.mark.anyio
async def test_only_successful_complete_responses_are_cached(repo, meta):
    meta.add("/chat/completions", httpx.Response(400, json={"error": {"message": "bad", "type": "invalid_request_error"}}))
    meta.add("/chat/completions", chat_json({"ok": 1}))
    meta.add("/responses", sse([], completed=False))  # a stream that never completed is partial
    meta.add("/responses", sse([]))
    client, _ = governed(repo, meta.transport)
    with pytest.raises(Exception):  # noqa: B017
        await client.chat(CHAT)
    await client.chat(CHAT)  # the failure was not remembered: this one goes out
    await client.chat(CHAT)  # and this one is the hit
    sam = Sam(client, "sam-3.1")
    await sam.segment(b"frame", "cable", 640, 480)
    await sam.segment(b"frame", "cable", 640, 480)  # the incomplete answer was not remembered either
    await sam.segment(b"frame", "cable", 640, 480)  # the complete one was
    assert len(meta.requests) == 4
    assert [x["classification"] for x in repo.executions(limit=1)] == ["CACHED_MOCKED"]
    await client.aclose()


@pytest.mark.anyio
async def test_a_client_without_a_key_serves_nothing_even_from_the_cache(repo):
    gov = Governor(repo, 1.0)
    repo.cache_put("k", "m", "exe_x", {"cached": True})
    client = MetaClient("", governor=gov, on_execution=repo.save_execution)
    from app.meta.client import MetaUnavailable

    with pytest.raises(MetaUnavailable):
        await client.chat(CHAT)
    await client.aclose()


# ---------------------------------------------------------------- cascade gate (through the real API)


def capture_form(mission_id: str, seq: int, x: float, *, reason="SCAN", detections=None, prompts=("cable",)) -> str:
    return json.dumps(
        {
            "missionId": mission_id, "seq": seq, "reason": reason, "waypointIndex": seq, "time": float(seq), "gantryX": x, "gantryY": 20.0, "visibility": 0.9,
            "turbidity": 0.15, "lighting": 0.8, "perception": "NORMAL_VISIBILITY", "cameraOnline": True, "targets": ["loose_cable"], "prompts": list(prompts),
            "detections": detections or [],
        }
    )


CABLE_DET = [{"objectId": "cable-1", "trueType": "LOOSE_CABLE", "class": "LOOSE_CABLE", "confidence": 0.5, "bbox": [0.15, 0.4, 0.25, 0.12], "estX": 20.0, "estY": 22.0}]
FRAME_A = synthetic_frame(rects=[(100, 200, 260, 260)])
FRAME_B = synthetic_frame(rects=[(300, 50, 600, 400)])
FRAME_C = synthetic_frame(rects=[(20, 20, 200, 120), (400, 300, 620, 460)])
MURKY = synthetic_frame(contrast=0.2)


def post(c: TestClient, body: str, jpeg: bytes, **kw):
    return c.post("/api/inspection/capture", data={"meta": body}, files={"frame": ("f.jpg", jpeg, "image/jpeg")}, **kw)


def test_cascade_skips_duplicates_unusable_frames_and_non_candidates_and_counts_the_reasons(live_settings, meta):
    for _ in range(3):
        meta.add("/responses", sse([]))
    with TestClient(create_app(live_settings, meta_transport=meta.transport)) as c:
        mid = c.post("/api/ai/interpret?offline=true", json={"instruction": "inspect cables only"}).json()["mission"]["id"]
        c.post(f"/api/missions/{mid}/start", json={"executor": "TWIN"})

        r1 = post(c, capture_form(mid, 0, 26), FRAME_A).json()
        assert r1["segmentations"][0]["provider"] == "SAM_3_1" and len(meta.requests) == 1

        r2 = post(c, capture_form(mid, 1, 26), FRAME_A).json()  # the same view asked the same question
        assert r2["duplicateOf"] == r1["captureId"] and r2["segmentations"][0]["status"] == "REUSED" and len(meta.requests) == 1

        r3 = post(c, capture_form(mid, 2, 30), MURKY).json()  # unusable quality: no model request, frame and quality still stored
        assert r3["quality"]["band"] == "UNRELIABLE" and r3["segmentations"] == [] and r3["reasoning"] is None
        assert any("quality is unusable" in n for n in r3["notes"]) and len(meta.requests) == 1

        r4 = post(c, capture_form(mid, 3, 40, reason="REOBSERVE"), FRAME_B).json()  # a re-observation needs a candidate in view
        assert r4["segmentations"] == [] and any("no candidate" in n for n in r4["notes"]) and len(meta.requests) == 1

        r5 = post(c, capture_form(mid, 4, 50, reason="MANUAL"), MURKY).json()  # an explicit operator capture always goes through
        assert r5["segmentations"][0]["provider"] == "SAM_3_1" and len(meta.requests) == 2

        r6 = post(c, capture_form(mid, 5, 60, reason="REOBSERVE", detections=CABLE_DET), FRAME_C).json()
        assert r6["segmentations"][0]["provider"] == "SAM_3_1" and len(meta.requests) == 3

        r7 = post(c, capture_form(mid, 6, 70), FRAME_A).json()  # same frame and prompt as r1 from elsewhere: the cache answers
        assert r7["segmentations"][0]["status"] == "EMPTY" and len(meta.requests) == 3, "served from the response cache"

        credits = c.get("/api/system/status").json()["credits"]
        assert credits["saved"] == {"total": 4, "byReason": {"duplicate": 1, "unusable_quality": 1, "not_candidate": 1, "cache_hit": 1, "budget": 0}}
        assert credits["cachedCalls"] == 1 and credits["liveCalls"] == 0
        assert c.get("/api/evidence/model-executions").json()["counts"] == {"MOCKED": 3, "CACHED_MOCKED": 1}


def test_a_request_over_budget_is_skipped_not_failed_and_counted(live_settings, meta):
    with TestClient(create_app(replace(live_settings, meta_budget_usd=0.001), meta_transport=meta.transport)) as c:
        mid = c.post("/api/ai/interpret?offline=true", json={"instruction": "inspect cables only"}).json()["mission"]["id"]
        seg = post(c, capture_form(mid, 0, 26), FRAME_A).json()["segmentations"][0]
        assert seg["status"] == "SKIPPED_BUDGET" and "budget" in seg["error"]
        assert meta.requests == []
        r = c.post("/api/ai/interpret", json={"instruction": "inspect the pipeline"})  # planning has no output cap: worst case is over this budget too
        assert r.status_code == 402 and meta.requests == []
        assert c.get("/api/system/status").json()["credits"]["saved"]["byReason"]["budget"] == 2


# ---------------------------------------------------------------- status, spend and cache through the API


def test_status_shape_spend_and_a_cache_that_survives_a_restart(live_settings, meta):
    meta.add("/asr/transcribe", httpx.Response(200, json={"sessionId": "s1", "transcript": "scan the pipe", "audioDurationMs": 4200, "turns": []}))
    wav = {"audio": ("cmd.wav", demo_wav(1.5), "audio/wav")}
    with TestClient(create_app(live_settings, meta_transport=FakeNetwork(meta.transport))) as c:
        before = c.get("/api/system/status").json()
        assert set(before["credits"]) == {"budgetUsd", "spentUsd", "remainingUsd", "liveCalls", "cachedCalls", "saved"}
        assert set(before["credits"]["saved"]) == {"total", "byReason"} and set(before["credits"]["saved"]["byReason"]) == set(SAVED_REASONS)
        assert before["credits"]["budgetUsd"] == 1.0 and before["credits"]["spentUsd"] == 0 and before["live"] == {"lockEnabled": False, "unlocked": True}
        first = c.post("/api/voice/transcribe", files=wav).json()
        again = c.post("/api/voice/transcribe", files=wav).json()
        assert again["transcript"] == first["transcript"] == "scan the pipe" and len(meta.requests) == 1
        after = c.get("/api/system/status").json()["credits"]
        assert after["liveCalls"] == 1 and after["cachedCalls"] == 1 and after["saved"]["byReason"]["cache_hit"] == 1
        assert after["spentUsd"] == pytest.approx(4.2 / 3600 * 0.18, abs=1e-6) and after["remainingUsd"] == pytest.approx(1.0 - after["spentUsd"], abs=1e-6)
        log = c.get("/api/evidence/model-executions").json()
        by_class = {e["classification"]: e for e in log["executions"]}
        assert by_class["CACHED_LIVE"]["cachedFrom"] == by_class["LIVE_META"]["id"] and by_class["CACHED_LIVE"]["costUsd"] == 0
    # restart on the same database: the stored answer is served without a request and the spend is still counted
    with TestClient(create_app(live_settings, meta_transport=FakeNetwork(meta.transport))) as c:
        assert c.post("/api/voice/transcribe", files=wav).json()["transcript"] == "scan the pipe"
        assert len(meta.requests) == 1
        restarted = c.get("/api/system/status").json()["credits"]
        assert restarted["spentUsd"] == after["spentUsd"] and restarted["liveCalls"] == 1 and restarted["cachedCalls"] == 2
        assert c.get("/api/evidence/model-executions").json()["counts"] == {"LIVE_META": 1, "CACHED_LIVE": 2}


# ---------------------------------------------------------------- live lock


@pytest.fixture
def locked(live_settings):
    return replace(live_settings, live_passcode=PASSCODE)


def test_meta_routes_need_the_passcode_when_one_is_set(locked, meta):
    meta.add("/asr/transcribe", httpx.Response(200, json={"sessionId": "s1", "transcript": "scan", "audioDurationMs": 1000, "turns": []}))
    wav = {"audio": ("cmd.wav", demo_wav(), "audio/wav")}
    with TestClient(create_app(locked, meta_transport=meta.transport)) as c:
        for headers in ({}, {"X-Aqua-Passcode": "wrong"}):
            r = c.post("/api/voice/transcribe", files=wav, headers=headers)
            assert r.status_code == 403 and r.json() == {"error": "live mode locked"}
        assert meta.requests == []
        ok = {"X-Aqua-Passcode": PASSCODE}
        assert c.post("/api/voice/transcribe", files=wav, headers=ok).status_code == 200 and len(meta.requests) == 1

        # status reports the lock per request; providers read LIVE_LOCKED instead of LIVE
        locked_status = c.get("/api/system/status").json()
        assert locked_status["live"] == {"lockEnabled": True, "unlocked": False}
        assert all(p["status"] == "LIVE_LOCKED" and p["fallback"] for p in locked_status["providers"].values())
        open_status = c.get("/api/system/status", headers=ok).json()
        assert open_status["live"] == {"lockEnabled": True, "unlocked": True} and all(p["status"] == "LIVE" for p in open_status["providers"].values())

        # planning without the passcode takes the labelled offline path and sends nothing
        r = c.post("/api/ai/interpret", json={"instruction": "inspect the pipeline for cables"}).json()
        assert r["provider"] == "OFFLINE_RULE_PARSER" and any("live mode is locked" in w for w in r["mission"]["warnings"]) and len(meta.requests) == 1
        mid = r["mission"]["id"]
        seg = post(c, capture_form(mid, 0, 26), FRAME_A).json()
        assert seg["reasoning"]["provider"] == "UNAVAILABLE" and seg["reasoning"]["error"] == "live mode locked"
        assert seg["segmentations"][0]["provider"] == "OFFLINE_FIXTURE" and len(meta.requests) == 1
        assert c.post("/api/ai/segment", json={"captureId": seg["captureId"], "prompt": "cable"}).status_code == 403


def test_unlock_endpoint_checks_the_passcode_and_limits_attempts(locked):
    with TestClient(create_app(locked)) as c:
        assert c.post("/api/system/unlock", json={"passcode": PASSCODE}).json() == {"unlocked": True}
        assert c.post("/api/system/unlock", json={"passcode": "nope"}).json() == {"unlocked": False}
        for _ in range(8):
            assert c.post("/api/system/unlock", json={"passcode": "nope"}).status_code == 200
        r = c.post("/api/system/unlock", json={"passcode": PASSCODE})  # the 11th attempt in the minute, even a right one
        assert r.status_code == 429 and r.json()["unlocked"] is False and r.headers["retry-after"] == "60"


def test_wrong_headers_on_any_route_spend_the_same_attempt_budget(locked):
    with TestClient(create_app(locked)) as c:
        for i in range(10):
            assert c.get("/api/system/status", headers={"X-Aqua-Passcode": f"guess-{i}"}).json()["live"]["unlocked"] is False
        assert c.get("/api/system/status", headers={"X-Aqua-Passcode": PASSCODE}).json()["live"]["unlocked"] is False, "guessing is throttled across routes"
        assert c.post("/api/system/unlock", json={"passcode": PASSCODE}).status_code == 429


def test_without_a_passcode_nothing_is_locked(live_settings):
    with TestClient(create_app(live_settings)) as c:
        assert c.get("/api/system/status").json()["live"] == {"lockEnabled": False, "unlocked": True}
        assert c.post("/api/system/unlock", json={"passcode": ""}).json() == {"unlocked": True}


def test_attempt_limiter_window_slides():
    now = [0.0]
    lim = AttemptLimiter(limit=3, window_s=60.0, clock=lambda: now[0])
    assert [lim.hit("ip") for _ in range(4)] == [True, True, True, False] and lim.blocked("ip") and not lim.blocked("other")
    now[0] = 61.0
    assert not lim.blocked("ip") and lim.hit("ip")


def test_passcode_comparison_is_constant_time(repo, monkeypatch):
    calls: list[tuple] = []
    real = governor_module.hmac.compare_digest
    monkeypatch.setattr(governor_module.hmac, "compare_digest", lambda a, b: calls.append((a, b)) or real(a, b))
    gov = Governor(repo, 1.0, PASSCODE)
    assert gov.access(PASSCODE, "ip") is True and gov.access("wrong-and-much-longer-than-the-real-one", "ip") is False
    assert len(calls) == 2, "every guess goes through hmac.compare_digest"
    assert all(len(a) == len(b) == 32 for a, b in calls), "compared as fixed-length digests, so length does not leak"
    assert gov.access(None, "ip") is False and gov.access("", "ip") is False and len(calls) == 2


# ---------------------------------------------------------------- secrets


def test_neither_the_passcode_nor_the_key_appears_in_public_config_reprs_or_status(locked, repo, meta):
    pub = locked.public()
    assert pub["budgetUsd"] == 1.0 and pub["liveLockEnabled"] is True
    gov = Governor(repo, 1.0, PASSCODE)
    for blob in (json.dumps(pub), repr(locked), repr(gov), str(gov), repr(MetaClient(FAKE_KEY, governor=gov))):
        assert PASSCODE not in blob and FAKE_KEY not in blob
    assert PASSCODE not in json.dumps(vars(gov), default=str), "only a digest is held"
    with TestClient(create_app(locked, meta_transport=meta.transport)) as c:
        for path in ("/api/system/status", "/api/system/config", "/api/evidence/model-executions", "/api/system/preflight"):
            body = c.get(path, headers={"X-Aqua-Passcode": PASSCODE}).text
            assert PASSCODE not in body and FAKE_KEY not in body, path
        assert PASSCODE not in c.post("/api/system/unlock", json={"passcode": PASSCODE}).text
