"""Motion controller: the single gate between any requested move and a gantry driver. docs/SAFETY.md.

Interlocks, in the order they are checked:
  emergency stop latched -> driver connected -> no fault -> homed (when the driver requires it)
  -> finite target inside the soft travel limits -> speed fraction inside 0.2..1.0
The emergency stop path never awaits anything but the driver call itself, and is accepted in every state.
A watchdog polls driver status; lost or invalid telemetry and overrun commands trigger an emergency stop.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time

from ..events import EventBus
from ..geometry import motion_limits, travel
from .drivers import DriverFault, GantryDriver, GantryStatus

log = logging.getLogger("aquasentinal.motion")
TRAVEL_X, TRAVEL_Y = travel()
MAX_SPEED, ACCEL = motion_limits()
POSITION_SLACK_CM = 0.5  # reported positions this far outside travel are treated as invalid telemetry


class InterlockError(Exception):
    pass


def move_time_s(dx: float, dy: float, speed_fraction: float) -> float:
    v = MAX_SPEED * speed_fraction

    def axis(d: float) -> float:
        return 2 * math.sqrt(d / ACCEL) if d < v * v / ACCEL else d / v + v / ACCEL

    return max(axis(abs(dx)), axis(abs(dy)))


class MotionController:
    def __init__(self, driver: GantryDriver, events: EventBus, *, hardware: bool, poll_s: float = 0.25, telemetry_timeout_s: float = 1.5):
        self.driver = driver
        self.events = events
        self.hardware = hardware
        self.poll_s = poll_s
        self.telemetry_timeout_s = telemetry_timeout_s
        self.estop = False
        self.fault: str | None = None
        self.deadline: float | None = None
        self.last_status: GantryStatus | None = None
        self.last_ok = time.monotonic()
        self._task: asyncio.Task | None = None
        self._last_key: tuple | None = None

    # -------- commands

    async def move_to(self, x: float, y: float, speed_fraction: float) -> None:
        if self.estop:
            raise InterlockError("emergency stop is latched: clear it before moving")
        status = await self.driver.get_status()
        if not status.connected:
            raise InterlockError("gantry not connected")
        if self.fault or status.fault:
            raise InterlockError(f"gantry fault: {self.fault or status.fault}")
        if status.requires_homing and not status.homed:
            raise InterlockError("gantry not homed: home it before moving")
        if not (math.isfinite(x) and math.isfinite(y)):
            raise InterlockError("non-finite target")
        if not (0 <= x <= TRAVEL_X and 0 <= y <= TRAVEL_Y):
            raise InterlockError(f"target ({x:.1f}, {y:.1f}) outside the soft travel limits 0..{TRAVEL_X:.0f} x 0..{TRAVEL_Y:.0f} cm")
        if not (math.isfinite(speed_fraction) and 0.2 <= speed_fraction <= 1.0):
            raise InterlockError("speed fraction must be within 0.2..1.0")
        self.deadline = time.monotonic() + move_time_s(x - status.x, y - status.y, speed_fraction) * 1.5 + 2.0
        await self.driver.move_to(x, y, speed_fraction)
        await self._publish(await self.driver.get_status())

    async def home(self) -> None:
        if self.estop:
            raise InterlockError("emergency stop is latched")
        status = await self.driver.get_status()
        if not status.connected:
            raise InterlockError("gantry not connected")
        self.deadline = time.monotonic() + 120
        await self.driver.home()
        self.fault = None

    async def stop(self) -> None:
        self.deadline = None
        await self.driver.stop()

    async def emergency_stop(self, reason: str = "operator") -> None:
        self.estop = True
        self.deadline = None
        try:
            await self.driver.emergency_stop()
        except Exception as e:  # the latch holds even if the port is gone
            self.fault = f"ESTOP_SEND_FAILED: {e}"
        log.warning("emergency stop", extra={"reason": reason})
        await self.events.publish("hardware.estop", {"reason": reason, "latched": True})

    async def clear_estop(self) -> None:
        self.estop = False
        await self.events.publish("hardware.estop", {"reason": "cleared by operator", "latched": False})

    async def connect(self) -> None:
        await self.driver.connect()
        self.fault = None

    async def disconnect(self) -> None:
        await self.driver.disconnect()

    async def wait_idle(self, timeout_s: float, tick=None) -> bool:
        """Waits for arrival. `tick(dt)` lets tests and the simulated driver advance time."""
        t_end = time.monotonic() + timeout_s
        while time.monotonic() < t_end:
            if tick:
                tick()
            s = await self.driver.get_status()
            if not s.moving and abs(s.x - s.target_x) < 0.2 and abs(s.y - s.target_y) < 0.2:
                self.deadline = None
                return True
            await asyncio.sleep(0 if tick else 0.02)
        return False

    # -------- watchdog

    def validate(self, s: GantryStatus) -> str | None:
        """Returns a fault string when telemetry cannot be trusted."""
        for name in ("x", "y", "vx", "vy"):
            if not math.isfinite(getattr(s, name)):
                return f"INVALID_TELEMETRY: non-finite {name}"
        if not (-POSITION_SLACK_CM <= s.x <= TRAVEL_X + POSITION_SLACK_CM and -POSITION_SLACK_CM <= s.y <= TRAVEL_Y + POSITION_SLACK_CM):
            return f"INVALID_TELEMETRY: position ({s.x:.2f}, {s.y:.2f}) outside travel"
        if s.state.startswith("Alarm"):
            return "UNEXPECTED_STATE: controller in alarm"
        if self.deadline is not None and s.moving and time.monotonic() > self.deadline:
            return "COMMAND_TIMEOUT: move overran its deadline"
        return None

    async def check_once(self) -> None:
        try:
            s = await asyncio.wait_for(self.driver.get_status(), self.telemetry_timeout_s)
        except (asyncio.TimeoutError, DriverFault) as e:
            if self.hardware and time.monotonic() - self.last_ok > self.telemetry_timeout_s:
                self.fault = f"TELEMETRY_LOST: {e or 'timeout'}"
                await self.emergency_stop("watchdog: telemetry lost")
            return
        self.last_ok = time.monotonic()
        fault = self.validate(s)
        if fault and not self.estop:
            self.fault = fault
            await self.emergency_stop(f"watchdog: {fault}")
        await self._publish(s)

    async def _publish(self, s: GantryStatus) -> None:
        """Publishes only when something an operator could see has changed, not on every watchdog poll."""
        self.last_status = s
        key = (round(s.x, 2), round(s.y, 2), s.moving, s.connected, s.homed, s.state, s.fault, self.fault, self.estop)
        if key == self._last_key:
            return
        self._last_key = key
        await self.events.publish("hardware.status", self.snapshot())

    def snapshot(self) -> dict:
        s = self.last_status
        return {
            "estop": self.estop,
            "fault": self.fault or (s.fault if s else None),
            "hardware": self.hardware,
            "status": s.model_dump(by_alias=True) if s else None,
        }

    async def _loop(self) -> None:
        while True:
            try:
                await self.check_once()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # the watchdog itself must never die silently
                log.exception("watchdog error: %s", e)
            await asyncio.sleep(self.poll_s)

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._loop())

    async def shutdown(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
