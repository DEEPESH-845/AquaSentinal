# Hackathon contributions and provenance

AquaSentinal extends HydraLoom, a pre-existing project by the same author.
HydraLoom source: https://github.com/DEEPESH-845/HydraLoom at commit `d59308e17ff483a54512bc340f6351e779fb26e7` (last commit 2026-09-15, first commit 2026-05-25).
AquaSentinal work started on 2026-11-01.
The typed registry behind the in-app labels is `lib/hackathon/contributions.ts`.
The per-file comparison against HydraLoom is `docs/evidence/provenance.tsv`, regenerated with `scripts/provenance.sh`.

## How to read this document

- **New**: does not exist in HydraLoom in any form.
- **Adapted**: a HydraLoom file or mechanism that was extended; the entry names exactly what was added.
- **Inherited**: reused as built, or with import-level changes only. Never presented as hackathon work.
- **Status** follows the registry rules: implemented (code runs), tested (automated test, mocked HTTP or simulation), verified (live Meta call or physical hardware evidence).
- Nothing in this repository is verified yet. No `MODEL_API_KEY` has been available, so no live Meta request has been made, and no physical hardware has been driven.

## Per-file summary

From `docs/evidence/provenance.tsv` (138 tracked files at the time of writing):

| Origin against HydraLoom | Files | Meaning |
|---|---:|---|
| IDENTICAL | 14 | Byte-identical copies, for example `Aquarium.tsx`, `Gantry.tsx`, `Electronics.tsx`, `CameraRig.tsx`, `gantry.ts`, `detection.ts`, `policy.ts`, `rng.ts` |
| MODIFIED | 46 | Same path exists in HydraLoom; content changed. The size of the change is in the TSV; what it adds is below |
| NEW | 78 | Path does not exist in HydraLoom: the whole backend, perception, mission, Meta clients, evidence, UI panels, tests, docs |

A file at the same path is not automatically inherited work: `lib/sim/engine.ts` keeps HydraLoom's 490 lines and adds 515.
A file at a new path is not automatically original work: `backend/requirements.txt` and `backend/Dockerfile` replace HydraLoom files of the same name.

## Contributions

| Feature | Origin | Source | Implementation | Contribution | Meta model | Evidence | Demo moment |
|---|---|---|---|---|---|---|---|
| Voice-controlled mission creation | New | none | `lib/audio/wav.ts`, `backend/app/meta/voice.py`, `/api/voice/transcribe`, `lib/store/mission.ts` | Browser push-to-talk to 16 kHz mono WAV, server-side WAV validation, domain keyword biasing, transcript with input-source label (LIVE_MICROPHONE or RECORDED_INPUT) | Muse Voice Transcribe 1.0 | `test_integration.py::test_full_voice_to_report_pipeline` (mocked); status tested | Act 1 |
| Muse Spark mission interpretation | New | none | `backend/app/meta/spark.py`, `backend/app/mission/service.py`, `backend/app/mission/tools.py` | Agent loop with four allowlisted planning tools, invalid calls returned to the model, at most six turns, no silent provider substitution | Muse Spark 1.3 | `test_integration.py` (mocked), `test_meta.py`; status tested | Act 2 |
| Natural language to validated actions | New | none | `backend/app/schemas.py` `MissionSpec`, `backend/app/mission/compiler.py`, `ToolRegistry` | Model output is a spec, never a motor command; Pydantic validation, phase allowlist, plan compiler bounds every waypoint, speed and threshold; operator approval gate | none (deterministic) | `test_contracts.py`, `test_mission_logic.py`, `test_unsafe_model_output_never_becomes_a_mission` | Act 2 |
| Visual scene reasoning | New | none | `backend/app/perception/pipeline.py` `_reason` | Structured JSON on the first frame of a mission names the noun phrases SAM should segment; fallback phrase for any target the model omits | Muse Spark 1.3 | `test_integration.py` (mocked) | Act 3 |
| SAM 3.1 segmentation | New | none | `backend/app/meta/sam.py`, `pipeline.py` `_segment_one`, `components/ui/perception.tsx` | One concept per request, SSE parsing, Meta's `meta-sam-parser`, polygons, back-projection to gantry centimetres, IoU against the twin's ID pass | SAM 3.1 | `test_meta.py`, `test_integration.py` (mocked); live IoU section in `app/evaluation.py` not yet run | Act 3 |
| Persistent object tracking | New | none | `backend/app/perception/tracking.py` | Observations associated to persistent assets by position and accumulated label evidence, across captures and missions | none | `test_tracking.py` | Act 3, Act 5 |
| Image-quality decisions | New | none | `backend/app/perception/quality.py`, `backend/app/mission/executor.py` | OpenCV contrast and sharpness visibility estimate fitted to twin frames, quality band on every capture, drives the backend executor's controller | none | `test_quality.py`, `test_backend_executor_on_the_simulated_gantry` | Act 4 |
| Sensor-conditioned adaptive inspection | New | none | `lib/sim/perception.ts`, `lib/sim/engine.ts` `tickMission`, `backend/app/perception/controller.py` | Deterministic visibility controller: reduced speed, pause when unsafe, operator resume refused while unsafe, re-observation of uncertain detections | none | `npm run sim:check`, `npm run eval:adaptive` | Act 4 |
| Turbidity telemetry and disturbances | Adapted | `lib/sim/engine.ts`, `lib/sim/scenario.ts` | same files | HydraLoom had one static turbidity value; added timed turbidity, lighting and camera-dropout schedules, environment telemetry, per-capture water state | none | `npm run sim:check` | Act 4 |
| Mission orchestration | Adapted | `lib/sim/engine.ts`, `lib/sim/demo.ts`, `lib/sim/store.ts` | plus `backend/app/mission/service.py`, `executor.py` | New MISSION mode in the twin executing compiled plans with captures; backend lifecycle and transitions; backend executor on the gantry driver protocol | none | `test_api.py`, `test_integration.py`, `e2e/mission.spec.ts` | Acts 2 to 4 |
| Evidence generation and storage | New | none | `backend/app/db.py`, `backend/app/reporting.py`, `components/ui/report.tsx` | SQLite records for missions, captures, segmentations, assets, observations, summaries; frames on disk; JSON and Markdown reports; anomaly candidates always unverified | Muse Spark 1.3 (summary, when live) | `test_api.py`, `test_integration.py` | Act 5 |
| History and comparative reporting | New | none | `/api/inspection/history`, `/api/inspection/assets`, `lib/sim/compare.ts` | Mission history, assets across missions, same plan replayed with and without the adaptive policy | none | `test_missions_and_assets_persist_across_restarts`, `npm run eval:adaptive` | Act 5 |
| AI safety mechanisms | New | none (HydraLoom had no gantry protocol) | `backend/app/hardware/motion.py`, `drivers.py`, twin e-stop in `engine.ts` | Latching e-stop in twin and backend, start refused while latched, interlocks, watchdog, GRBL 1.1 driver disabled by default | none | `test_hardware.py`, `e2e/estop.spec.ts`; never run on hardware | Act 4 |
| Scenarios A to J | Adapted | `lib/sim/scenario.ts` | same file | HydraLoom objects kept as `REFERENCE_OBJECTS`; new pipeline layout and ten presets | none | `npm run sim:check`, `npm run eval:adaptive` | Act 4 (preset E) |
| Model execution log and preflight | New | none | `backend/app/meta/client.py`, `/api/evidence/model-executions`, `/api/system/preflight`, `components/ui/intelligence.tsx` | Every Meta request logged with model, operation, references, timing, outcome, trace id; LIVE_META, LIVE_META_FAILED or MOCKED decided by the transport, not a flag | all three | `test_integration.py`, `test_api.py::test_preflight_reports_missing_credentials_as_blockers`, `e2e/intelligence.spec.ts` | Act 1 to 5 (log panel) |
| New inspection intelligence view and judge demo | New | `lib/sim/demo.ts` director (adapted) | `components/ui/intelligence.tsx`, `components/ui/overlays.tsx` `DemoCommand`, `components/ui/bridge.tsx` | Scene 08 with per-step execution classes; demo opens on it, sends the recorded instruction through Voice Transcribe when live, labels every fallback | all three | `e2e/intelligence.spec.ts`, `e2e/demo.spec.ts` | Whole demo |
| Evaluation harness | New | none | `backend/app/evaluation.py`, `scripts/evaluate-adaptive.ts`, `shared/fixtures/eval/` | Hand-labelled parsing set, SAM IoU on three captured twin frames, voice versus manual parameters, fixed versus adaptive sweep with replay check | all three (live sections) | `docs/evidence/evaluation.json`, `docs/evidence/adaptive-vs-fixed.json`; live sections NOT_RUN | Technical evaluation |
| Provenance tooling | New | none | `scripts/provenance.sh`, `lib/hackathon/contributions.ts`, scene origin badges | Per-file diff against the source commit; registry-driven badges that never mark inherited scenes as hackathon-built | none | `e2e/intelligence.spec.ts` (provenance test) | Intro |

## Inherited foundations

| Component | Origin | Source | Destination | Changes | Evidence | Shown in demo |
|---|---|---|---|---|---|---|
| Tank, gantry, electronics, camera rig 3D models | Inherited | `components/lab/Aquarium.tsx`, `Gantry.tsx`, `Electronics.tsx`, `CameraRig.tsx` | same | none (byte-identical) | `provenance.tsv` | As context only |
| Gantry kinematics, detection model, seeded RNG, step controller | Inherited | `lib/sim/gantry.ts`, `detection.ts`, `rng.ts`, `policy.ts` | same | none (byte-identical) | `provenance.tsv`, HydraLoom golden run still passes in `sim:check` | No |
| Engine loop, substeps, replay | Inherited | `lib/sim/engine.ts` | same | MISSION mode and disturbances added (adapted entries above) | `sim:check` reference sections | No |
| Camera feed renderer | Inherited | `components/lab/FeedRenderer.tsx` | same | Inspection capture and shared fog added (+26 lines) | e2e camera | As context |
| Test objects | Adapted | `components/lab/TestObjects.tsx` | same | Pipe, flange, valve, cable, rope, wrench, panel models added (+171 lines) | e2e visual | As context |
| Zustand store, 20 Hz snapshot, design tokens, UI primitives | Inherited | `lib/sim/store.ts`, `app/globals.css`, `components/ui/shared.tsx` | same | Mission and demo actions, provenance tags | typecheck | No |
| Navigation scene (jog pad, travel map) | Inherited | HydraLoom Gantry scene in `components/ui/scenes.tsx` | Navigation (04) | Labels and the plan path | e2e gantry | No; badge reads INHERITED FOUNDATION |
| System scene component list | Inherited | HydraLoom System scene | System (02) | Model and driver service list added | e2e navigation | No; badge reads INHERITED FOUNDATION |
| Playwright fixture and specs | Adapted | `e2e/*.ts` | same | Updated for new scenes; new specs listed in docs/TESTING.md | `npm run e2e` | No |

HydraLoom's Python backend (ROV HAL, thruster physics, COCO YOLO, MP4 loop) was not migrated; docs/MIGRATION_MAP.md lists each excluded file and why.

## What the demo must not present as new

- The tank, gantry and electronics models, their rendering, the camera rig and orbit controls.
- Gantry motion profiles and the geometric detector's maths.
- The design system, panels and fonts.
- Any part of the System (02) or Navigation (04) scenes.
