"""Capture processing. docs/PERCEPTION_PIPELINE.md.

frame -> image quality -> environment estimate -> Muse Spark frame reasoning -> SAM 3.1 segmentation
      -> track association -> observations -> evidence storage

With Meta credentials, observations come from SAM 3.1 masks (prompts from Muse Spark, cached per mission).
Without them, observations come from the twin's simulated detector and are labelled SIM_DETECTOR; the offline overlay
masks are the twin's own geometry for those detections and are labelled OFFLINE_FIXTURE. Nothing offline is presented
as model output.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from ..config import Settings
from ..db import Repository, new_id
from ..events import EventBus
from ..geometry import footprint_half_cm, pixel_to_gantry
from ..meta.client import MetaAPIError
from ..meta.sam import Sam, SamInstance
from ..meta.spark import Spark
from ..schemas import (
    ANOMALY_CANDIDATE_CLASSES,
    TYPE_TO_TARGET,
    CaptureMeta,
    CaptureResult,
    FrameReasoning,
    Observation,
    SegInstance,
    Segmentation,
)
from .quality import analyze, decode, fingerprint, is_duplicate
from .queue import BudgetExhausted, InferenceQueue
from .tracking import UNCERTAIN, Sighting, Tracker

log = logging.getLogger("aquasentinal.perception")

# Used only when Muse Spark reasoning fails or returns nothing: one concrete noun phrase per target class.
FALLBACK_PHRASES: dict[str, str] = {
    "loose_cable": "cable",
    "foreign_object": "debris",
    "pipe_joint": "pipe flange",
    "valve": "valve",
    "pipe_segment": "pipe",
    "inspection_panel": "concrete slab",
    "debris": "rock",
}
MAX_PHRASES = 3


def mask_polygons(mask: np.ndarray, epsilon: float = 1.2) -> list[list[tuple[int, int]]]:
    """Compact mask geometry for the browser: simplified outer contours, largest first, at most 4."""
    contours, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:4]
    out = []
    for c in contours:
        if cv2.contourArea(c) < 4:
            continue
        approx = cv2.approxPolyDP(c, epsilon, True)
        out.append([(int(p[0][0]), int(p[0][1])) for p in approx])
    return out


def decode_id_mask(png: bytes, width: int, height: int) -> np.ndarray | None:
    """The twin's ID pass: red channel = object index (multiples of 4, so a few levels of rounding never alias)."""
    img = cv2.imdecode(np.frombuffer(png, dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None or img.shape[:2] != (height, width):
        return None
    return np.rint(img[..., 2].astype(np.float32) / 4).astype(np.int32)


@dataclass
class MissionPerceptionState:
    phrases: list[dict] = field(default_factory=list)
    reasoned: bool = False


class PerceptionPipeline:
    def __init__(self, settings: Settings, repo: Repository, events: EventBus, spark: Spark | None, sam: Sam | None):
        self.settings = settings
        self.repo = repo
        self.events = events
        self.spark = spark
        self.sam = sam
        self.tracker = Tracker(repo)
        self.queue = InferenceQueue(settings.sam_concurrency, settings.request_timeout_s + 5)
        self._missions: dict[str, MissionPerceptionState] = {}
        self._prints: dict[str, tuple[str, np.ndarray, tuple[float, float]]] = {}

    @property
    def live(self) -> bool:
        return self.sam is not None and self.spark is not None

    def cancel(self, mission_id: str) -> int:
        return self.queue.cancel_mission(mission_id)

    async def process(self, meta: CaptureMeta, jpeg: bytes, idmask_png: bytes | None) -> CaptureResult:
        img = decode(jpeg)
        h, w = img.shape[:2]
        capture_id = new_id("cap")
        notes: list[str] = []

        # Evidence first: the frame is stored before any remote call can fail.
        d = self.repo.frame_dir(meta.mission_id)
        frame_path = d / f"{meta.seq:04d}_{capture_id}.jpg"
        frame_path.write_bytes(jpeg)
        idmask_path: Path | None = None
        ids = None
        if idmask_png:
            ids = decode_id_mask(idmask_png, w, h)
            if ids is not None:
                idmask_path = d / f"{meta.seq:04d}_{capture_id}_ids.png"
                idmask_path.write_bytes(idmask_png)
            else:
                notes.append("ID mask ignored: size mismatch or undecodable")

        fp = fingerprint(img)
        duplicate_of = None
        prev = self._prints.get(meta.mission_id)
        if prev and is_duplicate(prev[1], fp) and abs(prev[2][0] - meta.gantry_x) < 0.5 and abs(prev[2][1] - meta.gantry_y) < 0.5:
            duplicate_of = prev[0]
            notes.append(f"near-duplicate of {prev[0]}: segmentation reused, no new model request")
        self._prints[meta.mission_id] = (capture_id, fp, (meta.gantry_x, meta.gantry_y))
        self.repo.save_capture(capture_id, meta.mission_id, meta.seq, meta.model_dump(by_alias=True), frame_path, idmask_path, hashlib.sha1(fp.tobytes()).hexdigest(), duplicate_of)

        quality = analyze(img)
        self.repo.update_capture(capture_id, quality=quality.model_dump(by_alias=True))

        reasoning: FrameReasoning | None = None
        segmentations: list[Segmentation] = []
        observations: list[Observation] = []

        if not meta.camera_online:
            notes.append("camera offline: nothing to analyse")
        elif duplicate_of:
            for s in self.repo.segmentations_for(duplicate_of):
                reused = s.model_copy(update={"id": new_id("seg"), "capture_id": capture_id, "status": "REUSED", "latency_ms": None})
                self.repo.save_segmentation(reused)
                segmentations.append(reused)
        elif self.live:
            reasoning, segmentations, observations = await self._live(meta, capture_id, jpeg, w, h, ids)
        else:
            segmentations, observations = self._offline(meta, capture_id, w, h, ids)
            reasoning = FrameReasoning(provider="UNAVAILABLE", scene_summary="", phrases=[], error="MODEL_API_KEY not configured")

        if reasoning:
            self.repo.update_capture(capture_id, reasoning=reasoning.model_dump(by_alias=True))
        result = CaptureResult(
            capture_id=capture_id,
            mission_id=meta.mission_id,
            seq=meta.seq,
            quality=quality,
            reasoning=reasoning,
            segmentations=segmentations,
            observations=observations,
            duplicate_of=duplicate_of,
            notes=notes,
        )
        await self.events.publish("capture.processed", result.model_dump(by_alias=True, mode="json"))
        return result

    # ------------------------------------------------------------ live (Meta models)

    async def _reason(self, meta: CaptureMeta, jpeg: bytes) -> FrameReasoning:
        st = self._missions.setdefault(meta.mission_id, MissionPerceptionState())
        targets = list(meta.targets) or ["loose_cable", "foreign_object"]
        if meta.prompts:
            st.phrases = [{"phrase": p, "target_class": None, "rationale": "operator prompt"} for p in meta.prompts]
            return FrameReasoning(provider="MUSE_SPARK", scene_summary="operator-supplied prompts", phrases=st.phrases)
        if st.reasoned:
            return FrameReasoning(provider="MUSE_SPARK", scene_summary="phrases cached from the first frame of this mission", phrases=st.phrases)
        try:
            self.queue.charge(meta.mission_id, "spark", self.settings.max_spark_calls_per_mission)
            data, latency = await self.queue.run(meta.mission_id, f"spark:{meta.mission_id}", lambda: self.spark.analyze_frame(jpeg, targets))  # type: ignore[union-attr]
            phrases = [p for p in data.get("phrases", []) if isinstance(p, dict) and str(p.get("phrase", "")).strip()][:MAX_PHRASES]
            # A target the model did not mention still gets its fallback phrase, so a missed concept is still searched for.
            named = {p.get("target_class") for p in phrases}
            for t in targets:
                if t not in named and len(phrases) < MAX_PHRASES:
                    phrases.append({"phrase": FALLBACK_PHRASES[t], "target_class": t, "rationale": "fallback phrase for an unmentioned target"})
            st.phrases, st.reasoned = phrases, True
            return FrameReasoning(provider="MUSE_SPARK", scene_summary=str(data.get("scene_summary", ""))[:500], phrases=phrases, latency_ms=round(latency, 1))
        except (MetaAPIError, BudgetExhausted, asyncio.TimeoutError) as e:
            st.phrases = [{"phrase": FALLBACK_PHRASES[t], "target_class": t, "rationale": "fallback: frame reasoning failed"} for t in targets][:MAX_PHRASES]
            return FrameReasoning(provider="UNAVAILABLE", scene_summary="", phrases=st.phrases, error=str(e)[:300])

    async def _segment_one(self, meta: CaptureMeta, capture_id: str, jpeg: bytes, w: int, h: int, ids: np.ndarray | None, phrase: dict) -> Segmentation:
        prompt = str(phrase["phrase"]).strip()[:60]
        target = phrase.get("target_class")
        seg_id = new_id("seg")
        try:
            self.queue.charge(meta.mission_id, "sam", self.settings.max_sam_requests_per_mission)
        except BudgetExhausted as e:
            return Segmentation(id=seg_id, capture_id=capture_id, provider="SAM_3_1", prompt=prompt, status="SKIPPED_BUDGET", latency_ms=None, error=str(e), instances=[])
        key = f"sam:{hashlib.sha1(jpeg).hexdigest()}:{prompt}"
        try:
            instances, latency = await self.queue.run(meta.mission_id, key, lambda: self.sam.segment(jpeg, prompt, w, h))  # type: ignore[union-attr]
        except asyncio.CancelledError:
            raise
        except (MetaAPIError, asyncio.TimeoutError) as e:
            msg = str(e) or "timed out"
            return Segmentation(id=seg_id, capture_id=capture_id, provider="SAM_3_1", prompt=prompt, status="FAILED", latency_ms=None, error=msg[:300], instances=[])
        out = [self._instance(meta, f"{seg_id}:{inst.object_id}", prompt, target, inst, w, h, ids) for inst in instances]
        return Segmentation(id=seg_id, capture_id=capture_id, provider="SAM_3_1", prompt=prompt, status="OK" if out else "EMPTY", latency_ms=round(latency, 1), error=None, instances=out)

    def _instance(self, meta: CaptureMeta, iid: str, prompt: str, target: str | None, inst: SamInstance, w: int, h: int, ids: np.ndarray | None) -> SegInstance:
        x0, y0, x1, y1 = inst.box
        wx, wy = pixel_to_gantry((x0 + x1) / 2, (y0 + y1) / 2, w, h, meta.gantry_x, meta.gantry_y)
        matched, iou = None, None
        if ids is not None and meta.id_map:
            # Evaluation only: IoU of the SAM mask against the twin's ground-truth silhouettes.
            best = 0.0
            for e in meta.id_map:
                truth = ids == e.index
                union = np.logical_or(truth, inst.mask).sum()
                if union == 0:
                    continue
                score = float(np.logical_and(truth, inst.mask).sum() / union)
                if score > best:
                    best, matched = score, e.object_id
            iou = round(best, 4) if matched else None
        return SegInstance(
            instance_id=iid,
            prompt=prompt,
            target_class=target,  # type: ignore[arg-type]
            box=(x0, y0, x1, y1),
            confidence=inst.confidence,
            area_px=int(inst.mask.sum()),
            polygons=mask_polygons(inst.mask),
            world_x=round(wx, 2),
            world_y=round(wy, 2),
            matched_object_id=matched,
            iou=iou,
        )

    async def _live(self, meta: CaptureMeta, capture_id: str, jpeg: bytes, w: int, h: int, ids: np.ndarray | None):
        reasoning = await self._reason(meta, jpeg)
        await self.events.publish("segmentation.started", {"captureId": capture_id, "prompts": [p["phrase"] for p in reasoning.phrases]})
        segs = await asyncio.gather(*(self._segment_one(meta, capture_id, jpeg, w, h, ids, p) for p in reasoning.phrases))
        observations: list[Observation] = []
        px_per_cm = w / (2 * footprint_half_cm()[0])  # sand-plane scale at the nadir
        for s in segs:
            self.repo.save_segmentation(s)
            for inst in s.instances:
                label = inst.target_class or "debris"
                bw = (inst.box[2] - inst.box[0]) / px_per_cm
                bh = (inst.box[3] - inst.box[1]) / px_per_cm
                observations.append(self._observe(meta, capture_id, "SAM_3_1", label, inst.world_x, inst.world_y, bw, bh, inst.confidence))
        return reasoning, list(segs), observations

    # ------------------------------------------------------------ offline (no credentials)

    def _offline(self, meta: CaptureMeta, capture_id: str, w: int, h: int, ids: np.ndarray | None):
        targets = set(meta.targets)
        if meta.perception_fault == "SEGMENTATION_FAILURE":
            seg = Segmentation(
                id=new_id("seg"), capture_id=capture_id, provider="OFFLINE_FIXTURE", prompt="(fixture)", status="FAILED", latency_ms=None,
                error="segmentation failure injected by scenario G (test fixture)", instances=[],
            )
            self.repo.save_segmentation(seg)
            segs = [seg]
        else:
            instances = []
            index = {e.object_id: e for e in meta.id_map}
            for det in meta.detections:
                target = TYPE_TO_TARGET.get(det.cls)
                e = index.get(det.object_id)
                if ids is None or e is None or target is None or target not in targets:
                    continue
                mask = ids == e.index
                if not mask.any():
                    continue
                ys, xs = np.nonzero(mask)
                box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
                instances.append(
                    SegInstance(
                        instance_id=f"fixture:{det.object_id}", prompt=FALLBACK_PHRASES[target], target_class=target, box=box, confidence=None,  # type: ignore[arg-type]
                        area_px=int(mask.sum()), polygons=mask_polygons(mask), world_x=round(det.est_x, 2), world_y=round(det.est_y, 2), matched_object_id=det.object_id, iou=None,
                    )
                )
            seg = Segmentation(
                id=new_id("seg"), capture_id=capture_id, provider="OFFLINE_FIXTURE", prompt="(twin geometry for simulated-detector hits)",
                status="OK" if instances else "EMPTY", latency_ms=None, error=None, instances=instances,
            )
            self.repo.save_segmentation(seg)
            segs = [seg]
        observations = []
        px_per_cm = w / (2 * footprint_half_cm()[0])  # sand-plane scale at the nadir
        for det in meta.detections:
            label = TYPE_TO_TARGET.get(det.cls, "unknown") if det.cls != "UNKNOWN" else "unknown"
            observations.append(self._observe(meta, capture_id, "SIM_DETECTOR", label, det.est_x, det.est_y, det.bbox[2] * w / px_per_cm, det.bbox[3] * h / px_per_cm, det.confidence))
        return segs, observations

    # ------------------------------------------------------------ shared

    def _observe(self, meta: CaptureMeta, capture_id: str, source: str, label: str, x: float, y: float, bw: float, bh: float, conf: float | None) -> Observation:
        asset = self.tracker.associate(meta.mission_id, Sighting(label=label, x=x, y=y, w=bw, h=bh, confidence=conf))
        if label in ANOMALY_CANDIDATE_CLASSES:
            status = "UNVERIFIED_ANOMALY_CANDIDATE"
        elif conf is not None and conf < UNCERTAIN:
            status = "LOW_CONFIDENCE"
        else:
            status = "OBSERVED"
        o = Observation(
            id=new_id("obs"), mission_id=meta.mission_id, capture_id=capture_id, asset_id=asset.id, source=source, label=label,  # type: ignore[arg-type]
            confidence=conf, confidence_source=source if conf is not None else None,  # type: ignore[arg-type]
            x=round(x, 2), y=round(y, 2), status=status, created_at=time.time(),  # type: ignore[arg-type]
        )
        self.repo.save_observation(o)
        return o
