"""Inspection reports built only from stored records. docs/ARCHITECTURE.md, reporting.

The report separates three kinds of statement: measured or simulated values (each labelled with its source), model
outputs (labelled with the model), and things nobody looked at (uninspected areas). A segmented loose cable or foreign
object is an UNVERIFIED visual observation; nothing in a report is a confirmed defect.
"""

from __future__ import annotations

import math
import time
from collections import Counter, defaultdict
from typing import Any

from .db import Repository
from .geometry import footprint_half_cm
from .schemas import ANOMALY_CANDIDATE_CLASSES

CELL_CM = 5.0
# Same detection-grade footprint as lib/sim/engine.ts recordCoverage: where centring costs at most 5 percent confidence.
CENTRING_MIN = 0.95
CENTERING_WEIGHT = 0.3

DISCLAIMERS = [
    "Segmentation outlines objects; it does not diagnose structural condition. Anomaly candidates are unverified visual observations.",
    "Values labelled SIMULATED come from the digital twin, not from physical sensors.",
    "The image-derived visibility estimate is an image statistic, not a calibrated turbidity measurement.",
]


def _footprint_detection_grade() -> tuple[float, float]:
    hw, hh = footprint_half_cm()
    r = math.sqrt((1 - CENTRING_MIN) / CENTERING_WEIGHT)
    return hw * r, hh * r


def uninspected_areas(region: dict[str, float], positions: list[tuple[float, float]]) -> tuple[list[dict[str, float]], float]:
    """Region cells no capture saw inside the detection-grade footprint, merged into row runs. Returns (areas, coverage)."""
    hx, hy = _footprint_detection_grade()
    x0, x1, y0, y1 = region["xMin"], region["xMax"], region["yMin"], region["yMax"]
    cols = max(1, math.ceil((x1 - x0) / CELL_CM))
    rows = max(1, math.ceil(max(y1 - y0, CELL_CM) / CELL_CM))
    missing: list[dict[str, float]] = []
    seen = 0
    for r in range(rows):
        cy = y0 + (r + 0.5) * (y1 - y0) / rows if y1 > y0 else y0
        run: list[float] | None = None
        for c in range(cols):
            cx = x0 + (c + 0.5) * (x1 - x0) / cols
            covered = any(abs(cx - px) <= hx and abs(cy - py) <= hy for px, py in positions)
            seen += covered
            cell = (x0 + c * (x1 - x0) / cols, x0 + (c + 1) * (x1 - x0) / cols)
            if not covered:
                run = [run[0], cell[1]] if run else [cell[0], cell[1]]
            elif run:
                missing.append({"xMin": round(run[0], 1), "xMax": round(run[1], 1), "yMin": round(cy - (y1 - y0) / rows / 2, 1), "yMax": round(cy + (y1 - y0) / rows / 2, 1)})
                run = None
        if run:
            missing.append({"xMin": round(run[0], 1), "xMax": round(run[1], 1), "yMin": round(cy - (y1 - y0) / rows / 2, 1), "yMax": round(cy + (y1 - y0) / rows / 2, 1)})
    return missing, seen / (cols * rows)


def template_summary(report: dict[str, Any], why: str = "no MODEL_API_KEY") -> dict[str, Any]:
    """Deterministic summary from the records, used when Muse Spark is unavailable. Labelled as such."""
    assets = report["assets"]
    anomalies = report["anomalyCandidates"]
    out = report["outcome"]
    findings = [f"{a['label'].replace('_', ' ')} at ({a['x']:.1f}, {a['y']:.1f}) cm, {a['observations']} observation(s)" for a in assets[:8]]
    limitations = []
    if report["uninspectedAreas"]:
        limitations.append(f"{len(report['uninspectedAreas'])} region strip(s) were outside the detection-grade footprint of every capture.")
    low = [c for c in report["path"] if c.get("imageBand") == "UNRELIABLE"]
    if low:
        limitations.append(f"{len(low)} frame(s) had an unreliable image-derived visibility estimate.")
    if report["segmentation"]["provider"] != "SAM_3_1":
        limitations.append(f"SAM 3.1 was not used ({why}); observations come from the simulated detector.")
    return {
        "provider": "TEMPLATE_FROM_RECORDS",
        "summary": (
            f"Mission {report['mission']['id']} ended {out['status'].lower().replace('_', ' ')} after {len(report['path'])} capture(s). "
            f"{len(assets)} object(s) were observed, {len(anomalies)} of them unverified anomaly candidate(s)."
        ),
        "keyFindings": findings,
        "limitations": limitations,
        "recommendedFollowups": [f"Verify the {a['label'].replace('_', ' ')} at ({a['x']:.1f}, {a['y']:.1f}) cm by direct inspection." for a in anomalies[:5]],
    }


def build_report(repo: Repository, mission_id: str) -> dict[str, Any] | None:
    m = repo.get_mission(mission_id)
    if m is None:
        return None
    captures = repo.captures_for(mission_id)
    observations = repo.observations_for(mission_id)
    assets = {a.id: a for a in repo.assets()}

    path = []
    seg_stats: Counter[str] = Counter()
    providers: Counter[str] = Counter()
    latencies: list[float] = []
    ious: list[float] = []
    baseline_vs_sam = []
    for c in captures:
        meta, q = c["meta"], c["quality"] or {}
        segs = repo.segmentations_for(c["id"])
        instances = sum(len(s.instances) for s in segs)
        for s in segs:
            seg_stats[s.status] += 1
            providers[s.provider] += 1
            if s.latency_ms is not None and s.provider == "SAM_3_1":
                latencies.append(s.latency_ms)
            ious += [i.iou for i in s.instances if i.iou is not None and s.provider == "SAM_3_1"]
        baseline_vs_sam.append({"seq": c["seq"], "simDetections": len(meta.get("detections", [])), "segmentedInstances": instances})
        path.append(
            {
                "captureId": c["id"],
                "seq": c["seq"],
                "reason": meta["reason"],
                "x": meta["gantryX"],
                "y": meta["gantryY"],
                "t": meta["time"],
                "perceptionState": meta["perception"],
                "cameraOnline": meta["cameraOnline"],
                # Twin frames carry the simulator's water state; camera frames only the image-derived estimate.
                "simulated": {"turbidity": meta["turbidity"], "lighting": meta["lighting"], "visibility": meta["visibility"], "source": "SIMULATED"}
                if meta.get("source", "DIGITAL_TWIN") == "DIGITAL_TWIN"
                else None,
                "imageVisibility": q.get("visibilityEstimate"),
                "imageBand": q.get("band"),
                "duplicateOf": c["duplicate_of"],
            }
        )

    by_asset: dict[str, list] = defaultdict(list)
    for o in observations:
        by_asset[o.asset_id].append(o)
    asset_rows = []
    for aid, obs in by_asset.items():
        a = assets.get(aid)
        if a is None:
            continue
        confs = [(o.confidence, o.confidence_source) for o in obs if o.confidence is not None]
        best = max(confs, default=(None, None), key=lambda t: t[0] or 0)
        asset_rows.append(
            {
                "assetId": aid,
                "label": a.label,
                "x": a.x,
                "y": a.y,
                "observations": len(obs),
                "sources": sorted({o.source for o in obs}),
                "bestConfidence": best[0],
                "confidenceSource": best[1],
                "status": "UNVERIFIED_ANOMALY_CANDIDATE" if a.label in ANOMALY_CANDIDATE_CLASSES else "OBSERVED",
                "firstSeen": min(o.created_at for o in obs),
                "lastSeen": max(o.created_at for o in obs),
                "seenInMissions": a.missions,
                "captureIds": sorted({o.capture_id for o in obs if o.capture_id}),
            }
        )
    asset_rows.sort(key=lambda r: (r["status"] != "UNVERIFIED_ANOMALY_CANDIDATE", r["x"]))
    region = m.plan.region.model_dump(by_alias=True)
    missing, coverage = uninspected_areas(region, [(p["x"], p["y"]) for p in path if p["cameraOnline"]])
    visited = m.result.get("waypointsVisited") if m.result else None
    report: dict[str, Any] = {
        "reportVersion": 1,
        "generatedAt": time.time(),
        "mission": {
            "id": m.id,
            "instruction": m.instruction,
            "provider": m.provider,
            "createdAt": m.created_at,
            "spec": m.spec.model_dump(by_alias=True),
            "planSummary": m.plan_summary.model_dump(by_alias=True),
            "executor": m.executor,
        },
        "outcome": {
            "status": m.status,
            "twinResult": m.result,
            "waypointsPlanned": len(m.plan.waypoints),
            "waypointsVisited": visited,
        },
        "path": path,
        "assets": asset_rows,
        "anomalyCandidates": [r for r in asset_rows if r["status"] == "UNVERIFIED_ANOMALY_CANDIDATE"],
        "uninspectedAreas": missing,
        "coverageEstimate": round(coverage, 4),
        "segmentation": {
            "provider": "SAM_3_1" if providers.get("SAM_3_1") else ("OFFLINE_FIXTURE" if providers else "NONE"),
            "requests": dict(seg_stats),
            "meanLatencyMs": round(sum(latencies) / len(latencies), 1) if latencies else None,
            "meanIouVsTwinTruth": round(sum(ious) / len(ious), 4) if ious else None,
            "iouSamples": len(ious),
        },
        "baselineVsSegmentation": baseline_vs_sam,
        "disclaimers": DISCLAIMERS,
    }
    stored = repo.get_summary(mission_id)
    report["summary"] = stored or template_summary(report)
    return report


def to_markdown(r: dict[str, Any]) -> str:
    m, out, s = r["mission"], r["outcome"], r["summary"]
    lines = [
        f"# Inspection report: {m['id']}",
        "",
        f"Instruction: {m['instruction']}",
        "",
        f"Mission source: {m['provider']}.",
        f"Outcome: {out['status']}.",
        f"Captures: {len(r['path'])}. Estimated coverage of the planned region: {r['coverageEstimate'] * 100:.0f} percent.",
        "",
        f"## Summary ({s.get('provider', 'MUSE_SPARK')})",
        "",
        s.get("summary", ""),
        "",
    ]
    for title, key in (("Key findings", "keyFindings"), ("Limitations", "limitations"), ("Recommended follow-ups", "recommendedFollowups")):
        items = s.get(key) or []
        if items:
            lines += [f"### {title}", "", *[f"- {i}" for i in items], ""]
    lines += ["## Unverified anomaly candidates", ""]
    lines += [f"- {a['label']} at ({a['x']:.1f}, {a['y']:.1f}) cm, {a['observations']} observation(s), sources {', '.join(a['sources'])}." for a in r["anomalyCandidates"]] or ["- None."]
    lines += ["", "## Observed objects", "", "| Asset | Label | X cm | Y cm | Observations | Best confidence | Status |", "|---|---|---|---|---|---|---|"]
    for a in r["assets"]:
        conf = f"{a['bestConfidence'] * 100:.1f}% ({a['confidenceSource']})" if a["bestConfidence"] is not None else "not available"
        lines.append(f"| {a['assetId']} | {a['label']} | {a['x']:.1f} | {a['y']:.1f} | {a['observations']} | {conf} | {a['status']} |")
    lines += ["", "## Uninspected areas", ""]
    lines += [f"- x {u['xMin']} to {u['xMax']} cm, y {u['yMin']} to {u['yMax']} cm." for u in r["uninspectedAreas"]] or ["- None inside the planned region."]
    seg = r["segmentation"]
    lines += ["", "## Segmentation", "", f"Provider: {seg['provider']}. Requests: {seg['requests']}."]
    if seg["meanIouVsTwinTruth"] is not None:
        lines.append(f"Mean IoU of SAM masks against digital-twin ground truth: {seg['meanIouVsTwinTruth']:.3f} over {seg['iouSamples']} masks.")
    lines += ["", "## Capture path", "", "| Seq | Reason | X | Y | Perception | Simulated visibility | Image visibility |", "|---|---|---|---|---|---|---|"]
    for p in r["path"]:
        iv = f"{p['imageVisibility']:.2f} ({p['imageBand']})" if p["imageVisibility"] is not None else "n/a"
        sv = f"{p['simulated']['visibility']:.2f}" if p["simulated"] else "n/a (camera)"
        lines.append(f"| {p['seq']} | {p['reason']} | {p['x']:.1f} | {p['y']:.1f} | {p['perceptionState']} | {sv} | {iv} |")
    lines += ["", "## Disclaimers", "", *[f"- {d}" for d in r["disclaimers"]], ""]
    return "\n".join(lines)
