"""Ask the inspector: the ASK tool phase, citation linking, the offline records query, and the live Muse Spark tool loop
(scripted over a mocked httpx transport) through the credit governor. No test touches the network."""

import asyncio
import json
from dataclasses import replace

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.meta.spark import HINDI_INSTRUCTION
from app.mission.ask import ASK_MAX_TOKENS, ASK_SYSTEM, FREE_FORM, LAST_TURN_NOTE, MAX_ASK_TURNS, READ_FIRST_NOTE, AskTools, link_citations
from app.mission.tools import TOOLS, ToolRegistry

from .conftest import chat_tool_call
from .test_governor import CABLE_DET, FRAME_A, FRAME_B, FRAME_C, PASSCODE, capture_form, post

ASK_TOOLS = {"list_observations", "get_capture", "get_track", "get_mission_summary", "compare_with_previous_mission"}
WRENCH_DET = [{"objectId": "wrench-1", "trueType": "FOREIGN_OBJECT", "class": "FOREIGN_OBJECT", "confidence": 0.9, "bbox": [0.5, 0.3, 0.1, 0.1], "estX": 60.0, "estY": 10.0}]
RESULT = {
    "adaptive": True, "outcome": "COMPLETED", "waypointsVisited": 6, "waypointsPlanned": 6, "captures": 3, "unreliableCaptures": 0, "reobservations": 0,
    "pauses": 0, "confirmedTargets": 1, "falsePositives": 0, "avgConfidence": 0.5, "coverage": 1.0, "minVisibility": 0.9, "durationS": 20,
}


def ask(c: TestClient, mid: str, question: str, language: str = "en", **kw) -> dict:
    r = c.post(f"/api/inspection/{mid}/ask", json={"question": question, "language": language}, **kw)
    assert r.status_code == 200, r.text
    return r.json()


def seed(c: TestClient, instruction: str = "inspect cables only", frames=((FRAME_A, CABLE_DET), (FRAME_B, WRENCH_DET), (FRAME_C, []))) -> str:
    """A planned, running mission with stored captures: a loose cable at (20, 22) seen once, a foreign object at (60, 10)."""
    mid = c.post("/api/ai/interpret?offline=true", json={"instruction": instruction}).json()["mission"]["id"]
    c.post(f"/api/missions/{mid}/start", json={"executor": "TWIN"})
    for seq, (jpeg, dets) in enumerate(frames):
        assert post(c, capture_form(mid, seq, 26 + seq * 14, detections=dets), jpeg).status_code == 200
    return mid


def seeded(settings, **kw) -> str:
    """seed() on an app without a key, so the stored observations come from the simulated detector. The same database is then opened with a key."""
    with TestClient(create_app(settings)) as c:
        return seed(c, **kw)


def finish(c: TestClient, mid: str, outcome: str = "COMPLETED") -> None:
    c.post(f"/api/missions/{mid}/{'complete' if outcome == 'COMPLETED' else 'stop'}", json={**RESULT, "missionId": mid} if outcome == "COMPLETED" else None)


def run(registry: ToolRegistry, name: str, args: dict, phase="ASK"):
    return asyncio.run(registry.dispatch(name, args, phase, "SYSTEM"))


# ---------------------------------------------------------------- the ASK phase


def test_the_ask_phase_offers_exactly_the_five_read_only_tools_and_no_other_phase_does():
    assert {t["function"]["name"] for t in ToolRegistry.schemas("ASK")} == ASK_TOOLS
    for phase in ("PLANNING", "EXECUTION", "REPORTING"):
        assert not ASK_TOOLS & {t["function"]["name"] for t in ToolRegistry.schemas(phase)}, f"{phase} must not offer the read-only ASK views"
    # the planner's tool list is unchanged by this feature
    assert {t["function"]["name"] for t in ToolRegistry.schemas("PLANNING")} == {"get_telemetry", "get_environment_conditions", "get_camera_status", "create_inspection_mission"}
    for t in ToolRegistry.schemas("ASK"):
        assert t["type"] == "function" and t["function"]["parameters"]["type"] == "object"


@pytest.mark.anyio
async def test_every_mutating_tool_is_refused_in_ask_even_with_a_handler_bound():
    reg, touched = ToolRegistry(), []

    async def handler(args):
        touched.append(args)

    mutating = [name for name, t in TOOLS.items() if name not in ASK_TOOLS and "ASK" not in t.phases]
    assert {"create_inspection_mission", "move_to_waypoint", "start_inspection", "pause_inspection", "stop_inspection", "record_observation", "capture_inspection_frame", "segment_target", "generate_inspection_summary"} <= set(mutating)
    for name in mutating:
        reg.bind(name, handler)
    for name in mutating:
        for caller in ("MUSE_SPARK", "OFFLINE_RECORDS_QUERY"):
            r = await reg.dispatch(name, {}, "ASK", caller)
            assert not r.ok and f"'{name}' is not permitted during ASK" in r.error, name
    r = await reg.dispatch("rm_rf", {}, "ASK", "MUSE_SPARK")
    assert not r.ok and "does not exist" in r.error
    assert touched == [], "a refused tool never reaches its handler"
    # and the read-only views are refused outside ASK, so the planner cannot be handed them either
    reg.bind("get_mission_summary", handler)
    assert not (await reg.dispatch("get_mission_summary", {}, "PLANNING", "MUSE_SPARK")).ok and touched == []


def test_ask_tools_validate_their_arguments_and_read_only_this_mission(settings):
    with TestClient(create_app(settings)) as c:
        mid, other = seed(c), seed(c, "inspect valves only", frames=((FRAME_C, CABLE_DET),))
        repo = c.app.state.s.repo
        tools = AskTools(repo, repo.get_mission(mid))
        reg = tools.registry()
        assert not run(reg, "list_observations", {"label": "submarine"}).ok, "label is one of the target classes"
        assert not run(reg, "get_track", {"trackId": "x"}).ok, "extra arguments are refused"
        listed = run(reg, "list_observations", {})
        assert listed.ok and listed.result["total"] == 2 and {o["label"] for o in listed.result["observations"]} == {"loose_cable", "foreign_object"}
        only = run(reg, "list_observations", {"label": "loose_cable"})
        assert [o["label"] for o in only.result["observations"]] == ["loose_cable"]
        foreign_capture = repo.captures_for(other)[0]["id"]
        denied = run(reg, "get_capture", {"capture_id": foreign_capture})
        assert not denied.ok and "not part of this mission" in denied.error
        assert not run(reg, "get_track", {"track_id": "asset_nope"}).ok
        cap = listed.result["observations"][0]["captureId"]
        got = run(reg, "get_capture", {"capture_id": cap})
        assert got.ok and got.result["captureId"] == cap and got.result["observations"][0]["trackId"] == listed.result["observations"][0]["trackId"]
        assert tools.returned >= {cap}, "ids a tool returned are the citable ones"
        assert foreign_capture not in tools.returned and tools.citation(foreign_capture) is None


def test_compare_with_previous_mission_uses_the_latest_earlier_completed_mission_or_says_there_is_none(settings):
    with TestClient(create_app(settings)) as c:
        first = seed(c, "inspect cables only", frames=((FRAME_A, CABLE_DET),))
        repo = c.app.state.s.repo

        def compare(mid: str):
            return run(AskTools(repo, repo.get_mission(mid)).registry(), "compare_with_previous_mission", {}).result

        assert compare(first) == {"available": False, "previousMission": None, "reason": "no previous mission: no earlier completed mission is stored"}, "nothing is invented"
        finish(c, first)
        aborted = seed(c, "inspect valves only", frames=((FRAME_B, []),))
        finish(c, aborted, "ABORTED")
        current = seed(c, "inspect foreign objects", frames=((FRAME_A, CABLE_DET), (FRAME_B, WRENCH_DET)))
        r = compare(current)
        assert r["available"] and r["previousMission"] == first, "an aborted mission is not a comparison baseline"
        assert r["captures"] == {"current": 2, "previous": 1} and r["trackedObjects"] == {"current": 2, "previous": 1}
        assert [t["label"] for t in r["inBoth"]] == ["loose_cable"], "the cable keeps its asset id between missions"
        assert [t["label"] for t in r["onlyInCurrent"]] == ["foreign_object"] and r["onlyInPrevious"] == []
        assert compare(first)["available"] is False, "a later mission is never the previous one"


# ---------------------------------------------------------------- citations


def test_link_citations_numbers_valid_ids_and_removes_the_rest():
    text, cited, dropped = link_citations("The cable is at (20, 22) cm [cap_a1]. A rope lies near it [cap_ghost]. Both are visible [cap_b2, cap_a1].", {"cap_a1", "cap_b2"})
    assert text == "The cable is at (20, 22) cm [1]. A rope lies near it. Both are visible [2][1]."
    assert cited == ["cap_a1", "cap_b2"] and dropped == ["cap_ghost"]
    text, cited, dropped = link_citations("See cap_a1 and cap_zz.", {"cap_a1"})
    assert text == "See [1] and." and cited == ["cap_a1"] and dropped == ["cap_zz"]
    text, cited, dropped = link_citations("Nothing cited here, and a [1] of the model's own.", {"cap_a1"})
    assert text == "Nothing cited here, and a [1] of the model's own." and cited == [] and dropped == []


# ---------------------------------------------------------------- offline records query


def test_offline_intents_answer_from_the_records_with_citations_and_no_model(settings, meta):
    with TestClient(create_app(settings, meta_transport=meta.transport)) as c:
        mid = seed(c)
        valid = {cap["id"] for cap in c.app.state.s.repo.captures_for(mid)}

        def offline(question: str, **kw) -> dict:
            r = ask(c, mid, question, **kw)
            assert r["provider"] == "OFFLINE_RECORDS_QUERY" and r["model"] is None and r["fallback"] == "NO_KEY" and r["classification"] is None
            assert r["executionIds"] == [] and r["droppedCitations"] == [] and r["language"] == "en"
            assert "cap_" not in r["answer"], "ids become numbered markers"
            assert {x["captureId"] for x in r["citations"]} <= valid
            assert all(t["phase"] == "ASK" and t["by"] == "OFFLINE_RECORDS_QUERY" and t["name"] in ASK_TOOLS for t in r["toolCalls"])
            return r

        where = offline("Where is the loose cable?")
        assert where["answer"].startswith("Loose cable ") and "(20.0, 22.0) cm" in where["answer"] and "[1]" in where["answer"]
        assert [t["name"] for t in where["toolCalls"]] == ["list_observations", "get_track"] and where["toolCalls"][0]["arguments"] == {"label": "loose_cable"}
        assert where["citations"][0]["label"] == "loose_cable" and (where["citations"][0]["x"], where["citations"][0]["y"]) == (20.0, 22.0)

        count = offline("How many objects were found?")
        assert "2 tracked object(s) from 2 observation(s) in 3 capture(s)" in count["answer"] and "1 loose cable" in count["answer"] and "1 foreign object" in count["answer"]
        assert len(count["citations"]) == 2
        assert "1 loose cable object(s) with 1 observation(s)" in offline("how many cables are there")["answer"]
        assert "has 3 capture(s)" in offline("How many captures were taken?")["answer"]

        what = offline("What did the inspection find?")
        assert "3 capture(s) and 2 tracked object(s)" in what["answer"] and "Unverified anomaly candidates: loose cable" in what["answer"] and "foreign object" in what["answer"]
        assert {t["name"] for t in what["toolCalls"]} == {"get_mission_summary"}

        conf = offline("How confident is the detection of the cable?")
        assert "best confidence 50 percent from the simulated detector (the twin's own score, not a model's)" in conf["answer"] and conf["citations"]

        none = offline("Where is the valve?")
        assert none["answer"] == f"No valve is recorded in mission {mid}." and none["citations"] == []

        free = offline("Why is the water so cloudy today?")
        assert free["answer"] == FREE_FORM and free["citations"] == [] and free["toolCalls"] == []

        hindi = offline("Where is the loose cable?", language="hi")
        assert hindi["answer"].isascii() and hindi["language"] == "en", "offline answers are English; the setting does not translate them"
        assert meta.requests == []


def test_ask_validates_the_request_and_the_mission(settings):
    with TestClient(create_app(settings)) as c:
        mid = seed(c)
        for body in ({"question": "hi"}, {"question": "x" * 501}, {"question": "Where is the cable?", "language": "fr"}, {"question": "Where is the cable?", "extra": 1}):
            assert c.post(f"/api/inspection/{mid}/ask", json=body).status_code == 422, body
        assert c.post("/api/inspection/nope/ask", json={"question": "Where is the cable?"}).status_code == 404


# ---------------------------------------------------------------- live: the Muse Spark tool loop


def tool_messages(req: httpx.Request) -> list[dict]:
    return [json.loads(m["content"]) for m in json.loads(req.content)["messages"] if m["role"] == "tool"]


def says(text: str) -> httpx.Response:
    return httpx.Response(200, json={"id": "chatcmpl-ask", "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": text}}], "usage": {"prompt_tokens": 300, "completion_tokens": 60}})


def script_three_turns(meta, ghost: str = "cap_deadbeef0001"):
    """list_observations, then get_track on the first track it returned, then an answer citing a real capture and an invented one."""
    meta.add("/chat/completions", chat_tool_call("list_observations", {}, "c1"))
    meta.add("/chat/completions", lambda req: chat_tool_call("get_track", {"track_id": tool_messages(req)[0]["observations"][0]["trackId"]}, "c2"))

    def final(req: httpx.Request) -> httpx.Response:
        cap = tool_messages(req)[0]["observations"][0]["captureId"]
        return says(f"The loose cable is at (20.0, 22.0) cm [{cap}]. It is an unverified candidate [{cap}], and a second one hides behind it [{ghost}].")

    meta.add("/chat/completions", final)


def test_live_tool_loop_answers_with_validated_citations_and_logs_every_turn(settings, live_settings, meta):
    script_three_turns(meta)
    mid = seeded(settings)
    with TestClient(create_app(live_settings, meta_transport=meta.transport)) as c:
        real = {cap["id"] for cap in c.app.state.s.repo.captures_for(mid)}
        before = len(meta.requests)
        r = ask(c, mid, "Where is the loose cable?")
        assert r["provider"] == "MUSE_SPARK" and r["model"] == "muse-spark-1.3" and r["fallback"] is None and r["note"] == ""
        assert r["answer"] == "The loose cable is at (20.0, 22.0) cm [1]. It is an unverified candidate [1], and a second one hides behind it." and r["language"] == "en"
        assert len(r["citations"]) == 1 and r["citations"][0]["captureId"] in real and r["citations"][0]["label"] == "loose_cable"
        assert (r["citations"][0]["x"], r["citations"][0]["y"]) == (20.0, 22.0)
        assert r["droppedCitations"] == ["cap_deadbeef0001"], "an id no tool returned never becomes a citation"
        assert [t["name"] for t in r["toolCalls"]] == ["list_observations", "get_track"] and all(t["ok"] and t["phase"] == "ASK" and t["by"] == "MUSE_SPARK" for t in r["toolCalls"])

        # three requests, each bounded, each offering only the ASK tools; the last one tells the model to answer
        bodies = meta.bodies("/chat/completions")
        assert len(meta.requests) - before == len(bodies) == MAX_ASK_TURNS
        assert all(b["max_tokens"] == ASK_MAX_TOKENS and b["model"] == "muse-spark-1.3" for b in bodies)
        assert all({t["function"]["name"] for t in b["tools"]} == ASK_TOOLS for b in bodies)
        assert bodies[0]["messages"][0] == {"role": "system", "content": ASK_SYSTEM} and bodies[0]["messages"][1] == {"role": "user", "content": "Where is the loose cable?"}
        assert "cap_" in ASK_SYSTEM and bodies[-1]["messages"][-1] == {"role": "user", "content": LAST_TURN_NOTE}
        assert HINDI_INSTRUCTION not in bodies[0]["messages"][0]["content"]

        # the answer's executions are exactly the ones in the log; this transport is a mock, so they are MOCKED and say so
        log = c.get("/api/evidence/model-executions").json()["executions"]
        asks = [e for e in log if e["operation"] == "inspection_ask"]
        assert sorted(r["executionIds"]) == sorted(e["id"] for e in asks) and len(asks) == MAX_ASK_TURNS
        assert r["classification"] == "MOCKED" and {e["classification"] for e in asks} == {"MOCKED"}
        assert all(e["inputRef"].startswith(f"ask:mission={mid} q=sha1:") and "Where is" not in e["inputRef"] for e in asks), "the log holds references, not the question"

        # asking the same thing again is served from the response cache: no request, and the answer says so
        again = ask(c, mid, "Where is the loose cable?")
        assert len(meta.requests) - before == MAX_ASK_TURNS and again["answer"] == r["answer"]
        assert again["classification"] == "CACHED_MOCKED" and again["provider"] == "MUSE_SPARK"
        assert not set(again["executionIds"]) & set(r["executionIds"]) and len(again["executionIds"]) == MAX_ASK_TURNS
        cached = [e for e in c.get("/api/evidence/model-executions").json()["executions"] if e["id"] in again["executionIds"]]
        assert all(e["cachedFrom"] in r["executionIds"] and e["costUsd"] == 0 for e in cached)


def test_a_hindi_question_is_answered_in_hindi_with_ids_and_numbers_left_alone(settings, live_settings, meta):
    meta.add("/chat/completions", chat_tool_call("get_mission_summary", {}, "c1"))
    meta.add("/chat/completions", lambda req: says(f"केबल (20.0, 22.0) सेमी पर है [{tool_messages(req)[0]['anomalyCandidates'][0]['captureIds'][0]}]।"))
    mid = seeded(settings)
    with TestClient(create_app(live_settings, meta_transport=meta.transport)) as c:
        r = ask(c, mid, "केबल कहाँ है?", "hi")
        assert r["provider"] == "MUSE_SPARK" and r["language"] == "hi" and r["answer"] == "केबल (20.0, 22.0) सेमी पर है [1]।" and len(r["citations"]) == 1
        first = meta.bodies("/chat/completions")[0]
        assert first["messages"][0]["content"] == ASK_SYSTEM + "\n" + HINDI_INSTRUCTION and first["messages"][1]["content"] == "केबल कहाँ है?"
        # a different language is a different request, so it is never answered from the English cache
        before = len(meta.requests)
        meta.add("/chat/completions", chat_tool_call("get_mission_summary", {}, "c1"))
        meta.add("/chat/completions", says("The cable is at (20.0, 22.0) cm."))
        en = ask(c, mid, "केबल कहाँ है?", "en")
        assert len(meta.requests) - before == 2 and en["language"] == "en"


def test_an_answer_that_read_no_record_is_sent_back_to_read_them(settings, live_settings, meta):
    meta.add("/chat/completions", says("There is surely a cable somewhere."))
    meta.add("/chat/completions", chat_tool_call("get_mission_summary", {}, "c1"))
    meta.add("/chat/completions", lambda req: says("One unverified candidate."))
    mid = seeded(settings)
    with TestClient(create_app(live_settings, meta_transport=meta.transport)) as c:
        r = ask(c, mid, "Is there a cable?")
        assert r["provider"] == "MUSE_SPARK" and r["answer"] == "One unverified candidate." and r["citations"] == []
        second = meta.bodies("/chat/completions")[1]
        assert second["messages"][-2:] == [{"role": "assistant", "content": "There is surely a cable somewhere."}, {"role": "user", "content": READ_FIRST_NOTE}]


def test_a_model_that_keeps_asking_for_tools_is_stopped_at_the_turn_limit_and_the_records_query_answers(settings, live_settings, meta):
    for i in range(5):
        meta.add("/chat/completions", chat_tool_call("list_observations", {}, f"c{i}"))
    mid = seeded(settings)
    with TestClient(create_app(live_settings, meta_transport=meta.transport)) as c:
        r = ask(c, mid, "Where is the loose cable?")
        assert len(meta.requests) == MAX_ASK_TURNS, "never more than three requests"
        assert r["provider"] == "OFFLINE_RECORDS_QUERY" and r["fallback"] == "NO_ANSWER" and r["classification"] is None and "no grounded answer" in r["note"]
        assert "(20.0, 22.0) cm" in r["answer"], "the fallback still answers from the records"
        assert len(r["executionIds"]) == MAX_ASK_TURNS, "the calls that were made stay on the record"
        assert [t["by"] for t in r["toolCalls"]][:2] == ["MUSE_SPARK", "MUSE_SPARK"] and r["toolCalls"][-1]["by"] == "OFFLINE_RECORDS_QUERY"


def test_a_mutating_tool_asked_for_by_the_model_comes_back_as_an_error_and_nothing_moves(settings, live_settings, meta):
    meta.add("/chat/completions", chat_tool_call("move_to_waypoint", {"x": 50, "y": 20}, "c1"))
    meta.add("/chat/completions", chat_tool_call("create_inspection_mission", {"objective": "area_survey"}, "c2"))
    meta.add("/chat/completions", says("I could only read the records."))
    mid = seeded(settings)
    with TestClient(create_app(live_settings, meta_transport=meta.transport)) as c:
        missions, gantry = len(c.get("/api/missions").json()), c.get("/api/telemetry").json()["gantry"]["status"]
        r = ask(c, mid, "Please move the gantry to the cable.")
        tried = r["toolCalls"][:2]
        assert [(t["name"], t["ok"], t["by"]) for t in tried] == [("move_to_waypoint", False, "MUSE_SPARK"), ("create_inspection_mission", False, "MUSE_SPARK")]
        assert all("not permitted during ASK" in t["error"] for t in tried)
        assert r["provider"] == "OFFLINE_RECORDS_QUERY" and r["fallback"] == "NO_ANSWER", "an answer that read no record is not accepted"
        assert all(t["by"] == "OFFLINE_RECORDS_QUERY" for t in r["toolCalls"][2:]), "what the fallback did itself is told apart from what the model tried"
        assert len(c.get("/api/missions").json()) == missions, "no mission was created"
        after = c.get("/api/telemetry").json()["gantry"]["status"]
        assert (after["target_x"], after["target_y"]) == (gantry["target_x"], gantry["target_y"]) and after["last_command"] == gantry["last_command"], "the gantry was not asked to move"


def test_a_failed_meta_call_falls_back_and_keeps_the_executions_that_happened(settings, live_settings, meta):
    meta.add("/chat/completions", chat_tool_call("list_observations", {}, "c1"))
    meta.add("/chat/completions", httpx.Response(400, json={"error": {"message": "bad request", "type": "invalid_request_error", "code": "bad"}}))
    mid = seeded(settings)
    with TestClient(create_app(live_settings, meta_transport=meta.transport)) as c:
        r = ask(c, mid, "Where is the loose cable?")
        assert r["provider"] == "OFFLINE_RECORDS_QUERY" and r["fallback"] == "LIVE_META_FAILED" and "(400 bad)" in r["note"] and "(20.0, 22.0) cm" in r["answer"]
        log = {e["id"]: e for e in c.get("/api/evidence/model-executions").json()["executions"]}
        assert [log[i]["classification"] for i in r["executionIds"]] == ["MOCKED", "LIVE_META_FAILED"] or [log[i]["success"] for i in r["executionIds"]] == [True, False]
        assert all(log[i]["operation"] == "inspection_ask" for i in r["executionIds"])


# ---------------------------------------------------------------- the governor: lock and budget


def test_a_locked_ask_makes_no_meta_call_and_says_it_is_locked(settings, live_settings, meta):
    script_three_turns(meta)
    mid = seeded(settings)
    with TestClient(create_app(replace(live_settings, live_passcode=PASSCODE), meta_transport=meta.transport)) as c:
        for headers in ({}, {"X-Aqua-Passcode": "wrong"}):
            r = ask(c, mid, "Where is the loose cable?", headers=headers)
            assert r["provider"] == "OFFLINE_RECORDS_QUERY" and r["fallback"] == "LIVE_LOCKED" and "locked" in r["note"] and r["executionIds"] == []
            assert "(20.0, 22.0) cm" in r["answer"]
        assert meta.requests == [], "a locked request never reaches Meta"
        r = ask(c, mid, "Where is the loose cable?", headers={"X-Aqua-Passcode": PASSCODE})
        assert r["provider"] == "MUSE_SPARK" and r["fallback"] is None and len(meta.requests) == MAX_ASK_TURNS


def test_an_ask_over_budget_is_refused_before_any_request_and_answers_offline(settings, live_settings, meta):
    script_three_turns(meta)
    mid = seeded(settings)
    with TestClient(create_app(replace(live_settings, meta_budget_usd=0.0001), meta_transport=meta.transport)) as c:
        r = ask(c, mid, "Where is the loose cable?")
        assert r["provider"] == "OFFLINE_RECORDS_QUERY" and r["fallback"] == "BUDGET_EXCEEDED" and "budget" in r["note"] and r["executionIds"] == []
        assert meta.requests == [] and "(20.0, 22.0) cm" in r["answer"]
        assert c.get("/api/system/status").json()["credits"]["saved"]["byReason"]["budget"] == 1


def test_no_key_means_the_offline_records_query_and_the_route_still_exists(settings):
    with TestClient(create_app(settings)) as c:
        r = ask(c, seed(c), "Where is the loose cable?")
        assert r["fallback"] == "NO_KEY" and "MODEL_API_KEY" in r["note"]

