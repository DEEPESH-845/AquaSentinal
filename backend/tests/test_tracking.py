"""Track association: the label rule mirrors the twin, which judges each object by its best observation."""

from pathlib import Path

import pytest

from app.db import Repository
from app.perception.tracking import Sighting, Tracker


@pytest.fixture
def tracker(tmp_path: Path):
    repo = Repository(":memory:", tmp_path)
    yield Tracker(repo)
    repo.close()


def see(t: Tracker, label: str, conf: float | None, x: float = 50, y: float = 20, mission: str = "m1"):
    return t.associate(mission, Sighting(label=label, x=x, y=y, w=4, h=4, confidence=conf))


def test_two_uncertain_cables_do_not_outvote_one_confident_debris(tracker: Tracker):
    see(tracker, "loose_cable", 0.62)
    a = see(tracker, "loose_cable", 0.64)
    assert a.label == "loose_cable"  # nothing certain yet, so the top uncertain label stands
    b = see(tracker, "debris", 0.70)
    assert b.id == a.id and b.label == "debris" and b.observations == 3
    assert [x.label for x in tracker.repo.assets()] == ["debris"]
    assert see(tracker, "loose_cable", 0.60).label == "debris"  # a later doubtful sighting cannot flip it back


def test_confident_sightings_of_different_classes_at_one_spot_stay_separate(tracker: Tracker):
    v = see(tracker, "valve", 0.9)
    p = see(tracker, "pipe_segment", 0.9)
    assert v.id != p.id
    assert see(tracker, "valve", 0.8).id == v.id
    assert {a.label for a in tracker.repo.assets()} == {"valve", "pipe_segment"}


def test_asset_persists_across_missions(tracker: Tracker):
    a = see(tracker, "debris", 0.9, mission="m1")
    b = see(tracker, "debris", 0.85, x=51, mission="m2")
    assert b.id == a.id and b.missions == ["m1", "m2"]
