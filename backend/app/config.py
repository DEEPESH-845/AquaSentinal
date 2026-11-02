"""Runtime configuration from the environment. Secrets are read here and never logged or returned by any route."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

AppMode = Literal["SIMULATION", "HARDWARE"]

REPO_ROOT = Path(__file__).resolve().parents[2]
SHARED_DIR = REPO_ROOT / "shared"


def _bool(name: str, default: bool = False) -> bool:
    return os.environ.get(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    model_api_key: str = field(default="", repr=False)
    meta_base_url: str = "https://api.meta.ai/v1"
    spark_model: str = "muse-spark-1.3"
    sam_model: str = "sam-3.1"
    voice_model: str = "muse-voice-transcribe-1.0"
    app_mode: AppMode = "SIMULATION"
    hardware_enable: bool = False
    serial_port: str = ""
    serial_baud: int = 115200
    camera_device: str = ""
    database_url: str = "sqlite:///./aquasentinal.db"
    data_dir: Path = Path("./data")
    cors_origins: tuple[str, ...] = ("http://localhost:3000", "http://127.0.0.1:3000")
    # optional full-match pattern for origins that are not known in advance, such as Vercel preview deployments
    cors_origin_regex: str = ""
    request_timeout_s: float = 30.0
    max_retries: int = 3
    sam_concurrency: int = 2
    max_sam_requests_per_mission: int = 60
    max_spark_calls_per_mission: int = 12

    @property
    def meta_available(self) -> bool:
        return bool(self.model_api_key)

    @property
    def sqlite_path(self) -> str:
        if not self.database_url.startswith("sqlite:///"):
            raise ValueError("only sqlite:/// DATABASE_URLs are supported by this build (see docs/ARCHITECTURE.md)")
        return self.database_url.removeprefix("sqlite:///")

    def public(self) -> dict:
        """Everything a browser may see. No key, no paths."""
        return {
            "appMode": self.app_mode,
            "hardwareEnabled": self.hardware_enable,
            "metaBaseUrl": self.meta_base_url,
            "models": {"spark": self.spark_model, "sam": self.sam_model, "voice": self.voice_model},
            "metaConfigured": self.meta_available,
            "limits": {
                "samConcurrency": self.sam_concurrency,
                "maxSamRequestsPerMission": self.max_sam_requests_per_mission,
                "maxSparkCallsPerMission": self.max_spark_calls_per_mission,
                "requestTimeoutS": self.request_timeout_s,
            },
        }


def load_settings() -> Settings:
    mode = os.environ.get("APP_MODE", "SIMULATION").strip().upper()
    if mode not in ("SIMULATION", "HARDWARE"):
        mode = "SIMULATION"
    origins = tuple(o.strip().rstrip("/") for o in os.environ.get("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",") if o.strip())
    return Settings(
        model_api_key=os.environ.get("MODEL_API_KEY", "").strip(),
        meta_base_url=os.environ.get("META_MODEL_API_BASE_URL", "https://api.meta.ai/v1").rstrip("/"),
        spark_model=os.environ.get("META_SPARK_MODEL", "muse-spark-1.3"),
        sam_model=os.environ.get("META_SAM_MODEL", "sam-3.1"),
        voice_model=os.environ.get("META_VOICE_MODEL", "muse-voice-transcribe-1.0"),
        app_mode=mode,  # type: ignore[arg-type]
        hardware_enable=_bool("AQUA_HARDWARE_ENABLE"),
        serial_port=os.environ.get("AQUA_SERIAL_PORT", ""),
        serial_baud=int(os.environ.get("AQUA_SERIAL_BAUD", "115200") or 115200),
        camera_device=os.environ.get("AQUA_CAMERA_DEVICE", ""),
        database_url=os.environ.get("DATABASE_URL", "sqlite:///./aquasentinal.db"),
        data_dir=Path(os.environ.get("AQUA_DATA_DIR", "./data")),
        cors_origins=origins,
        cors_origin_regex=os.environ.get("CORS_ORIGIN_REGEX", "").strip(),
        request_timeout_s=_float("META_REQUEST_TIMEOUT_S", 30.0),
        max_retries=int(os.environ.get("META_MAX_RETRIES", "3") or 3),
    )
