"""Adaptive visibility policy for the backend executor. Same states and thresholds as lib/sim/engine.ts tickMission.

Fed by a physical sensor when one is connected, otherwise by the image-derived estimate of each frame.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..geometry import perception_defaults
from ..schemas import PlanPolicy


@dataclass
class Decision:
    state: str
    speed_fraction: float
    paused: bool
    reason: str


class VisibilityController:
    def __init__(self, policy: PlanPolicy, plan_speed: float):
        p = perception_defaults()
        self.policy = policy
        self.plan_speed = plan_speed
        self.resume_after_s = float(p["resumeAfterS"])
        self.operator_timeout_s = float(p["operatorTimeoutS"])
        self.paused = False
        self.paused_for = 0.0
        self.recover_for = 0.0
        self.pauses = 0

    def step(self, visibility: float, camera_online: bool, dt: float) -> Decision:
        unsafe = not camera_online or visibility < self.policy.unsafe_visibility
        degraded = visibility < self.policy.degraded_visibility
        if self.paused:
            self.paused_for += dt
            self.recover_for = self.recover_for + dt if not degraded and camera_online else 0.0
            if self.recover_for >= self.resume_after_s:
                self.paused = False
                return Decision("NORMAL_VISIBILITY", self.plan_speed, False, f"visibility {visibility:.0%} recovered")
            state = "OPERATOR_INTERVENTION_REQUIRED" if self.paused_for >= self.operator_timeout_s else "INSPECTION_PAUSED"
            return Decision(state, 0.0, True, "waiting for visibility to recover")
        if unsafe and self.policy.stop_on_unsafe_visibility:
            self.paused, self.paused_for, self.recover_for = True, 0.0, 0.0
            self.pauses += 1
            return Decision("INSPECTION_PAUSED", 0.0, True, "camera offline" if not camera_online else f"visibility {visibility:.0%} below the unsafe limit")
        if degraded and self.policy.reduce_speed_on_degradation:
            return Decision("REDUCED_VISIBILITY", min(self.policy.reduced_speed_fraction, self.plan_speed), False, "visibility degraded")
        return Decision("NORMAL_VISIBILITY", self.plan_speed, False, "")
