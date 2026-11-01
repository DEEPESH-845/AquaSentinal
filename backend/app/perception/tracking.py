"""Application-level track association. SAM keeps ids only within one response; persistent identity is ours.

An observation joins an existing asset when it lies within GATE_CM of the asset centre, or inside the asset's footprint,
and the labels are compatible: equal, or one of them uncertain (confidence below the classify threshold). Each asset keeps
two confidence-weighted vote tallies, certain and uncertain. The asset label is the top certain label if any certain vote
exists, otherwise the top uncertain one, so two doubtful "loose_cable" sightings never outvote one confident "debris".
That mirrors the twin, which judges an object by its best observation. Assets persist across missions, which is how the
same object keeps its id between inspections.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from ..db import Repository, new_id
from ..schemas import Asset

GATE_CM = 6.0
UNCERTAIN = 0.65  # lib/sim/constants.ts DETECTION.classifyThreshold


@dataclass
class Sighting:
    label: str
    x: float
    y: float
    w: float
    h: float
    confidence: float | None  # None: the source gave no confidence (treated as certain for association)


def _certain(c: float | None) -> bool:
    return c is None or c >= UNCERTAIN


class Tracker:
    def __init__(self, repo: Repository):
        self.repo = repo

    def associate(self, mission_id: str, s: Sighting, now: float | None = None) -> Asset:
        now = now or time.time()
        best, best_d = None, float("inf")
        for a in self.repo.asset_rows():
            d = ((a["x"] - s.x) ** 2 + (a["y"] - s.y) ** 2) ** 0.5
            inside = abs(a["x"] - s.x) <= a["w"] / 2 + 2 and abs(a["y"] - s.y) <= a["h"] / 2 + 2
            if d > GATE_CM and not inside:
                continue
            if a["label"] != s.label and _certain(s.confidence) and a["labels"].get("certain"):
                continue
            if d < best_d:
                best, best_d = a, d
        kind = "certain" if _certain(s.confidence) else "uncertain"
        votes = {k: dict(best["labels"].get(k, {})) if best else {} for k in ("certain", "uncertain")}
        votes[kind][s.label] = votes[kind].get(s.label, 0.0) + (s.confidence if s.confidence is not None else 1.0)
        tally = votes["certain"] or votes["uncertain"]
        label = max(tally, key=tally.__getitem__)
        if best is None:
            asset = Asset(id=new_id("asset"), label=label, x=round(s.x, 2), y=round(s.y, 2), observations=1, first_seen=now, last_seen=now, missions=[mission_id])
            self.repo.upsert_asset(asset, s.w, s.h, votes)
            return asset
        n = best["observations"]
        missions = best["missions"] if mission_id in best["missions"] else [*best["missions"], mission_id]
        asset = Asset(
            id=best["id"],
            label=label,
            x=round((best["x"] * n + s.x) / (n + 1), 2),
            y=round((best["y"] * n + s.y) / (n + 1), 2),
            observations=n + 1,
            first_seen=best["first_seen"],
            last_seen=now,
            missions=missions,
        )
        self.repo.upsert_asset(asset, max(best["w"], s.w), max(best["h"], s.h), votes)
        return asset
