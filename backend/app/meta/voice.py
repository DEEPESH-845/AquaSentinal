"""Muse Voice Transcribe, file endpoint. https://dev.meta.ai/docs/api-reference/voice/transcribe

Speech to text only. It does not synthesise speech; AquaSentinal never presents it as doing so.
"""

from __future__ import annotations

import io
import json
import wave

from .client import MetaAPIError, MetaClient

# Vocabulary biasing for the inspection domain (Transcribe Request `keywords`).
KEYWORDS = ["gantry", "pipeline", "turbidity", "inspection", "carriage", "debris", "object tracking", "segment", "scan", "waypoint", "flange", "valve", "loose cable"]
MAX_BYTES = 32 * 1024 * 1024
MAX_SECONDS = 600


def validate_wav(data: bytes) -> float:
    """The endpoint accepts mono 16-bit PCM WAV at 16 or 24 kHz, at most 10 minutes and 32 MB. Returns the duration."""
    if len(data) > MAX_BYTES:
        raise MetaAPIError(413, "audio exceeds 32 MB")
    try:
        with wave.open(io.BytesIO(data)) as w:
            channels, width, rate, frames = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
    except (wave.Error, EOFError) as e:
        raise MetaAPIError(400, f"not a WAV file: {e}") from e
    if channels != 1 or width != 2 or rate not in (16000, 24000):
        raise MetaAPIError(400, f"WAV must be mono 16-bit PCM at 16 or 24 kHz (got {channels} ch, {width * 8}-bit, {rate} Hz)")
    seconds = frames / rate
    if seconds > MAX_SECONDS:
        raise MetaAPIError(400, "audio exceeds 10 minutes")
    if seconds < 0.2:
        raise MetaAPIError(400, "audio is shorter than 0.2 s")
    return seconds


class Voice:
    def __init__(self, client: MetaClient, model: str):
        self.client = client
        self.model = model

    async def transcribe(self, wav: bytes) -> tuple[dict, float]:
        validate_wav(wav)
        request = {"model": self.model, "audioEncoding": "WAV", "mode": "PUSH_TO_TALK", "keywords": KEYWORDS, "languageBias": ["English"]}
        body, latency = await self.client.multipart(
            "/asr/transcribe",
            self.model,
            {"request": (None, json.dumps(request), "application/json"), "audio": ("command.wav", wav, "audio/wav")},
        )
        self.client.usage.get(self.model).audio_ms += int(body.get("audioDurationMs") or 0)
        return body, latency
