"""Shared test fixtures. No test makes a network request: Meta is a mocked httpx transport, serial is a fake GRBL."""

from __future__ import annotations

import json
import threading
from collections import deque
from dataclasses import replace
from pathlib import Path
from typing import Any

import cv2
import httpx
import numpy as np
import pytest
from meta_sam_parser._mask_codec import _encode_raster

from app.config import Settings

FAKE_KEY = "LLM_test_0000_not-a-real-secret"
DEMO_INSTRUCTION = (
    "Inspect the submerged pipeline from left to right. Identify loose cables and foreign objects. Track any relevant objects "
    "and record their coordinates. Reduce scanning speed when visibility deteriorates and stop if visibility becomes unreliable."
)


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(database_url=f"sqlite:///{tmp_path / 'test.db'}", data_dir=tmp_path / "data", request_timeout_s=5.0)


@pytest.fixture
def live_settings(settings: Settings) -> Settings:
    return replace(settings, model_api_key=FAKE_KEY)


# ---------------------------------------------------------------- Meta mock


class MetaMock:
    """Queues responses per path and records every request, so tests can assert exact payloads."""

    def __init__(self) -> None:
        self.queues: dict[str, deque[Any]] = {}
        self.requests: list[httpx.Request] = []

    def add(self, path: str, response: Any) -> None:
        self.queues.setdefault(path, deque()).append(response)

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path.removeprefix("/v1")
        q = self.queues.get(path)
        if not q:
            return httpx.Response(500, json={"error": {"message": f"no mock queued for {path}", "type": "server_error"}})
        r = q.popleft()
        if isinstance(r, Exception):
            raise r
        if callable(r):
            return r(request)
        return r

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)

    def bodies(self, path: str) -> list[dict]:
        return [json.loads(r.content) for r in self.requests if r.url.path.endswith(path) and r.headers.get("content-type", "").startswith("application/json")]


@pytest.fixture
def meta() -> MetaMock:
    return MetaMock()


def chat_tool_call(name: str, args: dict, call_id: str = "call_1", content: str = "") -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "id": "chatcmpl-test",
            "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {"role": "assistant", "content": content, "tool_calls": [{"id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]}}],
            "usage": {"prompt_tokens": 120, "completion_tokens": 40, "total_tokens": 160},
        },
    )


def chat_json(obj: dict) -> httpx.Response:
    return httpx.Response(
        200,
        json={"choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": json.dumps(obj)}}], "usage": {"prompt_tokens": 900, "completion_tokens": 80, "total_tokens": 980}},
    )


def sse(lines: list[str], *, completed: bool = True) -> httpx.Response:
    events = [{"type": "response.created", "response": {"id": "resp_1"}}]
    events += [{"type": "response.output_text.delta", "delta": line} for line in lines]
    if completed:
        events.append({"type": "response.completed", "response": {"id": "resp_1", "status": "completed", "usage": {"images_processed": 1}}})
    body = "".join(f"data: {json.dumps(e)}\n\n" for e in events) + "data: [DONE]\n\n"
    return httpx.Response(200, content=body.encode(), headers={"content-type": "text/event-stream"})


def sam_line(object_id: int, mask: np.ndarray, conf: float | None, frame_w: int = 640, frame_h: int = 480) -> str:
    """Encodes a full-frame bool mask as SAM 3.1 wire text (box-local one_bit mask), the way the API emits it."""
    ys, xs = np.nonzero(mask)
    x1, y1, x2, y2 = int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())
    local = mask[y1 : y2 + 1, x1 : x2 + 1].astype(np.uint8)
    h, w = local.shape
    payload = _encode_raster(local.flatten().tolist(), w, h)
    c = f";c={conf}" if conf is not None else ""
    return f"{object_id}<|box;x1={x1};y1={y1};x2={x2};y2={y2};w={frame_w};h={frame_h}{c}|><|mask;x=0;y=0{c};data={h},{w},{payload}|>"


# ---------------------------------------------------------------- frames


def synthetic_frame(contrast: float = 1.0, seed: int = 1, rects: list[tuple[int, int, int, int]] | None = None) -> bytes:
    """A 640x480 sand-coloured frame with dark objects; `contrast` scales everything toward flat grey-green murk."""
    rng = np.random.default_rng(seed)
    img = np.zeros((480, 640, 3), np.float32)
    img[:] = (120, 150, 170)
    img += rng.normal(0, 18, img.shape)
    for x0, y0, x1, y1 in rects or [(100, 200, 260, 260), (400, 120, 470, 200)]:
        img[y0:y1, x0:x1] = (40, 45, 50)
    murk = np.array((90, 110, 80), np.float32)
    img = murk + (img - murk) * contrast
    ok, buf = cv2.imencode(".jpg", np.clip(img, 0, 255).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 90])
    assert ok
    return buf.tobytes()


def id_mask_png(objects: dict[int, tuple[int, int, int, int]]) -> bytes:
    img = np.zeros((480, 640, 3), np.uint8)
    for index, (x0, y0, x1, y1) in objects.items():
        img[y0:y1, x0:x1, 2] = index * 4  # red channel, BGR order
    ok, buf = cv2.imencode(".png", img)
    assert ok
    return buf.tobytes()


def demo_wav(seconds: float = 1.0, rate: int = 16000) -> bytes:
    import io
    import wave

    t = np.arange(int(seconds * rate)) / rate
    pcm = (np.sin(2 * np.pi * 220 * t) * 8000).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


# ---------------------------------------------------------------- fake GRBL


class FakeGrbl:
    """Answers like GRBL 1.1: banner on wake or reset, ok/error to lines, a status report to '?', instant moves."""

    def __init__(self, banner: bool = True, alarm_on_home: bool = False, error_on: str | None = None):
        self.out: deque[bytes] = deque()
        self.written: list[bytes] = []
        self.banner = banner
        self.alarm_on_home = alarm_on_home
        self.error_on = error_on
        self.x = self.y = 0.0
        self.state = "Alarm"
        self.pins = ""
        self.closed = False
        self.silent = False
        self._cv = threading.Condition()

    def _emit(self, line: str) -> None:
        with self._cv:
            self.out.append((line + "\r\n").encode())
            self._cv.notify_all()

    def write(self, data: bytes) -> int:
        self.written.append(data)
        if self.silent:
            return len(data)
        if data in (b"\r\n\r\n", b"\x18"):
            self.state = "Alarm"
            if self.banner:
                self._emit("Grbl 1.1h ['$' for help]")
            return len(data)
        if data == b"?":
            self._emit(f"<{self.state}|MPos:{self.x * 10:.3f},{self.y * 10:.3f},0.000|FS:0,0" + (f"|Pn:{self.pins}" if self.pins else "") + ">")
            return len(data)
        if data == b"!":
            self.state = "Hold:0"
            return len(data)
        line = data.decode().strip()
        if self.error_on and line.startswith(self.error_on):
            self._emit("error:20")
        elif line == "$H":
            if self.alarm_on_home:
                self._emit("ALARM:9")
            else:
                self.x = self.y = 0.0
                self.state = "Idle"
                self._emit("ok")
        elif line.startswith("G90"):
            parts = {p[0]: float(p[1:]) for p in line.split() if p[0] in "XY"}
            self.x, self.y = parts.get("X", self.x * 10) / 10, parts.get("Y", self.y * 10) / 10
            self._emit("ok")
        else:
            self._emit("ok")
        return len(data)

    def readline(self) -> bytes:
        with self._cv:
            if not self.out:
                self._cv.wait(0.05)
            return self.out.popleft() if self.out else b""

    def close(self) -> None:
        self.closed = True
