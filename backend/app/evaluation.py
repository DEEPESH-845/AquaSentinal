"""Reproducible evaluation of the hackathon pipeline, run through the real FastAPI app (same routes as the product).

    cd backend && .venv/bin/python -m app.evaluation            # offline sections only without MODEL_API_KEY
    MODEL_API_KEY=... .venv/bin/python -m app.evaluation         # adds live Muse Spark, Voice Transcribe and SAM 3.1

Sections:
1. Mission parsing accuracy on shared/fixtures/eval/instructions.json (hand-labelled), offline parser always, Muse Spark when live.
2. Voice-derived versus manually entered parameters: the recorded demo instruction through Voice Transcribe, then Muse Spark,
   scored against the labelled spec of the same instruction. Live only.
3. SAM 3.1 segmentation IoU against the twin's ground-truth ID pass on three captured twin frames. Live only.

Results go to docs/evidence/evaluation.json and model executions to docs/evidence/model-executions.json.
A section that could not run is written as NOT_RUN with the reason; no number is ever filled in for it.
"""

from __future__ import annotations

import argparse
import json
import tempfile
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from .config import load_settings
from .main import create_app

ROOT = Path(__file__).resolve().parents[2]
EVAL = ROOT / "shared" / "fixtures" / "eval"
WAV = ROOT / "public" / "demo" / "instruction.wav"
FIELDS = ["objective", "targets", "scan_pattern", "reduce_speed_on_degradation", "stop_on_unsafe_visibility"]

# Twin frames captured by the product (scenario defaults, e2e run), with the capture metadata that produced them.
FRAMES = [
    {"name": "clear-x37", "gantryX": 37.057, "gantryY": 20.0, "turbidity": 0.15, "visibility": 0.912},
    {"name": "hazy-t052", "gantryX": 37.057, "gantryY": 20.0, "turbidity": 0.52, "visibility": 0.695},
    {"name": "murky-t067", "gantryX": 26.0, "gantryY": 20.0, "turbidity": 0.666, "visibility": 0.574},
]
ID_MAP = [
    {"index": i + 1, "objectId": o, "type": t}
    for i, (o, t) in enumerate(
        [("pipe-a", "PIPE_SEGMENT"), ("joint-1", "PIPE_JOINT"), ("pipe-b", "PIPE_SEGMENT"), ("valve-1", "VALVE"), ("joint-2", "PIPE_JOINT"), ("pipe-c", "PIPE_SEGMENT"),
         ("cable-1", "LOOSE_CABLE"), ("rope-1", "DEBRIS"), ("crate-1", "FOREIGN_OBJECT"), ("wrench-1", "FOREIGN_OBJECT"), ("panel-1", "INSPECTION_PANEL"), ("rocks-1", "DEBRIS")]
    )
]
# Fixed noun phrases so every run asks SAM the same question; the operator-prompt path skips frame reasoning.
SAM_PROMPTS = ["orange cable", "blue crate", "pipe flange"]
PROMPT_TRUTH = {"orange cable": {"cable-1"}, "blue crate": {"crate-1"}, "pipe flange": {"joint-1", "joint-2"}}


def spec_fields(spec: dict[str, Any]) -> dict[str, Any]:
    vp = spec.get("visibilityPolicy") or {}
    return {
        "objective": spec.get("objective"),
        "targets": sorted(spec.get("targets") or []),
        "scan_pattern": spec.get("scanPattern"),
        "reduce_speed_on_degradation": vp.get("reduceSpeedOnDegradation"),
        "stop_on_unsafe_visibility": vp.get("stopOnUnsafeVisibility"),
    }


def score(got: dict[str, Any], expected: dict[str, Any]) -> dict[str, Any]:
    exp = {**expected, "targets": sorted(expected["targets"])}
    per_field = {f: got[f] == exp[f] for f in FIELDS}
    g, e = set(got["targets"]), set(exp["targets"])
    return {
        "fields": per_field,
        "allCorrect": all(per_field.values()),
        "targetPrecision": round(len(g & e) / len(g), 3) if g else 0.0,
        "targetRecall": round(len(g & e) / len(e), 3) if e else 1.0,
        "got": got,
    }


def summarize_scores(rows: list[dict[str, Any]]) -> dict[str, Any]:
    n = len(rows)
    ok = [r for r in rows if "score" in r]
    return {
        "cases": n,
        "succeeded": len(ok),
        "allFieldsCorrect": sum(r["score"]["allCorrect"] for r in ok),
        "fieldAccuracy": {f: round(sum(r["score"]["fields"][f] for r in ok) / n, 3) for f in FIELDS} if n else {},
        "meanTargetPrecision": round(sum(r["score"]["targetPrecision"] for r in ok) / n, 3) if n else None,
        "meanTargetRecall": round(sum(r["score"]["targetRecall"] for r in ok) / n, 3) if n else None,
    }


def word_error_rate(ref: str, hyp: str) -> float:
    r, h = ref.lower().replace(".", "").replace(",", "").split(), hyp.lower().replace(".", "").replace(",", "").split()
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
    return round(d[len(h)] / max(1, len(r)), 3)


def parsing(c: TestClient, cases: list[dict[str, Any]], offline: bool) -> dict[str, Any]:
    rows = []
    for case in cases:
        r = c.post(f"/api/ai/interpret?offline={'true' if offline else 'false'}", json={"instruction": case["text"]})
        row: dict[str, Any] = {"id": case["id"], "status": r.status_code}
        if r.status_code == 200:
            body = r.json()
            row["provider"] = body["provider"]
            row["score"] = score(spec_fields(body["mission"]["spec"]), case["expected"])
        else:
            row["error"] = r.json().get("error", r.text)[:300]
        rows.append(row)
    return {"provider": "OFFLINE_RULE_PARSER" if offline else "MUSE_SPARK", "summary": summarize_scores(rows), "cases": rows}


def voice(c: TestClient, demo: dict[str, Any]) -> dict[str, Any]:
    with WAV.open("rb") as f:
        r = c.post("/api/voice/transcribe", files={"audio": ("instruction.wav", f.read(), "audio/wav")}, data={"inputSource": "RECORDED_INPUT"})
    if r.status_code != 200:
        return {"classification": "LIVE_META_FAILED", "step": "transcription", "status": r.status_code, "error": r.json().get("error", r.text)[:300]}
    t = r.json()
    out: dict[str, Any] = {
        "input": "RECORDED_INPUT: public/demo/instruction.wav, synthetic speech generated with macOS `say` (Samantha voice), 16 kHz mono",
        "transcript": t["transcript"], "wordErrorRate": word_error_rate(demo["text"], t["transcript"]), "transcribeLatencyMs": t["latencyMs"],
    }
    p = c.post("/api/ai/interpret", json={"instruction": t["transcript"]})
    if p.status_code != 200:
        return {**out, "classification": "LIVE_META_FAILED", "step": "planning", "status": p.status_code, "error": p.json().get("error", p.text)[:300]}
    spec = p.json()["mission"]["spec"]
    manual_fields = sum(1 for _ in FIELDS) + 4  # plus region, lane spacing, capture spacing, speed: parameters an operator sets by hand
    return {**out, "classification": "LIVE_META", "voiceDerived": score(spec_fields(spec), demo["expected"]), "manualParametersReplaced": manual_fields}


def segmentation(c: TestClient) -> dict[str, Any]:
    mid = c.post("/api/ai/interpret?offline=true", json={"instruction": "Inspect the pipeline left to right for loose cables and foreign objects."}).json()["mission"]["id"]
    c.post(f"/api/missions/{mid}/start", json={"executor": "TWIN"})
    frames = []
    for seq, fr in enumerate(FRAMES):
        meta = {
            "missionId": mid, "seq": seq, "reason": "MANUAL", "waypointIndex": seq, "time": float(seq), "gantryX": fr["gantryX"], "gantryY": fr["gantryY"],
            "visibility": fr["visibility"], "turbidity": fr["turbidity"], "lighting": 0.8, "perception": "NORMAL_VISIBILITY", "cameraOnline": True,
            "idMap": ID_MAP, "targets": ["loose_cable", "foreign_object", "pipe_joint"], "prompts": SAM_PROMPTS,
        }
        files = {"frame": ("f.jpg", (EVAL / "frames" / f"{fr['name']}.jpg").read_bytes(), "image/jpeg"), "idmask": ("i.png", (EVAL / "frames" / f"{fr['name']}_ids.png").read_bytes(), "image/png")}
        cap = c.post("/api/inspection/capture", data={"meta": json.dumps(meta)}, files=files).json()
        prompts = []
        for s in cap.get("segmentations", []):
            truth = PROMPT_TRUTH.get(s["prompt"], set())
            hits = [i for i in s["instances"] if i["matchedObjectId"] in truth]
            prompts.append({
                "prompt": s["prompt"], "provider": s["provider"], "status": s["status"], "latencyMs": s["latencyMs"], "instances": len(s["instances"]),
                "bestIouOnTarget": max((i["iou"] or 0.0 for i in hits), default=0.0), "found": bool(hits),
                "falseInstances": len(s["instances"]) - len(hits), "confidences": [i["confidence"] for i in s["instances"]],
            })
        frames.append({"frame": fr["name"], "turbidity": fr["turbidity"], "quality": (cap.get("quality") or {}).get("band"), "prompts": prompts})
    allp = [p for f in frames for p in f["prompts"] if p["provider"] == "SAM_3_1"]
    live = allp and all(p["status"] in ("OK", "EMPTY") for p in allp)
    return {
        "classification": "LIVE_META" if live else "LIVE_META_FAILED",
        "groundTruth": "twin ID pass (renderer silhouettes), not manual annotation",
        "frames": frames,
        "meanBestIou": round(sum(p["bestIouOnTarget"] for p in allp) / len(allp), 3) if allp else None,
        "targetFoundRate": round(sum(p["found"] for p in allp) / len(allp), 3) if allp else None,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=ROOT / "docs" / "evidence")
    args = ap.parse_args()
    base = load_settings()
    cases = json.loads((EVAL / "instructions.json").read_text())["cases"]
    with tempfile.TemporaryDirectory() as tmp:
        settings = replace(base, database_url=f"sqlite:///{tmp}/eval.db", data_dir=Path(tmp) / "data", app_mode="SIMULATION", hardware_enable=False)
        with TestClient(create_app(settings)) as c:
            live = settings.meta_available
            not_run = {"classification": "NOT_RUN", "reason": "MODEL_API_KEY not set"}
            result = {
                "generatedAt": datetime.now(UTC).isoformat(timespec="seconds"),
                "metaConfigured": live,
                "parsing": {"offline": parsing(c, cases, offline=True), "spark": parsing(c, cases, offline=False) if live else not_run},
                "voiceVsManual": voice(c, next(x for x in cases if x["id"] == "demo")) if live and WAV.exists() else not_run,
                "segmentation": segmentation(c) if live else not_run,
            }
            executions = c.get("/api/evidence/model-executions", params={"limit": 1000}).json()
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "evaluation.json").write_text(json.dumps(result, indent=2) + "\n")
    (args.out / "model-executions.json").write_text(json.dumps(executions, indent=2) + "\n")
    off = result["parsing"]["offline"]["summary"]
    print(f"offline parser: {off['allFieldsCorrect']}/{off['cases']} fully correct, field accuracy {off['fieldAccuracy']}")
    for k in ("spark",):
        s = result["parsing"][k]
        print(f"{k}: " + (f"{s['summary']['allFieldsCorrect']}/{s['summary']['cases']} fully correct" if "summary" in s else s["classification"]))
    print("voice:", result["voiceVsManual"].get("classification"), "| segmentation:", result["segmentation"].get("classification"))
    print("model executions:", executions["counts"] or "none", "->", args.out)


if __name__ == "__main__":
    main()
