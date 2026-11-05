"""Real water camera: one frame from a phone or laptop camera, one SAM 3.1 request per phrase (at most two), no mission.

Every request goes through the Sam client, so the response cache, the budget cap and the execution log apply as for a capture.
Without a key, or locked, nothing is sent and no mask is invented: the response says which of the two it was.
"""

from __future__ import annotations

import asyncio
import hashlib

from ..meta.client import MetaAPIError, MetaBudgetExceeded, collect_executions
from ..meta.sam import Sam
from ..mission.ask import _classify
from ..schemas import MAX_REAL_PROMPTS, RealInstance, RealSegment, RealSegmentResponse
from .pipeline import mask_polygons
from .quality import decode

MAX_PROMPT_CHARS = 60  # the same limit as SegmentRequest

NOTES = {
    "NO_KEY": "SAM 3.1 needs the Meta key: no MODEL_API_KEY is set, so no mask was drawn.",
    "LIVE_LOCKED": "SAM 3.1 needs the Meta key: live mode is locked, so no mask was drawn.",
}


def clean_prompts(raw: list[str]) -> list[str]:
    """Phrases to segment, in order. More than MAX_REAL_PROMPTS, none, or a blank or over-long one is refused; a repeat is asked once."""
    if not 1 <= len(raw) <= MAX_REAL_PROMPTS:
        raise ValueError(f"send one or two prompts per shutter, got {len(raw)}")
    prompts: dict[str, str] = {}
    for p in (r.strip() for r in raw):
        if not p or len(p) > MAX_PROMPT_CHARS:
            raise ValueError(f"a prompt must be 1 to {MAX_PROMPT_CHARS} characters")
        prompts.setdefault(p.casefold(), p)
    return list(prompts.values())


async def _segment_one(sam: Sam, jpeg: bytes, prompt: str, width: int, height: int, ref: str) -> RealSegment:
    try:
        instances, latency = await sam.segment(jpeg, prompt, width, height, ref=ref)
    except MetaBudgetExceeded as e:  # already counted as a saved call by the governor
        return RealSegment(prompt=prompt, status="SKIPPED_BUDGET", latency_ms=None, error=str(e)[:300], instances=[])
    except (MetaAPIError, asyncio.TimeoutError) as e:
        return RealSegment(prompt=prompt, status="FAILED", latency_ms=None, error=(str(e) or "timed out")[:300], instances=[])
    out = [RealInstance(box=i.box, confidence=i.confidence, area_px=int(i.mask.sum()), polygons=mask_polygons(i.mask)) for i in instances]
    return RealSegment(prompt=prompt, status="OK" if out else "EMPTY", latency_ms=None if latency is None else round(latency, 1), error=None, instances=out)


async def segment_image(sam: Sam | None, jpeg: bytes, prompts: list[str], live: bool) -> RealSegmentResponse:
    """live=False is a locked request: it takes the no-key path even when a key is configured. Raises ValueError for an undecodable frame."""
    height, width = decode(jpeg).shape[:2]
    if sam is None or not live:
        fallback = "NO_KEY" if sam is None else "LIVE_LOCKED"
        return RealSegmentResponse(
            width=width, height=height, segments=[], provider="UNAVAILABLE", model=None, execution_ids=[], classification=None, latency_ms=None, cost_usd=0.0,
            fallback=fallback, note=NOTES[fallback],
        )
    ref = f"realcam sha1={hashlib.sha1(jpeg).hexdigest()[:10]}"
    with collect_executions() as executions:
        segments = await asyncio.gather(*(_segment_one(sam, jpeg, p, width, height, ref) for p in prompts))
    answered = any(s.status in ("OK", "EMPTY") for s in segments)
    latencies = [s.latency_ms for s in segments if s.latency_ms is not None]
    return RealSegmentResponse(
        width=width, height=height, segments=list(segments), provider="SAM_3_1" if answered else "UNAVAILABLE", model=sam.model,
        execution_ids=[e["id"] for e in executions], classification=_classify([e for e in executions if e["success"]]), latency_ms=max(latencies, default=None),
        cost_usd=round(sum(e.get("costUsd") or 0.0 for e in executions if e["classification"] == "LIVE_META"), 6), fallback=None,
        note="" if answered else next((s.error for s in segments if s.error), ""),
    )
