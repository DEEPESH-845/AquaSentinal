"""Operator language (en or hi): Voice Transcribe language bias, the Hindi instruction in Muse Spark prompts, the language stored
with a mission, and offline paths that stay English. Every Meta call is a mocked httpx transport; no test touches the network."""

import json
import time

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.main import create_app
from app.meta.client import MetaClient
from app.meta.spark import HINDI_INSTRUCTION, PLANNER_SYSTEM, SUMMARY_SYSTEM, Spark, with_language
from app.meta.voice import KEYWORDS, Voice
from app.schemas import InterpretRequest

from .conftest import DEMO_INSTRUCTION, FAKE_KEY, chat_json, chat_tool_call, demo_wav
from .test_meta import GOOD_ARGS, planning_registry

SUMMARY = {"summary": "सारांश", "key_findings": [], "limitations": [], "recommended_followups": []}
RESULT = {
    "missionId": "x", "adaptive": True, "outcome": "COMPLETED", "waypointsVisited": 6, "waypointsPlanned": 6, "captures": 0, "unreliableCaptures": 0,
    "reobservations": 0, "pauses": 0, "confirmedTargets": 0, "falsePositives": 0, "avgConfidence": 0, "coverage": 1.0, "minVisibility": 0.9, "durationS": 20,
}


def transcribe_request(req: httpx.Request) -> dict:
    """The JSON `request` part of a Voice Transcribe multipart body."""
    raw = req.content.decode("latin-1")
    return json.loads(raw.split('name="request"')[1].split("\r\n\r\n", 1)[1].split("\r\n--", 1)[0])


def system_prompt(body: dict) -> str:
    return next(m["content"] for m in body["messages"] if m["role"] == "system")


def raw_client(meta) -> MetaClient:
    async def no_sleep(_: float) -> None:
        return None

    return MetaClient(FAKE_KEY, transport=meta.transport, sleep=no_sleep)


def wait_for_summary(c: TestClient, mid: str, provider: str) -> dict:
    deadline = time.time() + 5
    while time.time() < deadline and c.get(f"/api/inspection/{mid}/report").json()["summary"]["provider"] != provider:
        time.sleep(0.1)
    return c.get(f"/api/inspection/{mid}/report").json()


# ---------------------------------------------------------------- voice


@pytest.mark.anyio
async def test_voice_language_bias_follows_the_language_and_keywords_do_not_change(meta):
    for _ in range(3):
        meta.add("/asr/transcribe", httpx.Response(200, json={"sessionId": "s", "transcript": "x", "audioDurationMs": 1000}))
    voice = Voice(raw_client(meta), "muse-voice-transcribe-1.0")
    await voice.transcribe(demo_wav())  # no language given: the default is English
    await voice.transcribe(demo_wav(), language="en")
    await voice.transcribe(demo_wav(), language="hi")
    sent = [transcribe_request(r) for r in meta.requests]
    assert [s["languageBias"] for s in sent] == [["English"], ["English"], ["Hindi", "English"]]
    assert all(s["keywords"] == KEYWORDS and s["mode"] == "PUSH_TO_TALK" for s in sent)


def test_transcribe_route_forwards_the_language_and_a_changed_language_is_a_new_request(live_settings, meta):
    for _ in range(2):
        meta.add("/asr/transcribe", httpx.Response(200, json={"sessionId": "s", "transcript": "पाइपलाइन का निरीक्षण करो", "audioDurationMs": 1000}))
    audio = {"audio": ("cmd.wav", demo_wav(), "audio/wav")}
    with TestClient(create_app(live_settings, meta_transport=meta.transport)) as c:
        assert c.post("/api/voice/transcribe", files=audio, data={"language": "hi"}).json()["transcript"] == "पाइपलाइन का निरीक्षण करो"
        assert c.post("/api/voice/transcribe", files=audio).status_code == 200  # no field: English, so not the Hindi answer from the cache
        assert c.post("/api/voice/transcribe", files=audio, data={"language": "hi"}).status_code == 200  # the first request again: served from the cache
        assert [transcribe_request(r)["languageBias"] for r in meta.requests] == [["Hindi", "English"], ["English"]]
        refs = [e["inputRef"] for e in c.get("/api/evidence/model-executions").json()["executions"]]
        assert sum(r.endswith("lang=hi") for r in refs) == 2 and sum(r.endswith("lang=en") for r in refs) == 1, "the log says which language each call used"
        before = len(meta.requests)
        assert c.post("/api/voice/transcribe", files=audio, data={"language": "fr"}).status_code == 422
        assert len(meta.requests) == before, "an unsupported language is refused before any Meta call"


# ---------------------------------------------------------------- planning and summaries


def test_with_language_adds_the_hindi_instruction_only_for_hindi():
    assert with_language(SUMMARY_SYSTEM, "en") == SUMMARY_SYSTEM
    hi = with_language(SUMMARY_SYSTEM, "hi")
    assert hi.startswith(SUMMARY_SYSTEM) and hi.endswith(HINDI_INSTRUCTION)
    assert "Devanagari" in HINDI_INSTRUCTION and "English" in HINDI_INSTRUCTION, "the instruction keeps enums, ids and coordinates in English"


@pytest.mark.anyio
async def test_planner_accepts_hindi_and_hinglish_and_writes_the_explanation_in_hindi(meta):
    meta.add("/chat/completions", chat_tool_call("create_inspection_mission", GOOD_ARGS))
    meta.add("/chat/completions", chat_tool_call("create_inspection_mission", GOOD_ARGS))
    spark = Spark(raw_client(meta), "muse-spark-1.3")
    await spark.plan("pipeline ko left se right scan karo", planning_registry([]), language="hi")
    await spark.plan("inspect the pipeline", planning_registry([]))
    hi, en = meta.bodies("/chat/completions")
    for body in (hi, en):
        assert "Hinglish" in system_prompt(body) and "Devanagari" in system_prompt(body), "any operator may type Hindi or Hinglish"
        assert "stays in English" in system_prompt(body), "tool arguments stay English enums"
    assert system_prompt(hi) == with_language(PLANNER_SYSTEM, "hi") and HINDI_INSTRUCTION in system_prompt(hi)
    assert system_prompt(en) == PLANNER_SYSTEM and HINDI_INSTRUCTION not in system_prompt(en)
    assert hi["tools"] == en["tools"], "the tool schema, with its English enums, does not depend on the language"
    assert hi["messages"][1] == {"role": "user", "content": "pipeline ko left se right scan karo"}, "the instruction goes through untouched"


def test_language_is_validated_on_the_request_and_defaults_to_english():
    assert InterpretRequest(instruction="inspect the pipeline").language == "en"
    assert InterpretRequest(instruction="inspect the pipeline", language="hi").language == "hi"
    with pytest.raises(ValidationError):
        InterpretRequest(instruction="inspect the pipeline", language="fr")


def test_hindi_mission_is_planned_in_hindi_and_its_summary_is_written_in_hindi(live_settings, meta):
    meta.add("/chat/completions", chat_tool_call("create_inspection_mission", {**GOOD_ARGS, "explanation": "पाइपलाइन को बाएँ से दाएँ स्कैन किया जाएगा।"}))
    meta.add("/chat/completions", chat_json(SUMMARY))  # written when the twin completes the mission
    meta.add("/chat/completions", chat_json({**SUMMARY, "summary": "summary"}))  # regenerate with an explicit English override
    with TestClient(create_app(live_settings, meta_transport=meta.transport)) as c:
        r = c.post("/api/ai/interpret", json={"instruction": "पाइपलाइन का निरीक्षण करो", "language": "hi"}).json()
        m = r["mission"]
        assert r["provider"] == "MUSE_SPARK" and m["language"] == "hi" and m["explanation"] == "पाइपलाइन को बाएँ से दाएँ स्कैन किया जाएगा।"
        assert m["spec"]["targets"] == ["loose_cable", "foreign_object"], "tool arguments are the English enums"
        assert c.get(f"/api/missions/{m['id']}").json()["language"] == "hi"
        assert system_prompt(meta.bodies("/chat/completions")[0]).endswith(HINDI_INSTRUCTION)

        # the mission remembers its language: completing it writes the summary in Hindi without being told again
        c.post(f"/api/missions/{m['id']}/start", json={"executor": "TWIN"})
        c.post(f"/api/missions/{m['id']}/complete", json={**RESULT, "missionId": m["id"]})
        rep = wait_for_summary(c, m["id"], "MUSE_SPARK")
        assert rep["mission"]["language"] == "hi" and rep["summary"]["summary"] == "सारांश"
        assert system_prompt(meta.bodies("/chat/completions")[1]).endswith(HINDI_INSTRUCTION)

        # regenerating without a body is the same request in the mission's language (a cache hit); a body can override it
        before = len(meta.requests)
        assert c.post(f"/api/inspection/{m['id']}/summary").json()["summary"] == "सारांश"
        assert len(meta.requests) == before, "same language and records: served from the response cache"
        assert c.post(f"/api/inspection/{m['id']}/summary", json={"language": "en"}).json()["summary"] == "summary"
        assert HINDI_INSTRUCTION not in system_prompt(meta.bodies("/chat/completions")[2])
        refs = [e["inputRef"] for e in c.get("/api/evidence/model-executions").json()["executions"] if e["operation"] == "report_summary"]
        assert sorted(r.rsplit(" ", 1)[1] for r in refs) == ["lang=en", "lang=hi", "lang=hi"]
        assert c.post(f"/api/inspection/{m['id']}/summary", json={"language": "fr"}).status_code == 422


def test_english_is_the_default_and_adds_nothing_to_the_prompts(live_settings, meta):
    meta.add("/chat/completions", chat_tool_call("create_inspection_mission", GOOD_ARGS))
    with TestClient(create_app(live_settings, meta_transport=meta.transport)) as c:
        m = c.post("/api/ai/interpret", json={"instruction": DEMO_INSTRUCTION}).json()["mission"]
        assert m["language"] == "en"
        assert HINDI_INSTRUCTION not in system_prompt(meta.bodies("/chat/completions")[0])


# ---------------------------------------------------------------- offline paths stay English


def test_offline_hindi_stays_english_and_is_not_machine_translated(settings):
    with TestClient(create_app(settings)) as c:  # no key: the labelled offline parser and template
        m = c.post("/api/ai/interpret", json={"instruction": DEMO_INSTRUCTION, "language": "hi"}).json()["mission"]
        assert m["provider"] == "OFFLINE_RULE_PARSER" and m["language"] == "hi", "the setting is remembered even when no model can honour it"
        assert (m["explanation"] + " ".join(m["warnings"])).isascii()
        c.post(f"/api/missions/{m['id']}/start", json={"executor": "TWIN"})
        c.post(f"/api/missions/{m['id']}/complete", json={**RESULT, "missionId": m["id"]})
        rep = wait_for_summary(c, m["id"], "TEMPLATE_FROM_RECORDS")
        s = rep["summary"]
        assert s["provider"] == "TEMPLATE_FROM_RECORDS" and "".join([s["summary"], *s["limitations"], *s["keyFindings"], *s["recommendedFollowups"]]).isascii()
        assert "# Inspection report" in c.get(f"/api/inspection/{m['id']}/report?format=md").text


def test_locked_hindi_request_falls_back_to_the_english_offline_parser(live_settings, meta):
    from dataclasses import replace

    with TestClient(create_app(replace(live_settings, live_passcode="open-sesame"), meta_transport=meta.transport)) as c:
        m = c.post("/api/ai/interpret", json={"instruction": DEMO_INSTRUCTION, "language": "hi"}).json()["mission"]  # no X-Aqua-Passcode header
        assert m["provider"] == "OFFLINE_RULE_PARSER" and m["language"] == "hi" and any("locked" in w for w in m["warnings"])
        assert meta.requests == [], "a locked request makes no Meta call"
