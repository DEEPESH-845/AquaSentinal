"""Mission spec -> executable plan. The only place waypoints are generated.

Deterministic, bounded and pure: the same spec always gives the same plan, every waypoint lies inside the soft travel
limits, and plans that would run too long are refused rather than truncated.
"""

from __future__ import annotations

import math

from ..geometry import motion_limits, travel
from ..schemas import TARGET_TO_TYPE, MissionPlan, MissionSpec, PlanPolicy, PlanRegion, PlanSummary, PlanWaypoint

MAX_WAYPOINTS = 80
MAX_DURATION_S = 900.0
CAPTURE_DWELL_S = 1.0  # lib/sim/constants.ts PERCEPTION.captureDwellS


class PlanError(ValueError):
    """The spec is valid but cannot be turned into an acceptable plan."""


def _axis_time(d: float, v: float, a: float) -> float:
    """Trapezoidal move time, matching lib/sim/gantry.ts (triangular when the axis never reaches vmax)."""
    if d <= 0:
        return 0.0
    return 2 * math.sqrt(d / a) if d < v * v / a else d / v + v / a


def _spaced(lo: float, hi: float, spacing: float, minimum: int) -> list[float]:
    if hi <= lo:
        return [round(lo, 1)]
    n = max(minimum, math.ceil((hi - lo) / spacing - 1e-9) + 1)
    return [round(lo + (hi - lo) * i / (n - 1), 1) for i in range(n)]


def compile_plan(spec: MissionSpec) -> tuple[MissionPlan, PlanSummary]:
    r = spec.region
    height = r.y_max - r.y_min
    lanes = max(1, math.ceil(height / spec.lane_spacing_cm - 1e-9)) if height > 0 else 1
    ys = [round(r.y_min + (i + 0.5) * height / lanes, 1) for i in range(lanes)] if height > 0 else [round(r.y_min, 1)]
    xs = _spaced(r.x_min, r.x_max, spec.capture_spacing_cm, 2)

    waypoints: list[PlanWaypoint] = []
    for i, y in enumerate(ys):
        if spec.scan_pattern == "left_to_right":
            row = xs
        elif spec.scan_pattern == "right_to_left":
            row = xs[::-1]
        else:  # serpentine
            row = xs if i % 2 == 0 else xs[::-1]
        waypoints.extend(PlanWaypoint(x=x, y=y, capture=True) for x in row)

    if len(waypoints) > MAX_WAYPOINTS:
        raise PlanError(f"plan needs {len(waypoints)} waypoints, the limit is {MAX_WAYPOINTS}: widen capture or lane spacing")

    tx, ty = travel()
    for w in waypoints:  # schema bounds already hold; this guards the arithmetic above
        if not (0 <= w.x <= tx and 0 <= w.y <= ty):
            raise PlanError(f"waypoint ({w.x}, {w.y}) outside the soft travel limits")

    vmax_full, accel = motion_limits()
    v = vmax_full * spec.speed_fraction
    duration, length = 0.0, 0.0
    px, py = 0.0, 0.0  # missions start from home
    for w in waypoints:
        dx, dy = abs(w.x - px), abs(w.y - py)
        length += math.hypot(dx, dy)
        duration += max(_axis_time(dx, v, accel), _axis_time(dy, v, accel)) + (CAPTURE_DWELL_S if w.capture else 0)
        px, py = w.x, w.y
    if duration > MAX_DURATION_S:
        raise PlanError(f"estimated duration {duration:.0f} s exceeds the {MAX_DURATION_S:.0f} s limit")

    p = spec.visibility_policy
    plan = MissionPlan(
        mission_id=spec.mission_id,
        waypoints=waypoints,
        speed_fraction=spec.speed_fraction,
        targets=[TARGET_TO_TYPE[t] for t in spec.targets],
        policy=PlanPolicy(
            reduce_speed_on_degradation=p.reduce_speed_on_degradation,
            stop_on_unsafe_visibility=p.stop_on_unsafe_visibility,
            degraded_visibility=p.degraded_visibility,
            unsafe_visibility=p.unsafe_visibility,
            reduced_speed_fraction=p.reduced_speed_fraction,
        ),
        region=PlanRegion(x_min=r.x_min, x_max=r.x_max, y_min=r.y_min, y_max=r.y_max),
    )
    summary = PlanSummary(
        waypoint_count=len(waypoints),
        capture_count=sum(w.capture for w in waypoints),
        path_length_cm=round(length, 1),
        estimated_duration_s=round(duration, 1),
        lanes=lanes,
    )
    return plan, summary
