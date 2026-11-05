# Migration map: HydraLoom to AquaSentinal

Source commit: `d59308e17ff483a54512bc340f6351e779fb26e7`.
Files were copied into this repository; nothing at runtime depends on the HydraLoom checkout.
Status meanings: copied (unchanged apart from imports), adapted (same module, extended or retargeted), refactored (rewritten around the original), excluded (not migrated), new.

## Simulation (`lib/sim/`)

| Source | Destination | Status | Reason and modifications | Verified by |
|---|---|---|---|---|
| `lib/sim/constants.ts` | same | adapted | Gantry travel, motion limits and camera optics now come from `shared/geometry.json`; added `PERCEPTION` from `shared/perception.json` and capture size | `sim:check` golden run, `backend/tests/test_contracts.py` |
| `lib/sim/types.ts` | same | adapted | Inspection object classes, `ModelKind`, `Disturbance`, mission plan, perception state, capture request, mission result and snapshot types | `npm run typecheck` |
| `lib/sim/scenario.ts` | same | refactored | HydraLoom objects kept as `REFERENCE_OBJECTS`; new `INSPECTION_OBJECTS` pipeline layout; ten presets A to J | `sim:check` missions section |
| `lib/sim/rng.ts` | same | copied | Seeded PRNG unchanged | `sim:check` determinism |
| `lib/sim/gantry.ts` | same | copied | Trapezoidal motion unchanged | `sim:check`, trajectory fixture parity in pytest |
| `lib/sim/detection.ts` | same | copied | Detection model unchanged | `sim:check` golden numbers |
| `lib/sim/policy.ts` | same | copied | Controller unchanged, still used by the baseline test runner and object centring | `sim:check` controller section |
| `lib/sim/engine.ts` | same | adapted | Scenario factory constructor, MISSION mode, latching emergency stop, capture queue, disturbances, mission result, environment telemetry; existing modes untouched | `sim:check` all sections |
| `lib/sim/demo.ts` | same | refactored | Seven mission phases (INTRO on scene 08 to REPORT) gated on engine and plan state, recorded instruction through Voice Transcribe when live, labelled fixture plan fallback | `sim:check` demo section |
| `lib/sim/store.ts` | same | adapted | Mission, preset and e-stop actions; demo plan; mission snapshot fields | `sim:check` store section |
| `lib/sim/selfcheck.ts` | same | adapted | HydraLoom assertions run on `referenceScenario`; new missions, perception and fixture sections | `npm run sim:check` |
| (none) | `lib/sim/perception.ts`, `compare.ts`, `fixtures.ts` | new | Visibility estimate and disturbance schedule; headless strategy comparison; cross-language fixtures | `sim:check` |

## 3D scene (`components/lab/`)

| Source | Destination | Status | Reason and modifications | Verified by |
|---|---|---|---|---|
| `Aquarium.tsx`, `Gantry.tsx`, `Electronics.tsx`, `CameraRig.tsx`, `util.ts` | same | copied | Physical model and camera fitting reused as built | e2e boot, navigation, camera, visual |
| `TestObjects.tsx` | same | adapted | Dispatch by `model`; new pipe section (fouled variant), flange, gate valve, cable, rope, wrench, panel; legacy models kept | e2e visual, browser inspection |
| `Overlays.tsx` | same | adapted | Callouts point at the valve; target ring in MISSION mode; new `PlanPath` overlay | e2e visual |
| `FeedRenderer.tsx` | same | adapted | Shared feed fog; renders pending inspection captures through `capture.ts` | e2e camera, capture flow |
| `SimDriver.tsx` | same | adapted | Passes the backend demo plan to the director | `sim:check` demo, e2e demo |
| `Scene.tsx` | same | adapted | Mounts `PlanPath`; exposes `window.__missionStore` in development | e2e fixture |
| (none) | `capture.ts` | new | 640 x 480 tone-mapped frame and ID pass from the same scene | e2e capture flow, pytest capture contract |

## Interface (`components/ui/`, `app/`)

| Source | Destination | Status | Reason and modifications | Verified by |
|---|---|---|---|---|
| `LabUI.tsx` | same | adapted | New scene names, mode, backend and AI chips, always-visible e-stop, wide cards, `BackendBridge` | e2e navigation, responsive |
| `CameraFeed.tsx` | same | adapted | Detector boxes labelled SIM; no-signal state; perception state badge | e2e camera |
| `Telemetry.tsx` | same | adapted | Environment, mission and AI sections replace the controller section | e2e |
| `shared.tsx` | same | adapted | Provenance `SourceTag`, danger button, class helpers | typecheck |
| `scenes.tsx` | same | refactored | Overview, system architecture, navigation, environment cards; RL control and result cards removed | e2e |
| `overlays.tsx` | same | adapted | Demo card for mission phases; closing moment rewritten | e2e demo |
| (none) | `mission.tsx`, `perception.tsx`, `report.tsx`, `bridge.tsx`, `intelligence.tsx` | new | AI mission control, perception viewer, report, backend glue, scene 08 pipeline view with execution tags and judge preflight | e2e |
| `app/layout.tsx`, `page.tsx`, `globals.css`, `favicon.ico` | same | adapted | Metadata; design tokens kept; danger button style | build |

## Configuration and tests

| Source | Destination | Status | Reason |
|---|---|---|---|
| `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`, `playwright.config.ts`, `.gitignore`, `AGENTS.md` | same | adapted | Package renamed, scripts added, `reference/` ignored by lint |
| `e2e/*.ts` | `e2e/` | adapted | Fixture and specs kept and updated for the new scenes |
| `e2e/__screenshots__/*` | (none) | excluded | Baselines regenerated for the new interface |
| `vercel.json` | same | adapted | Permissions-Policy now allows `microphone=(self)` for push-to-talk and `camera=(self)` for the real water camera; build runs typecheck and lint; the frontend-only deploy still cannot run the backend |
| `docs/HANDOFF.md`, `docs/BLUEPRINT.md`, `README.md`, `CLAUDE.md` | (none) | excluded | Superseded by the documents in this folder |
| `public/*.svg` | (none) | excluded | Next.js starter assets, unused |

## Backend (`backend/`)

| Source | Status | Reason |
|---|---|---|
| `main.py` | excluded | ROV command and telemetry contract; replaced by `backend/app/main.py` |
| `serial_bridge.py` | excluded | FRDM JSON protocol, connect bug; replaced by `backend/app/hardware/drivers.py` |
| `hal/broker.py`, `hal/interfaces.py` | excluded | Thruster, IMU and depth HAL; replaced by the gantry driver protocol and `MotionController` |
| `simulation/physics_engine.py`, `sensor_sim.py` | excluded | Four-thruster ROV physics; the gantry simulation is a port of `gantry.ts` |
| `simulation/fault_injector.py` | excluded | Mutates ROV internals; fault scenarios are now twin presets (G, H) and test fixtures |
| `vision_pipeline.py` | excluded | COCO YOLO with relabelled classes, MP4 source, unconfigured GStreamer sink; replaced by the perception pipeline and `CameraManager` |
| `generate_video.py`, `generate_shipwreck.py`, `underwater.mp4`, `yolov8n.pt` | excluded | Not tank footage; one script depends on a file on a developer machine |
| `requirements.txt`, `Dockerfile`, `docker-compose.yml` | excluded | Replaced by `backend/requirements.txt` and `requirements-dev.txt` |
