# Safety

The control path is fixed:

```
natural language -> MissionSpec (Pydantic) -> compile_plan (bounded waypoints) -> operator approval
  -> twin runMission (SIMULATION) or BackendExecutor -> MotionController interlocks -> driver
```

## The model cannot actuate

- Muse Spark is offered only the PLANNING tools: three read-only queries and `create_inspection_mission`.
- `move_to_waypoint`, `start_inspection`, `pause_inspection`, `stop_inspection`, `capture_inspection_frame`, `segment_target` and `record_observation` are EXECUTION tools; dispatching them in PLANNING returns a refusal (`test_dispatch_refuses_wrong_phase_unknown_tools_and_bad_args`, `test_unsafe_model_output_never_becomes_a_mission`).
- Tool arguments are validated with `extra="forbid"` models; region, speed and thresholds are bounded in `schemas.py`.
- The compiler is the only source of waypoints and refuses plans beyond 80 waypoints or 900 s.
- A planned mission does nothing until the operator presses Approve and run.

## Interlocks (`backend/app/hardware/motion.py`)

Checked in order on every move:

1. Emergency stop latched.
2. Driver connected.
3. No fault on the controller or driver.
4. Homed, when the driver requires it.
5. Finite target inside 0 to 100 by 0 to 40 cm.
6. Speed fraction within 0.2 to 1.0.

A move also gets a deadline of 1.5 times its trapezoidal time plus 2 s.

## Emergency stop

- Twin: `SimEngine.emergencyStop()` zeroes both axis velocities in the same substep, ends a mission with `EMERGENCY_STOP`, and latches; every motion command and `runMission` is refused until `clearEstop()` or a full reset.
- UI: the E-stop button is always visible in the top bar; it acts on the twin synchronously, then sends `ESTOP` to the backend.
- The two latches are independent, so the twin's Reset can clear its own while the backend keeps its.
- The top bar shows the latched state and the Clear e-stop button while either latch is set, and its title says which; Clear e-stop sends `CLEAR_ESTOP`, clears the twin and re-reads the backend status.
- Approving a plan while only the backend latch is set is refused with a 409, and the mission card says to clear the e-stop from the top bar.
- Backend: `MotionController.emergency_stop()` latches first, then calls the driver; if the driver call fails the latch still holds and the fault is recorded.
- Missions cannot start while the backend latch is set.
- GRBL: soft reset, homing required afterwards.

## Watchdog

Every 0.25 s the motion controller polls driver status and triggers an emergency stop on:

- non-finite position or velocity,
- position more than 0.5 cm outside travel,
- a controller in alarm,
- a move that overran its deadline,
- no valid status for longer than the telemetry timeout (hardware only).

## Visibility policy

Adaptive missions slow down in degraded visibility and pause when it is unsafe or the camera is offline (docs/PERCEPTION_PIPELINE.md).
Operator resume is refused while visibility is unsafe.

## Defaults

- `APP_MODE=SIMULATION` and `AQUA_HARDWARE_ENABLE=false`; the serial driver needs both flags and a port.
- The backend executor is refused unless hardware is active.
- The backend has no authentication; it is meant for a local network with CORS limited to the frontend origin.
