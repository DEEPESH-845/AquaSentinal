"""Camera sources. In SIMULATION the frames come from the digital twin (each capture the browser uploads);
in HARDWARE an OpenCV device can be opened when AQUA_CAMERA_DEVICE is set. The MJPEG stream serves the latest frame."""

from __future__ import annotations

import asyncio
import threading
import time
from collections.abc import AsyncIterator
from typing import Literal


class CameraManager:
    def __init__(self, device: str = ""):
        self.source: Literal["DIGITAL_TWIN", "OPENCV_DEVICE"] = "OPENCV_DEVICE" if device else "DIGITAL_TWIN"
        self.device = device
        self._latest: bytes | None = None
        self._at = 0.0
        self._size = (0, 0)
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.error: str | None = None

    def push(self, jpeg: bytes, width: int, height: int) -> None:
        with self._lock:
            self._latest, self._at, self._size = jpeg, time.time(), (width, height)

    def latest(self) -> bytes | None:
        with self._lock:
            return self._latest

    def status(self) -> dict:
        with self._lock:
            age = time.time() - self._at if self._latest else None
        return {
            "source": self.source,
            "online": age is not None and age < 30,
            "lastFrameAgeS": round(age, 1) if age is not None else None,
            "resolution": f"{self._size[0]}x{self._size[1]}" if self._latest else None,
            "error": self.error,
            "verifiedHardware": False,
        }

    def start_device(self) -> None:
        """Opens the configured OpenCV device on a thread. Unverified on the physical rig; errors are reported, not raised."""
        if self.source != "OPENCV_DEVICE" or self._thread:
            return

        def run() -> None:
            import cv2

            cap = cv2.VideoCapture(int(self.device) if self.device.isdigit() else self.device)
            if not cap.isOpened():
                self.error = f"could not open camera device {self.device!r}"
                return
            while not self._stop.is_set():
                ok, frame = cap.read()
                if not ok:
                    self.error = "camera read failed"
                    time.sleep(0.2)
                    continue
                frame = cv2.resize(frame, (640, 480))
                ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
                if ok:
                    self.error = None
                    self.push(buf.tobytes(), 640, 480)
                time.sleep(1 / 15)
            cap.release()

        self._thread = threading.Thread(target=run, name="camera", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    async def mjpeg(self, fps: float = 5) -> AsyncIterator[bytes]:
        last = None
        while True:
            frame = self.latest()
            if frame is not None and frame is not last:
                last = frame
                yield b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(frame)).encode() + b"\r\n\r\n" + frame + b"\r\n"
            await asyncio.sleep(1 / fps)
