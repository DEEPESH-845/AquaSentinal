"""Offline rule parser: the labelled fallback when MODEL_API_KEY is not set.

It is keyword matching, not language understanding, and every mission it produces carries provider
OFFLINE_RULE_PARSER so the UI and the report never present it as Muse Spark output.
"""

from __future__ import annotations

import hashlib
import re

from ..schemas import MissionSpec, Region, VisibilityPolicySpec

_TARGET_WORDS: list[tuple[str, str]] = [
    (r"\bcables?\b|\bwires?\b|\btethers?\b", "loose_cable"),
    (r"\bforeign\b|\bdropped\b|\btools?\b|\bwrench", "foreign_object"),
    (r"\bjoints?\b|\bflanges?\b", "pipe_joint"),
    (r"\bvalves?\b", "valve"),
    (r"\bpanels?\b|\bslabs?\b", "inspection_panel"),
    (r"\bdebris\b|\brocks?\b|\brope\b", "debris"),
]


def parse_instruction(instruction: str) -> tuple[MissionSpec, list[str]]:
    """Returns the spec and the list of interpretation notes shown to the operator."""
    text = instruction.lower()
    notes: list[str] = []

    targets = [t for pattern, t in _TARGET_WORDS if re.search(pattern, text)]
    pipeline = bool(re.search(r"pipe(line)?s?\b", text))
    survey = bool(re.search(r"\bsurvey\b|whole tank|entire (tank|area|floor)|everything", text))
    objective = "pipeline_inspection" if pipeline else "area_survey" if survey else "target_search"
    if objective == "pipeline_inspection" and "pipe_joint" not in targets:
        targets.append("pipe_joint")
        notes.append("pipeline inspection: flange joints added as a standard inspection point")
    if not targets:
        targets = ["foreign_object", "loose_cable"]
        notes.append("no target named: defaulting to foreign objects and loose cables")

    if re.search(r"right to left|right-to-left", text):
        pattern = "right_to_left"
    elif re.search(r"left to right|left-to-right", text):
        pattern = "left_to_right"
    elif re.search(r"serpentine|lawn ?mower|back and forth|zig ?zag", text) or survey:
        pattern = "serpentine"
    else:
        pattern = "left_to_right"
        notes.append("no scan direction given: left to right")

    if objective == "area_survey":
        region, lane = Region(x_min=5, x_max=95, y_min=4, y_max=36), 16.0
    else:
        region, lane = Region(), 24.0  # the pipeline corridor, one lane over the line

    speed = 0.65
    if re.search(r"\bslow(ly)?\b|carefully|cautious", text) and "reduce" not in text:
        speed = 0.45
    elif re.search(r"\bfast\b|\bquick(ly)?\b|rapid", text):
        speed = 0.85

    reduce = not re.search(r"(do not|don't|never) (slow|reduce)", text)
    stop = not re.search(r"(do not|don't|never) stop", text)
    if not re.search(r"reduce|slow", text):
        notes.append("speed reduction on poor visibility kept on (safe default)")
    if not re.search(r"\bstop\b|\bhalt\b|\bpause\b", text):
        notes.append("stop on unreliable visibility kept on (safe default)")

    digest = hashlib.sha1(instruction.encode()).hexdigest()[:6]
    spec = MissionSpec(
        mission_id=f"{objective.split('_')[0]}-{digest}",
        objective=objective,  # type: ignore[arg-type]
        targets=targets,  # type: ignore[arg-type]
        scan_pattern=pattern,  # type: ignore[arg-type]
        region=region,
        lane_spacing_cm=lane,
        speed_fraction=speed,
        priority="high" if re.search(r"urgent|high priority|asap", text) else "normal",
        record_evidence=True,
        visibility_policy=VisibilityPolicySpec(reduce_speed_on_degradation=reduce, stop_on_unsafe_visibility=stop),
        notes="Parsed offline by keyword rules; no language model was used.",
    )
    return spec, notes
