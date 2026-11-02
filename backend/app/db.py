"""Inspection storage on SQLite (stdlib sqlite3).

Repository is the only class that writes SQL. Everything above it speaks Pydantic models, so a PostgreSQL implementation
is a second class with the same methods. Frames live on disk under the data directory; rows hold their paths.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from .schemas import Asset, MissionRecord, Observation, Segmentation

SCHEMA = """
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY, created_at REAL NOT NULL, status TEXT NOT NULL, provider TEXT NOT NULL, record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS captures (
  id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, seq INTEGER NOT NULL, created_at REAL NOT NULL,
  meta TEXT NOT NULL, quality TEXT, reasoning TEXT, frame_path TEXT, idmask_path TEXT, fingerprint TEXT, duplicate_of TEXT
);
CREATE INDEX IF NOT EXISTS captures_mission ON captures(mission_id, seq);
CREATE TABLE IF NOT EXISTS segmentations (
  id TEXT PRIMARY KEY, capture_id TEXT NOT NULL, created_at REAL NOT NULL, record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS seg_capture ON segmentations(capture_id);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL, labels TEXT NOT NULL,
  observations INTEGER NOT NULL, first_seen REAL NOT NULL, last_seen REAL NOT NULL, missions TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, capture_id TEXT, asset_id TEXT NOT NULL, created_at REAL NOT NULL, record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS obs_mission ON observations(mission_id);
CREATE TABLE IF NOT EXISTS summaries (
  mission_id TEXT PRIMARY KEY, created_at REAL NOT NULL, record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_executions (
  id TEXT PRIMARY KEY, created_at REAL NOT NULL, model TEXT NOT NULL, classification TEXT NOT NULL, record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS exe_created ON model_executions(created_at);
"""


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class Repository:
    def __init__(self, path: str, data_dir: Path):
        self.data_dir = data_dir
        (data_dir / "frames").mkdir(parents=True, exist_ok=True)
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL") if path != ":memory:" else None
        self._db.executescript(SCHEMA)
        self._lock = threading.Lock()

    def close(self) -> None:
        self._db.close()

    def ping(self) -> bool:
        try:
            self._db.execute("SELECT 1").fetchone()
            return True
        except sqlite3.Error:
            return False

    def _exec(self, sql: str, args: tuple = ()) -> None:
        with self._lock:
            self._db.execute(sql, args)
            self._db.commit()

    def _all(self, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._db.execute(sql, args).fetchall()

    # ---------------------------------------------------------------- missions

    def save_mission(self, m: MissionRecord) -> None:
        self._exec(
            "INSERT INTO missions(id, created_at, status, provider, record) VALUES (?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET status=excluded.status, record=excluded.record",
            (m.id, m.created_at, m.status, m.provider, m.model_dump_json(by_alias=True)),
        )

    def get_mission(self, mission_id: str) -> MissionRecord | None:
        rows = self._all("SELECT record FROM missions WHERE id=?", (mission_id,))
        return MissionRecord.model_validate_json(rows[0]["record"]) if rows else None

    def list_missions(self, limit: int = 50) -> list[MissionRecord]:
        rows = self._all("SELECT record FROM missions ORDER BY created_at DESC LIMIT ?", (limit,))
        return [MissionRecord.model_validate_json(r["record"]) for r in rows]

    # ---------------------------------------------------------------- captures

    def frame_dir(self, mission_id: str) -> Path:
        safe = "".join(c for c in mission_id if c.isalnum() or c in "-_") or "unknown"
        d = self.data_dir / "frames" / safe
        d.mkdir(parents=True, exist_ok=True)
        return d

    def save_capture(self, capture_id: str, mission_id: str, seq: int, meta: dict[str, Any], frame: Path, idmask: Path | None, fingerprint: str, duplicate_of: str | None) -> None:
        self._exec(
            "INSERT INTO captures(id, mission_id, seq, created_at, meta, frame_path, idmask_path, fingerprint, duplicate_of) VALUES (?,?,?,?,?,?,?,?,?)",
            (capture_id, mission_id, seq, time.time(), json.dumps(meta), str(frame), str(idmask) if idmask else None, fingerprint, duplicate_of),
        )

    def update_capture(self, capture_id: str, *, quality: dict | None = None, reasoning: dict | None = None) -> None:
        if quality is not None:
            self._exec("UPDATE captures SET quality=? WHERE id=?", (json.dumps(quality), capture_id))
        if reasoning is not None:
            self._exec("UPDATE captures SET reasoning=? WHERE id=?", (json.dumps(reasoning), capture_id))

    def get_capture(self, capture_id: str) -> dict[str, Any] | None:
        rows = self._all("SELECT * FROM captures WHERE id=?", (capture_id,))
        return _capture_row(rows[0]) if rows else None

    def captures_for(self, mission_id: str) -> list[dict[str, Any]]:
        return [_capture_row(r) for r in self._all("SELECT * FROM captures WHERE mission_id=? ORDER BY seq", (mission_id,))]

    def last_capture(self, mission_id: str) -> dict[str, Any] | None:
        rows = self._all("SELECT * FROM captures WHERE mission_id=? ORDER BY seq DESC LIMIT 1", (mission_id,))
        return _capture_row(rows[0]) if rows else None

    # ---------------------------------------------------------------- segmentations

    def save_segmentation(self, s: Segmentation) -> None:
        self._exec("INSERT OR REPLACE INTO segmentations(id, capture_id, created_at, record) VALUES (?,?,?,?)", (s.id, s.capture_id, time.time(), s.model_dump_json(by_alias=True)))

    def segmentations_for(self, capture_id: str) -> list[Segmentation]:
        return [Segmentation.model_validate_json(r["record"]) for r in self._all("SELECT record FROM segmentations WHERE capture_id=? ORDER BY created_at", (capture_id,))]

    # ---------------------------------------------------------------- assets and observations

    def assets(self) -> list[Asset]:
        rows = self._all("SELECT * FROM assets ORDER BY first_seen")
        return [
            Asset(id=r["id"], label=r["label"], x=r["x"], y=r["y"], observations=r["observations"], first_seen=r["first_seen"], last_seen=r["last_seen"], missions=json.loads(r["missions"]))
            for r in rows
        ]

    def asset_rows(self) -> list[dict[str, Any]]:
        """Assets with the association state the tracker needs: extent and the certain/uncertain confidence-weighted label tallies."""
        return [{**dict(r), "labels": json.loads(r["labels"]), "missions": json.loads(r["missions"])} for r in self._all("SELECT * FROM assets")]

    def upsert_asset(self, asset: Asset, w: float, h: float, labels: dict[str, dict[str, float]]) -> None:
        self._exec(
            "INSERT INTO assets(id, label, x, y, w, h, labels, observations, first_seen, last_seen, missions) VALUES (?,?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET label=excluded.label, x=excluded.x, y=excluded.y, w=excluded.w, h=excluded.h, labels=excluded.labels, "
            "observations=excluded.observations, last_seen=excluded.last_seen, missions=excluded.missions",
            (asset.id, asset.label, asset.x, asset.y, w, h, json.dumps(labels), asset.observations, asset.first_seen, asset.last_seen, json.dumps(asset.missions)),
        )

    def save_observation(self, o: Observation) -> None:
        self._exec(
            "INSERT INTO observations(id, mission_id, capture_id, asset_id, created_at, record) VALUES (?,?,?,?,?,?)",
            (o.id, o.mission_id, o.capture_id, o.asset_id, o.created_at, o.model_dump_json(by_alias=True)),
        )

    def observations_for(self, mission_id: str) -> list[Observation]:
        return [Observation.model_validate_json(r["record"]) for r in self._all("SELECT record FROM observations WHERE mission_id=? ORDER BY created_at", (mission_id,))]

    # ---------------------------------------------------------------- summaries

    def save_summary(self, mission_id: str, summary: dict[str, Any]) -> None:
        self._exec("INSERT OR REPLACE INTO summaries(mission_id, created_at, record) VALUES (?,?,?)", (mission_id, time.time(), json.dumps(summary)))

    def save_execution(self, rec: dict[str, Any]) -> None:
        """One Meta model request: references, timing, outcome and LIVE_META / LIVE_META_FAILED / MOCKED. Never content or keys."""
        self._exec(
            "INSERT OR REPLACE INTO model_executions VALUES (?,?,?,?,?)", (rec["id"], time.time(), rec["model"], rec["classification"], json.dumps(rec))
        )

    def executions(self, limit: int = 200) -> list[dict[str, Any]]:
        rows = self._all("SELECT record FROM model_executions ORDER BY created_at DESC LIMIT ?", (limit,))
        return [json.loads(r["record"]) for r in rows]

    def execution_counts(self) -> dict[str, int]:
        return {r["classification"]: r["n"] for r in self._all("SELECT classification, COUNT(*) AS n FROM model_executions GROUP BY classification")}

    def get_summary(self, mission_id: str) -> dict[str, Any] | None:
        rows = self._all("SELECT record FROM summaries WHERE mission_id=?", (mission_id,))
        return json.loads(rows[0]["record"]) if rows else None


def _capture_row(r: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": r["id"],
        "mission_id": r["mission_id"],
        "seq": r["seq"],
        "created_at": r["created_at"],
        "meta": json.loads(r["meta"]),
        "quality": json.loads(r["quality"]) if r["quality"] else None,
        "reasoning": json.loads(r["reasoning"]) if r["reasoning"] else None,
        "frame_path": r["frame_path"],
        "idmask_path": r["idmask_path"],
        "fingerprint": r["fingerprint"],
        "duplicate_of": r["duplicate_of"],
    }
