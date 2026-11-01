# Hardware integration

Physical actuation has not been tested.
No gantry, Arduino, camera or sensor was connected during development, and nothing here claims otherwise.

## Reference hardware (from HydraLoom, unverified)

- XY gantry: 2020 frame, MGN12 rails, NEMA17 steppers with GT2 belts, 80 steps per mm, travel 0 to 100 cm by 0 to 40 cm.
- Motion limits used everywhere: 15 cm/s, 30 cm/s^2 (`shared/geometry.json`).
- Arduino Uno with CNC shield and two A4988 drivers; Raspberry Pi 4 running the backend; Pi Camera Module 3 Wide 42 cm above the sand, 75 degree underwater FOV.
- Limit switches at X = 0 and Y = 0.

## Driver interface

`backend/app/hardware/drivers.py` defines `GantryDriver`: `connect`, `disconnect`, `home`, `get_position`, `move_to(x, y, speed_fraction)`, `stop`, `emergency_stop`, `get_status`.
`GantryStatus` reports driver, connected, homed, requires_homing, x, y, vx, vy, target, moving, limit_x, limit_y, state, fault, last_command, last_ack.
Every driver sits behind `MotionController` (docs/SAFETY.md); nothing calls a driver directly.

### SimulatedGantryDriver

- A line-for-line port of `lib/sim/gantry.ts` stepping at 1/120 s.
- `backend/tests/test_contracts.py` checks it against `shared/fixtures/trajectory.json`, generated from the TypeScript engine, to 1e-9.
- The app advances it in real time; tests advance it explicitly.

### SerialGantryDriver (GRBL 1.1)

HydraLoom had no gantry firmware protocol, so this driver targets GRBL 1.1, the usual firmware for an Uno with a CNC shield.
It is written to the published protocol and tested against `FakeGrbl` in `backend/tests/conftest.py`.

Assumptions that must be confirmed on the rig:

- `$13=0` (status positions in millimetres); the driver divides by 10 to get cm.
- Homing enabled (`$22=1`) with machine position (0, 0) at the home corner and positive travel on both axes.
- Status reports contain `MPos` and, when a switch is pressed, `Pn:` with X or Y.

Behaviour:

- `connect`: opens the port in a reader thread, sends a wake sequence and waits for the `Grbl` banner, retrying once after a soft reset; without a banner it faults with `NO_GRBL_BANNER`.
- It never sends `$X`; an alarm after reset means homing is required, and that is the operator's call.
- `home`: `$H`, waits up to 90 s for `ok`; `ALARM:N` clears the homed flag.
- `move_to`: refused unless homed; sends `G90 G21 G1 X<mm> Y<mm> F<mm/min>` with feed = 15 cm/s x speed fraction; `error:N` and `ALARM:N` set a fault.
- `stop`: feed hold `!`, waits for Hold, then soft reset `0x18`, and requires re-homing until position retention across hold plus reset is verified.
- `emergency_stop`: soft reset `0x18` immediately; homing required afterwards.
- `get_status`: realtime `?`, parsed by `parse_status`; malformed or non-finite reports raise `DriverFault`.

## Camera

`backend/app/hardware/camera.py` `CameraManager` stores the latest frame and serves it as MJPEG at `/api/camera/stream`.
In SIMULATION frames come from the digital twin captures.
In HARDWARE with `AQUA_CAMERA_DEVICE` set, an OpenCV device is read on a thread at 640 x 480; its status reports `verifiedHardware: false`.
Camera frames carry no turbidity or lighting values, because there is no sensor for them; only the image-derived estimate is recorded.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `APP_MODE` | `SIMULATION` | `HARDWARE` selects the serial driver only together with the next two |
| `AQUA_HARDWARE_ENABLE` | `false` | Explicit opt-in for physical actuation |
| `AQUA_SERIAL_PORT` | empty | Serial device, for example `/dev/ttyACM0` |
| `AQUA_SERIAL_BAUD` | `115200` | GRBL default |
| `AQUA_CAMERA_DEVICE` | empty | OpenCV device index or path, HARDWARE only |

With `APP_MODE=HARDWARE` but hardware not enabled, the backend logs a warning and keeps the simulated driver.

## Bring-up checklist

1. Flash GRBL 1.1 and set `$13=0`, `$22=1`, steps per mm, max rates and accelerations to the reference values.
2. Start the backend with the three variables above and send `CONNECT` over `/ws/commands` or `POST /api/gantry/command`.
3. Send `HOME`, check `GantryStatus` reads (0, 0) and the limit pins.
4. Send short `MOVE_TO` commands at 0.2 speed and compare commanded and measured positions.
5. Test `ESTOP` during motion and confirm motion stops and homing is required.
6. Only then start a mission with `executor: "BACKEND"`.
