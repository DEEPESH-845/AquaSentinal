"""Gantry drivers. docs/HARDWARE_INTEGRATION.md.

SimulatedGantryDriver is a port of lib/sim/gantry.ts (trapezoidal per-axis motion, 1/120 s substeps); tests pin it to the
TypeScript trajectory in shared/fixtures/trajectory.json.

SerialGantryDriver speaks GRBL 1.1 (the usual firmware for an Arduino Uno + CNC shield) over a serial transport.
It is written to the published protocol and tested against a fake GRBL; it has NOT been verified on the physical gantry.
It assumes: $13=0 (mm reports), homing enabled with MPos (0,0) at the home corner, positive travel along both axes.
"""

from __future__ import annotations

import asyncio
import math
import re
import threading
import time
from collections import deque
from typing import Literal, Protocol

from pydantic import BaseModel

from ..geometry import motion_limits, travel

TRAVEL_X, TRAVEL_Y = travel()
MAX_SPEED, ACCEL = motion_limits()
ARRIVE_TOLERANCE = 0.15
SUBSTEP = 1 / 120


class GantryStatus(BaseModel):
    driver: Literal["SIMULATED", "SERIAL_GRBL"]
    connected: bool
    homed: bool
    requires_homing: bool
    x: float
    y: float
    vx: float
    vy: float
    target_x: float
    target_y: float
    moving: bool
    limit_x: bool
    limit_y: bool
    state: str
    fault: str | None
    last_command: str | None
    last_ack: str | None
    updated_at: float


class GantryDriver(Protocol):
    requires_homing: bool

    async def connect(self) -> None: ...
    async def disconnect(self) -> None: ...
    async def home(self) -> None: ...
    async def get_position(self) -> tuple[float, float]: ...
    async def move_to(self, x: float, y: float, speed_fraction: float) -> None: ...
    async def stop(self) -> None: ...
    async def emergency_stop(self) -> None: ...
    async def get_status(self) -> GantryStatus: ...


class DriverFault(Exception):
    pass


# ---------------------------------------------------------------- simulated


class _Axis:
    __slots__ = ("pos", "vel", "target", "limit")

    def __init__(self, pos: float, limit: float):
        self.pos, self.vel, self.target, self.limit = pos, 0.0, pos, limit

    def step(self, dt: float, vmax: float, accel: float) -> None:
        """lib/sim/gantry.ts stepAxis, line for line."""
        self.target = min(self.limit, max(0.0, self.target))
        err = self.target - self.pos
        dist = abs(err)
        if dist < ARRIVE_TOLERANCE and abs(self.vel) < accel * dt * 1.5:
            self.pos, self.vel = self.target, 0.0
            return
        direction = math.copysign(1.0, err) if err != 0 else 0.0
        stop_speed = math.sqrt(2 * accel * dist)
        desired = direction * min(vmax, stop_speed)
        dv = min(accel * dt, max(-accel * dt, desired - self.vel))
        self.vel += dv
        self.pos = min(self.limit, max(0.0, self.pos + self.vel * dt))


class SimulatedGantryDriver:
    """Deterministic simulated gantry. advance(dt) steps it; the app runs a background task that advances in real time."""

    requires_homing = False

    def __init__(self, start: tuple[float, float] = (50.0, 20.0)):
        self.x = _Axis(start[0], TRAVEL_X)
        self.y = _Axis(start[1], TRAVEL_Y)
        self.speed_fraction = 0.65
        self.connected = True
        self.homed = True
        self.last_command: str | None = None
        self._acc = 0.0

    @property
    def moving(self) -> bool:
        return self.x.vel != 0 or self.y.vel != 0

    def advance(self, dt: float) -> None:
        if not (dt > 0):
            return
        self._acc += min(dt, 0.25)
        vmax = MAX_SPEED * min(1.0, max(0.2, self.speed_fraction))
        while self._acc >= SUBSTEP:
            self.x.step(SUBSTEP, vmax, ACCEL)
            self.y.step(SUBSTEP, vmax, ACCEL)
            self._acc -= SUBSTEP

    def at_target(self) -> bool:
        return not self.moving and self.x.pos == self.x.target and self.y.pos == self.y.target

    async def connect(self) -> None:
        self.connected = True

    async def disconnect(self) -> None:
        self.connected = False

    async def home(self) -> None:
        self.last_command = "HOME"
        self.x.target, self.y.target = 0.0, 0.0
        self.homed = True

    async def get_position(self) -> tuple[float, float]:
        return self.x.pos, self.y.pos

    async def move_to(self, x: float, y: float, speed_fraction: float) -> None:
        self.last_command = f"MOVE {x:.1f} {y:.1f} @{speed_fraction:.2f}"
        self.speed_fraction = speed_fraction
        self.x.target, self.y.target = x, y

    async def stop(self) -> None:
        self.last_command = "STOP"
        for a in (self.x, self.y):  # decelerate to the nearest stoppable point, as the twin does
            a.target = min(a.limit, max(0.0, a.pos + math.copysign((a.vel * a.vel) / (2 * ACCEL), a.vel)))

    async def emergency_stop(self) -> None:
        self.last_command = "ESTOP"
        for a in (self.x, self.y):
            a.vel, a.target = 0.0, a.pos

    async def get_status(self) -> GantryStatus:
        return GantryStatus(
            driver="SIMULATED", connected=self.connected, homed=self.homed, requires_homing=False,
            x=self.x.pos, y=self.y.pos, vx=self.x.vel, vy=self.y.vel, target_x=self.x.target, target_y=self.y.target,
            moving=self.moving, limit_x=self.x.pos <= 0, limit_y=self.y.pos <= 0, state="Run" if self.moving else "Idle",
            fault=None, last_command=self.last_command, last_ack="SIMULATED", updated_at=time.time(),
        )


# ---------------------------------------------------------------- GRBL over serial


class SerialTransport(Protocol):
    def write(self, data: bytes) -> int | None: ...
    def readline(self) -> bytes: ...
    def close(self) -> None: ...


_STATUS = re.compile(r"^<(?P<state>[A-Za-z]+)(?::\d)?\|(?P<fields>.*)>$")


def parse_status(line: str) -> dict:
    """Parses a GRBL 1.1 status report such as <Idle|MPos:10.000,20.000,0.000|FS:0,0|Pn:X>."""
    m = _STATUS.match(line.strip())
    if not m:
        raise DriverFault(f"malformed status report: {line[:80]!r}")
    out: dict = {"state": m["state"], "pins": "", "mpos": None}
    for part in m["fields"].split("|"):
        key, _, val = part.partition(":")
        if key in ("MPos", "WPos"):
            nums = [float(v) for v in val.split(",")]
            if len(nums) < 2 or not all(math.isfinite(n) for n in nums):
                raise DriverFault(f"non-finite position in status: {val!r}")
            out["mpos"] = (nums[0] / 10.0, nums[1] / 10.0)  # mm -> cm
        elif key == "Pn":
            out["pins"] = val
    if out["mpos"] is None:
        raise DriverFault("status report without a position")
    return out


class SerialGantryDriver:
    requires_homing = True

    def __init__(self, transport_factory, *, ack_timeout_s: float = 2.0, home_timeout_s: float = 90.0, banner_timeout_s: float = 3.0):
        self._factory = transport_factory
        self._t: SerialTransport | None = None
        self._lines: deque[str] = deque(maxlen=200)
        self._cv = threading.Condition()
        self._reader: threading.Thread | None = None
        self._running = False
        self.ack_timeout_s = ack_timeout_s
        self.home_timeout_s = home_timeout_s
        self.banner_timeout_s = banner_timeout_s
        self.connected = False
        self.homed = False
        self.fault: str | None = None
        self.last_command: str | None = None
        self.last_ack: str | None = None
        self._status = {"state": "Unknown", "pins": "", "mpos": (0.0, 0.0)}
        self._target = (0.0, 0.0)
        self._prev = (0.0, 0.0, time.time())
        self._vel = (0.0, 0.0)

    # -------- line plumbing (a reader thread owns the blocking port)

    def _read_loop(self) -> None:
        while self._running and self._t is not None:
            try:
                raw = self._t.readline()
            except Exception as e:  # port vanished
                self.fault = f"SERIAL_READ_ERROR: {e}"
                self.connected = False
                break
            if not raw:
                continue
            line = raw.decode("ascii", errors="replace").strip()
            if line:
                with self._cv:
                    self._lines.append(line)
                    self._cv.notify_all()

    async def _wait_line(self, pred, timeout: float) -> str:
        deadline = time.monotonic() + timeout

        def wait() -> str | None:
            with self._cv:
                while True:
                    for i, line in enumerate(self._lines):
                        if pred(line):
                            del self._lines[i]
                            return line
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        return None
                    self._cv.wait(remaining)

        line = await asyncio.to_thread(wait)
        if line is None:
            raise DriverFault("timed out waiting for the controller")
        return line

    def _write(self, data: bytes, label: str) -> None:
        if self._t is None:
            raise DriverFault("not connected")
        self._t.write(data)
        self.last_command = label

    async def _command(self, gcode: str, timeout: float | None = None) -> None:
        """Sends one line and waits for ok / error:N / ALARM:N."""
        self._write((gcode + "\n").encode("ascii"), gcode)
        line = await self._wait_line(lambda l: l == "ok" or l.startswith("error:") or l.startswith("ALARM:"), timeout or self.ack_timeout_s)
        self.last_ack = line
        if line != "ok":
            if line.startswith("ALARM:"):
                self.homed = False
            self.fault = f"CONTROLLER_{line.replace(':', '_').upper()}"
            raise DriverFault(f"controller rejected {gcode!r}: {line}")

    # -------- driver interface

    async def connect(self) -> None:
        self._t = await asyncio.to_thread(self._factory)
        self._running = True
        self._reader = threading.Thread(target=self._read_loop, name="grbl-reader", daemon=True)
        self._reader.start()
        self._write(b"\r\n\r\n", "WAKE")
        try:
            banner = await self._wait_line(lambda l: l.startswith("Grbl"), self.banner_timeout_s)
        except DriverFault:
            self._write(b"\x18", "SOFT_RESET")
            try:
                banner = await self._wait_line(lambda l: l.startswith("Grbl"), self.banner_timeout_s)
            except DriverFault:
                await self.disconnect()
                self.fault = "NO_GRBL_BANNER"
                raise DriverFault("no GRBL banner: is the firmware GRBL 1.1 and the port correct?")
        self.last_ack = banner
        self.connected, self.homed, self.fault = True, False, None
        # Never auto-unlock ($X): an alarm after reset means homing is required, which is the operator's call.

    async def disconnect(self) -> None:
        self._running = False
        self.connected = False
        if self._t is not None:
            try:
                await asyncio.to_thread(self._t.close)
            finally:
                self._t = None

    async def home(self) -> None:
        await self._command("$H", self.home_timeout_s)
        self.homed = True
        self.fault = None
        self._target = (0.0, 0.0)

    async def get_position(self) -> tuple[float, float]:
        s = await self.get_status()
        return s.x, s.y

    async def move_to(self, x: float, y: float, speed_fraction: float) -> None:
        if not self.homed:
            raise DriverFault("not homed")
        feed = MAX_SPEED * 10 * 60 * speed_fraction  # cm/s -> mm/min
        self._target = (x, y)
        await self._command(f"G90 G21 G1 X{x * 10:.3f} Y{y * 10:.3f} F{feed:.0f}")

    async def stop(self) -> None:
        """Feed hold (controlled deceleration), then a reset to flush the planner. Re-homing is then required
        until position retention across hold + reset has been verified on this machine."""
        self._write(b"!", "FEED_HOLD")
        try:
            for _ in range(15):
                s = await self.get_status()
                if s.state.startswith("Hold") and not s.moving:
                    break
                await asyncio.sleep(0.2)
        finally:
            self._write(b"\x18", "SOFT_RESET")
            self.homed = False

    async def emergency_stop(self) -> None:
        """Soft reset: GRBL stops step generation immediately. Steps may be lost, so homing is required afterwards."""
        if self._t is not None:
            self._write(b"\x18", "ESTOP_SOFT_RESET")
        self.homed = False

    async def get_status(self) -> GantryStatus:
        if self._t is not None and self.connected:
            self._write(b"?", "?")
            line = await self._wait_line(lambda l: l.startswith("<"), 1.0)
            self._status = parse_status(line)
            x, y = self._status["mpos"]
            px, py, pt = self._prev
            now = time.time()
            dt = max(1e-3, now - pt)
            self._vel = ((x - px) / dt, (y - py) / dt)
            self._prev = (x, y, now)
        x, y = self._status["mpos"]
        state = self._status["state"]
        return GantryStatus(
            driver="SERIAL_GRBL", connected=self.connected, homed=self.homed, requires_homing=True,
            x=x, y=y, vx=self._vel[0], vy=self._vel[1], target_x=self._target[0], target_y=self._target[1],
            moving=state in ("Run", "Jog", "Home"), limit_x="X" in self._status["pins"], limit_y="Y" in self._status["pins"],
            state=state, fault=self.fault, last_command=self.last_command, last_ack=self.last_ack, updated_at=time.time(),
        )


def open_serial(port: str, baud: int):
    """Factory for a real port. Imported lazily so simulation never touches pyserial."""

    def factory():
        import serial  # pyserial

        return serial.Serial(port, baud, timeout=0.1)

    return factory
