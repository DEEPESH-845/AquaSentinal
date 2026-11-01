# Engineering audit of HydraLoom

Source: https://github.com/DEEPESH-845/HydraLoom at commit `d59308e17ff483a54512bc340f6351e779fb26e7` (32 commits, branch `main`).
The audit read every file in the repository, not only the documentation.
The source was cloned read-only into `reference/HydraLoom` with its push URL set to `DISABLED_READ_ONLY`, and it was never modified.

## 1. What HydraLoom is

HydraLoom ("GANTRYLAB") is a browser prototype of a bench-top underwater robotics testbed: a 120 x 60 x 60 cm tank, a motorised XY gantry carrying a downward camera, printed test objects on sand.
The frontend is Next.js 16 (App Router), React 19.2, TypeScript strict, Three.js 0.184 with React Three Fiber 9 and Drei 10, Zustand 5, GSAP for camera tweens, Framer Motion for DOM transitions, Tailwind 4.
A Python `backend/` exists but is not used by the browser prototype (section 6).

## 2. Frontend architecture

- `app/` holds the shell: fonts (Inter, IBM Plex Mono), design tokens in `globals.css` (`@theme`), and a page that stacks `<LabScene />` under `<LabUI />`.
- `components/lab/` is the Three.js scene: `Aquarium`, `Gantry`, `CameraRig`, `Electronics`, `TestObjects`, `Overlays` (footprint, frustum, rings, grid, callouts), `FeedRenderer`, `SimDriver`, `Scene`, `util`.
- `components/ui/` is the DOM overlay: `LabUI` (top bar, scene rail, right column, bottom card), `CameraFeed`, `Telemetry`, `scenes.tsx` (seven scene cards), `overlays.tsx` (demo card, closing moment), `shared.tsx`.
- `lib/sim/` is the engine: pure TypeScript, no React, deterministic.

## 3. Rendering pipeline

- `SimDriver` is the only simulation loop; it lives inside the R3F canvas, ticks the engine every frame and publishes a snapshot to Zustand at 20 Hz.
- 3D components read hot values from `useSimStore.getState().engine` inside `useFrame` rather than through React state.
- `FeedRenderer` takes over the render loop (`useFrame(..., 1)`): it renders the main camera, then scissors the DOM rect of `#gantry-camera-feed` and renders the same scene again from a `PerspectiveCamera` at the carriage lens, `up = (0, 0, -1)`, with denser fog.
- Layer 1 (mast and housing) is hidden from the feed camera; layer 2 (HUD overlays) is drawn only by the main camera.
- Main-pass silt fog is `FogExp2`; above-water materials set `fog: false` so only underwater parts dissolve.
- Camera presets are fitted from a view direction plus subject points against the free screen rect measured from `data-lab` overlay elements.

## 4. Coordinates

- Gantry space is centimetres from the home corner: x 0 to 100, y 0 to 40.
- World space is Three.js metres, Y up, sand at Y = 0: `world.x = (x_cm - 50) / 100`, `world.z = (y_cm - 20) / 100`.
- Feed right is +world X and feed down is +world Z, in both `detection.ts projectToFeed` and the feed camera.
- The mapping lived only in `lib/sim/constants.ts`, which was a working agreement of the project and was respected in code.

## 5. Simulation engine

- Fixed 1/120 s substeps with an accumulator capped at 0.25 s; `tick(NaN)` and negative dt are ignored.
- Gantry: per-axis trapezoidal profile, 15 cm/s max at speed 1, 30 cm/s^2, clamped to travel, `PARK = (50, 20)`.
- Detection at 10 Hz: pinhole projection of rotated object bounds; `confidence = detectability * (1 - 0.30 r^2 - 0.15 burial) * exp(-1.1 turbidity^2 d / 0.42) * lighting^0.3 +- 0.01 seeded jitter`; 30 percent visible-box rule; 0.05 hysteresis; class degrades to UNKNOWN below 0.65 except `confusableAs` objects, which give a deterministic false positive.
- Controller: greedy step policy over five actions with decaying epsilon exploration, reward logged and not learned from.
- Test runner: home, six serpentine waypoints, dwell, pick the best correct detection, one control episode, result.
- Replay is a deterministic re-run: the clock, seed and log restart when homing completes.
- Store: `useSimStore` holds the engine, the 20 Hz snapshot and UI state (scene, camera preset, highlight, selection, demo).

## 6. Backend findings

The backend is legacy code from the project's earlier ROV dashboard and has no XY gantry support.

- `main.py` instantiates `HALBroker`, `FaultInjector` and `VisionPipeline`; `SerialBridge` is instantiated inside `HALBroker`.
- `/ws/command` handles only `SET_MODE`, `INJECT_FAULT` and `SET_PWM` (four thruster PWM values); `/ws/telemetry` streams depth, pressure, IMU, propulsion and power at 50 Hz.
- `hal/interfaces.py` defines IMU, environment, power and propulsion interfaces; `simulation/` is a four-thruster ROV physics engine with Gaussian sensor noise.
- `serial_bridge.py` sends JSON lines over `/dev/ttyAMA0` at 115200 baud and logs that it talks to an FRDM MCU.
- Bug: `SerialBridge.connect()` catches its own exception, so `HALBroker` sets `hardware_connected = True` even when the port failed to open.
- No firmware, no G-code, no GRBL handling, no homing, no limit switches and no XY motion command exist anywhere in the repository.
- `vision_pipeline.py` loads `yolov8n.pt` (COCO) with a monkeypatched `torch.load`, maps COCO ids to "tactical" labels (boat to SHIPWRECK, potted plant to CRACK), and tracks with `model.track`.
- In simulation it loops `underwater.mp4` (3.8 MB, procedurally generated ocean footage from `generate_video.py` / `generate_shipwreck.py`, not footage of the tank).
- MJPEG streaming from that MP4 works; the GStreamer UDP sink is hard-coded to `192.168.1.100:5000` and is not configured for any deployment.
- `generate_shipwreck.py` reads an image from an absolute path on a developer machine and cannot run elsewhere.
- The backend telemetry schema (propulsion, IMU, depth) does not match the gantry simulation schema (gantry position and velocity, detections, controller state).
- `vercel.json` sets `Permissions-Policy: microphone=()`, which would block push-to-talk.

## 7. Tests and baseline

Run against the unmodified source with `npm ci`:

| Check | Result |
|---|---|
| `npm run sim:check` | OK: golden run 5 detected, 3 correct, 1 false positive, coverage 90 percent, episode reward +15.64, 43.4 s, target `wreck-01` |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `git status` after the run | clean |

Playwright (`e2e/`, 12 specs) was not run against the source because it takes about 8 minutes under software GL; the specs were migrated and adapted instead.

## 8. Incompatibilities and decisions

| Finding | Decision |
|---|---|
| Backend is ROV-specific and unused by the browser | Excluded entirely; a new FastAPI backend was written (docs/MIGRATION_MAP.md) |
| No verified gantry protocol | New `SerialGantryDriver` written to the published GRBL 1.1 protocol, tested against a fake controller, labelled unverified, disabled by default |
| SerialBridge connect bug | Not migrated; the new driver raises on failure and the motion controller refuses moves while disconnected |
| YOLO with remapped COCO labels | Not migrated: COCO classes do not describe tank objects; the twin's geometric detector is the labelled baseline and SAM 3.1 the model path |
| `underwater.mp4` and GStreamer UDP | Not migrated: frames come from the digital twin render, or from an OpenCV device in hardware mode |
| Telemetry schema mismatch | New typed contracts in `backend/app/schemas.py` mirrored in `lib/api/types.ts` |
| Coordinate mapping only in TypeScript | Geometry moved to `shared/geometry.json`, read by both TypeScript and Python, with cross-language fixtures |
| Microphone blocked by policy | Push-to-talk requires `microphone=(self)` on any deployment that sets a Permissions-Policy |
