"""Meta client error handling, Spark planning loop, SAM parsing and Voice Transcribe, all against mocked HTTP."""

import json

import httpx
import numpy as np
import pytest

from app.meta.client import MetaAPIError, MetaClient, MetaUnavailable
from app.meta.sam import Sam, parse_sam_output
from app.meta.spark import PlanningFailed, Spark
from app.meta.voice import KEYWORDS, Voice, validate_wav
from app.mission.tools import CreateMissionArgs, NoArgs, ToolRegistry

from .conftest import FAKE_KEY, chat_json, chat_tool_call, demo_wav, sam_line, sse


async def no_sleep(_: float) -> None:
    return None


def client(meta, **kw) -> MetaClient:
    return MetaClient(FAKE_KEY, transport=meta.transport, sleep=no_sleep, **kw)


@pytest.mark.anyio
async def test_invalid_key_is_reported_without_echoing_it(meta):
    meta.add("/chat/completions", httpx.Response(401, json={"error": {"message": f"bad key {FAKE_KEY}", "type": "authentication_error", "code": "invalid_api_key"}}))
    c = client(meta)
    with pytest.raises(MetaAPIError) as e:
        await c.chat({"model": "muse-spark-1.3", "messages": []})
    assert e.value.status == 401 and e.value.code == "invalid_api_key"
    assert FAKE_KEY not in str(e.value) and FAKE_KEY not in repr(c) and FAKE_KEY not in json.dumps(e.value.public())
    assert len(meta.requests) == 1, "401 is not retried"
    assert meta.requests[0].headers["authorization"] == f"Bearer {FAKE_KEY}"


@pytest.mark.anyio
async def test_rate_limit_honours_retry_after_then_succeeds(meta):
    waits = []

    async def sleep(s):
        waits.append(s)

    meta.add("/chat/completions", httpx.Response(429, headers={"retry-after": "2"}, json={"error": {"message": "slow down", "type": "rate_limit_error", "code": "rate_limit_exceeded"}}))
    meta.add("/chat/completions", chat_json({"ok": True}))
    c = MetaClient(FAKE_KEY, transport=meta.transport, sleep=sleep)
    body, _ = await c.chat({"model": "muse-spark-1.3", "messages": []})
    assert body["choices"] and waits == [2.0]
    u = c.usage.snapshot()["muse-spark-1.3"]
    assert u["retries"] == 1 and u["errors"] == 0 and u["promptTokens"] == 900 and u["estimatedCostUsd"] > 0


@pytest.mark.anyio
async def test_timeouts_and_server_errors_retry_with_backoff_then_fail(meta):
    for _ in range(4):
        meta.add("/chat/completions", httpx.ReadTimeout("slow"))
    c = client(meta, max_retries=3)
    with pytest.raises(MetaAPIError) as e:
        await c.chat({"model": "muse-spark-1.3", "messages": []})
    assert e.value.status == 504 and len(meta.requests) == 4
    meta.add("/chat/completions", httpx.Response(503, json={"error": {"message": "overloaded", "type": "server_error", "code": "service_overloaded"}}))
    meta.add("/chat/completions", chat_json({"ok": 1}))
    await c.chat({"model": "muse-spark-1.3", "messages": []})


@pytest.mark.anyio
async def test_validation_errors_are_not_retried(meta):
    meta.add("/chat/completions", httpx.Response(400, json={"error": {"message": "`top_p` must be <= 1", "type": "invalid_request_error", "param": "top_p", "code": None}}))
    with pytest.raises(MetaAPIError) as e:
        await client(meta).chat({"model": "m", "messages": []})
    assert e.value.status == 400 and "top_p" in str(e.value) and len(meta.requests) == 1


@pytest.mark.anyio
async def test_no_key_means_unavailable_and_no_request():
    c = MetaClient("")
    with pytest.raises(MetaUnavailable):
        await c.chat({"model": "m", "messages": []})
    await c.aclose()


def planning_registry(created: list):
    reg = ToolRegistry()

    async def env(_: NoArgs):
        return {"source": "SIMULATED", "visibility_estimate": 0.9}

    async def create(args: CreateMissionArgs):
        spec = args.to_spec("pipeline-00001")
        created.append(spec)
        return {"mission_id": spec.mission_id}

    reg.bind("get_environment_conditions", env)
    reg.bind("create_inspection_mission", create)
    return reg


GOOD_ARGS = {"objective": "pipeline_inspection", "targets": ["loose_cable", "foreign_object"], "scan_pattern": "left_to_right", "explanation": "Left-to-right pipeline scan."}


@pytest.mark.anyio
async def test_spark_planning_loop_reads_state_recovers_from_bad_args_and_refuses_motion(meta):
    meta.add("/chat/completions", chat_tool_call("get_environment_conditions", {}, "c1"))
    meta.add("/chat/completions", chat_tool_call("move_to_waypoint", {"x": 50, "y": 20}, "c2"))
    meta.add("/chat/completions", chat_tool_call("create_inspection_mission", {**GOOD_ARGS, "region": {"x_min": 0, "x_max": 150, "y_min": 0, "y_max": 40}}, "c3"))
    meta.add("/chat/completions", chat_tool_call("create_inspection_mission", GOOD_ARGS, "c4"))
    created: list = []
    out = await Spark(client(meta), "muse-spark-1.3").plan("inspect the pipeline", planning_registry(created))
    assert [t.name for t in out.timeline] == ["get_environment_conditions", "move_to_waypoint", "create_inspection_mission", "create_inspection_mission"]
    assert [t.ok for t in out.timeline] == [True, False, False, True]
    assert "not permitted during PLANNING" in out.timeline[1].error
    assert "x_max" in out.timeline[2].error
    assert len(created) == 1 and out.explanation == "Left-to-right pipeline scan."
    first = meta.bodies("/chat/completions")[0]
    assert first["model"] == "muse-spark-1.3" and first["tool_choice"] == "auto"
    assert {t["function"]["name"] for t in first["tools"]} == {"get_telemetry", "get_environment_conditions", "get_camera_status", "create_inspection_mission"}
    last = meta.bodies("/chat/completions")[-1]
    tool_msgs = [m for m in last["messages"] if m["role"] == "tool"]
    assert tool_msgs[1]["tool_call_id"] == "c2" and "not permitted" in tool_msgs[1]["content"]


@pytest.mark.anyio
async def test_spark_that_never_creates_a_mission_fails_cleanly(meta):
    meta.add("/chat/completions", httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "Sure! Moving the gantry now."}}]}))
    with pytest.raises(PlanningFailed) as e:
        await Spark(client(meta), "muse-spark-1.3").plan("go", planning_registry([]))
    assert "without creating a mission" in str(e.value)


@pytest.mark.anyio
async def test_spark_frame_reasoning_uses_structured_output_and_image_part(meta):
    meta.add("/chat/completions", chat_json({"scene_summary": "a pipe and a cable", "phrases": [{"phrase": "cable", "target_class": "loose_cable", "rationale": "visible"}]}))
    data, _ = await Spark(client(meta), "muse-spark-1.3").analyze_frame(b"\xff\xd8jpeg", ["loose_cable"])
    assert data["phrases"][0]["phrase"] == "cable"
    body = meta.bodies("/chat/completions")[0]
    assert body["response_format"]["type"] == "json_schema"
    parts = body["messages"][1]["content"]
    assert parts[1]["type"] == "image_url" and parts[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")


@pytest.mark.anyio
async def test_spark_non_json_structured_output_is_an_error(meta):
    meta.add("/chat/completions", httpx.Response(200, json={"choices": [{"message": {"content": "not json"}}]}))
    with pytest.raises(MetaAPIError):
        await Spark(client(meta), "m").analyze_frame(b"x", ["debris"])


def test_sam_output_parsing_reconstructs_full_frame_masks():
    m = np.zeros((480, 640), bool)
    m[100:140, 200:300] = True
    m2 = np.zeros((480, 640), bool)
    m2[300:310, 50:60] = True
    text = "<0f>" + sam_line(0, m, 0.93) + "," + sam_line(4, m2, None)
    out = parse_sam_output(text, 640, 480)
    assert [i.object_id for i in out] == ["0", "4"]
    assert out[0].box == (200, 100, 300, 140) and out[0].confidence == pytest.approx(0.93)
    assert np.array_equal(out[0].mask, m) and np.array_equal(out[1].mask, m2)
    assert out[1].confidence is None, "absent c is None, never zero"
    assert parse_sam_output("", 640, 480) == []


@pytest.mark.anyio
async def test_sam_request_shape_and_stream(meta):
    m = np.zeros((480, 640), bool)
    m[10:20, 10:30] = True
    meta.add("/responses", sse(["<0f>" + sam_line(1, m, 0.8)]))
    sam = Sam(client(meta), "sam-3.1")
    inst, latency = await sam.segment(b"\xff\xd8jpeg", "cable", 640, 480)
    assert len(inst) == 1 and inst[0].mask.sum() == 200 and latency >= 0
    body = meta.bodies("/responses")[0]
    assert body["model"] == "sam-3.1" and body["stream"] is True
    assert body["metadata"] == {"mask_encoding": "one_bit", "include_confidence": "true"}
    content = body["input"][0]["content"]
    assert content[0] == {"type": "input_text", "text": "cable"} and content[1]["type"] == "input_image"
    assert sam.client.usage.snapshot()["sam-3.1"]["images"] == 1


@pytest.mark.anyio
async def test_sam_stream_failure_and_zero_matches(meta):
    meta.add("/responses", httpx.Response(200, content=b'data: {"type":"response.failed","response":{"error":{"message":"boom","type":"server_error"}}}\n\n', headers={"content-type": "text/event-stream"}))
    meta.add("/responses", sse([]))
    sam = Sam(client(meta), "sam-3.1")
    with pytest.raises(MetaAPIError):
        await sam.segment(b"x", "cable", 640, 480)
    inst, _ = await sam.segment(b"x", "submarine", 640, 480)
    assert inst == []


def test_wav_validation():
    assert validate_wav(demo_wav(1.0)) == pytest.approx(1.0)
    with pytest.raises(MetaAPIError):
        validate_wav(b"RIFFnope")
    with pytest.raises(MetaAPIError, match="16 or 24 kHz"):
        validate_wav(demo_wav(1.0, rate=44100))


@pytest.mark.anyio
async def test_voice_multipart_request(meta):
    meta.add("/asr/transcribe", httpx.Response(200, json={"sessionId": "s1", "transcript": "inspect the pipeline", "audioDurationMs": 1000, "turns": []}))
    body, _ = await Voice(client(meta), "muse-voice-transcribe-1.0").transcribe(demo_wav())
    assert body["transcript"] == "inspect the pipeline"
    raw = meta.requests[0].content.decode("latin-1")
    assert 'name="request"' in raw and 'name="audio"' in raw and "audio/wav" in raw
    request_json = json.loads(raw.split('name="request"')[1].split("\r\n\r\n", 1)[1].split("\r\n--", 1)[0])
    assert request_json["model"] == "muse-voice-transcribe-1.0" and request_json["audioEncoding"] == "WAV" and request_json["mode"] == "PUSH_TO_TALK"
    assert request_json["keywords"] == KEYWORDS and "turbidity" in KEYWORDS
