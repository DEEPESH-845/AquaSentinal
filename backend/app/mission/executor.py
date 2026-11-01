"""Backend mission executor for the hardware path (and headless integration tests with the simulated driver).

Moves through the compiled plan via the motion controller, so every move passes the interlocks; checks visibility from
each frame before moving on; captures at capture waypoints and sends frames through the perception pipeline.
Re-observation is implemented in the twin (lib/sim/engine.ts) only; this executor runs the scan, slow-down and pause policy.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from ..hardware.motion import MotionController
from ..perception.controller import VisibilityController
from ..perception.pipeline import PerceptionPipeline
from ..perception.quality import analyze, decode
from ..schemas import CaptureMeta, MissionRecord

Grab = Callable[[], Awaitable[tuple[bytes, int, int] | None]]


@dataclass
class ExecutorResult:
    outcome: str
    waypoints_visited: int = 0
    captures: int = 0
    unreliable_captures: int = 0
    pauses: int = 0
    states: list[str] = field(default_factory=list)


class BackendExecutor:
    def __init__(self, motion: MotionController, grab: Grab, pipeline: PerceptionPipeline, *, poll_dt: float = 0.5, sleep=asyncio.sleep, tick: Callable[[], None] | None = None, max_pause_s: float = 120.0):
        self.motion = motion
        self.grab = grab
        self.pipeline = pipeline
        self.poll_dt = poll_dt
        self._sleep = sleep
        self._tick = tick
        self.max_pause_s = max_pause_s
        self.stop_requested = False

    async def _visibility(self) -> tuple[float, bool, tuple[bytes, int, int] | None]:
        frame = await self.grab()
        if frame is None:
            return 0.0, False, None
        return analyze(decode(frame[0])).visibility_estimate, True, frame

    async def run(self, m: MissionRecord) -> ExecutorResult:
        plan = m.plan
        ctl = VisibilityController(plan.policy, plan.speed_fraction)
        res = ExecutorResult(outcome="COMPLETED")
        status = await self.motion.driver.get_status()
        if status.requires_homing and not status.homed:
            await self.motion.home()
            await self.motion.wait_idle(120, self._tick)
        seq = 0
        for i, wp in enumerate(plan.waypoints):
            paused_for = 0.0
            while True:
                if self.stop_requested or self.motion.estop:
                    res.outcome = "EMERGENCY_STOP" if self.motion.estop else "ABORTED_BY_OPERATOR"
                    return res
                vis, online, frame = await self._visibility()
                d = ctl.step(vis, online, self.poll_dt)
                res.states.append(d.state)
                if not d.paused:
                    break
                paused_for += self.poll_dt
                if paused_for >= self.max_pause_s:
                    await self.motion.stop()
                    res.outcome, res.pauses = "STOPPED_UNSAFE_VISIBILITY", ctl.pauses
                    return res
                await self._sleep(0)
            await self.motion.move_to(wp.x, wp.y, d.speed_fraction)
            if not await self.motion.wait_idle(300, self._tick):
                await self.motion.emergency_stop("executor: waypoint not reached")
                res.outcome = "EMERGENCY_STOP"
                return res
            res.waypoints_visited = i + 1
            if not wp.capture:
                continue
            vis, online, frame = await self._visibility()
            if frame is None:
                continue
            jpeg, w, h = frame
            pos = await self.motion.driver.get_position()
            res.captures += 1
            res.unreliable_captures += vis < plan.policy.unsafe_visibility
            await self.pipeline.process(
                CaptureMeta(
                    mission_id=m.id, seq=seq, reason="SCAN", waypoint_index=i, time=float(i), gantry_x=pos[0], gantry_y=pos[1],
                    visibility=vis, perception=d.state, camera_online=online, source="CAMERA",  # type: ignore[arg-type]
                    targets=[t.lower() for t in plan.targets],  # type: ignore[misc]
                ),
                jpeg,
                None,
            )
            seq += 1
        res.pauses = ctl.pauses
        return res
