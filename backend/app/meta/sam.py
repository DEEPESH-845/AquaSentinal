"""SAM 3.1 over the Responses API. https://dev.meta.ai/docs/sam/segmenting

One concept prompt per request, the frame inlined as a base64 data URL, one_bit masks and per-record confidence.
The special-token output is parsed by Meta's own meta_sam_parser, never by hand.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass

import numpy as np
from meta_sam_parser import CompletedOutcome, IncompleteOutcome, decode_mask_to_raster, image_segmentation_format

from .client import MetaAPIError, MetaClient


@dataclass
class SamInstance:
    object_id: str
    box: tuple[int, int, int, int]  # half-open, source pixels
    confidence: float | None  # the model's c field, None when absent (None is not zero)
    mask: np.ndarray  # full-frame bool raster, height x width


def parse_sam_output(text: str, width: int, height: int, complete: bool = True) -> list[SamInstance]:
    """Parses SAM's output_text lane into full-frame masks. Empty text is a valid zero-match result."""
    if not text.strip():
        return []
    parser = image_segmentation_format().create_parser()
    parser.push(text)
    result = parser.finish(CompletedOutcome() if complete else IncompleteOutcome(reason="response")).result
    boxes = {r.object_id: r for r in result.records if r.kind == "box"}
    out: list[SamInstance] = []
    for rec in result.records:
        if rec.kind != "mask":
            continue
        raster = np.frombuffer(decode_mask_to_raster(rec.mask), dtype=np.uint8).reshape(rec.mask.height, rec.mask.width)
        full = np.zeros((height, width), dtype=bool)
        b = rec.bounds
        x0, y0 = max(0, int(b.left)), max(0, int(b.top))
        x1, y1 = min(width, x0 + raster.shape[1]), min(height, y0 + raster.shape[0])
        full[y0:y1, x0:x1] = raster[: y1 - y0, : x1 - x0] > 0
        box = boxes.get(rec.object_id)
        bb = (int(box.left), int(box.top), int(box.right), int(box.bottom)) if box else (x0, y0, x1, y1)
        conf = rec.confidence if rec.confidence is not None else (box.confidence if box else None)
        out.append(SamInstance(object_id=rec.object_id, box=bb, confidence=conf, mask=full))
    return out


class Sam:
    def __init__(self, client: MetaClient, model: str):
        self.client = client
        self.model = model

    async def segment(self, jpeg: bytes, prompt: str, width: int, height: int, ref: str = "") -> tuple[list[SamInstance], float]:
        url = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()
        text, final, latency = await self.client.responses_stream_text(
            {
                "model": self.model,
                "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": prompt}, {"type": "input_image", "image_url": url}]}],
                "metadata": {"mask_encoding": "one_bit", "include_confidence": "true"},
            },
            op="segmentation",
            input_ref=f"{ref} prompt={prompt!r}".strip(),
        )
        self.client.usage.get(self.model).images += 1
        try:
            return parse_sam_output(text, width, height, complete=not final.get("_incomplete")), latency
        except Exception as e:  # a malformed payload is the provider's failure, not a crash
            raise MetaAPIError(502, f"could not parse SAM output: {e}") from e
