# Technical evaluation

Every number below was produced by a command in this repository and can be regenerated.
Sections that need a Meta API key have not run, and no number is given for them.

| Experiment | Command | Classification | Status |
|---|---|---|---|
| Fixed-speed versus adaptive inspection | `npm run eval:adaptive` | SIMULATED | Run, results below |
| Mission parsing accuracy, offline parser | `npm run eval:meta` | DETERMINISTIC baseline | Run, results below |
| Mission parsing accuracy, Muse Spark | `npm run eval:meta` with `MODEL_API_KEY` | LIVE_META | **Not run: no key** |
| Voice-derived versus manually entered parameters | `npm run eval:meta` with `MODEL_API_KEY` | RECORDED_INPUT + LIVE_META | **Not run: no key** |
| SAM 3.1 segmentation IoU on twin frames | `npm run eval:meta` with `MODEL_API_KEY` | SIMULATED input + LIVE_META | **Not run: no key** |
| Baseline visual processing versus SAM 3.1 | none | n/a | **Not built**, see section 3 |

## 1. Fixed-speed versus adaptive inspection

Same compiled plan (`shared/fixtures/pipeline-plan.json`, six captures over one lane), same seed, every scenario preset, twin detector and water model.
Fixed: constant plan speed, no re-observation, no pause.
Adaptive: the deterministic visibility controller (reduced speed in degraded water, pause when unsafe, re-observation of uncertain detections).
Each preset was run twice; both runs were identical for all ten presets.
Raw output: `docs/evidence/adaptive-vs-fixed.json`.

| Preset | Strategy | Captures | Unreliable frames | Re-observations | Pauses | Targets confirmed | False positives | Duration s |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| A Clear water | fixed | 6 | 0 | 0 | 0 | 5 | 0 | 18.3 |
| A Clear water | adaptive | 9 | 0 | 3 | 0 | 5 | 0 | 28.2 |
| B Loose cable | fixed | 6 | 0 | 0 | 0 | 5 | 1 | 18.3 |
| B Loose cable | adaptive | 9 | 0 | 3 | 0 | 5 | 0 | 28.2 |
| C Foreign objects | fixed | 6 | 0 | 0 | 0 | 5 | 1 | 18.3 |
| C Foreign objects | adaptive | 9 | 0 | 3 | 0 | 5 | 0 | 28.2 |
| D Partial occlusion | fixed | 6 | 0 | 0 | 0 | 4 | 1 | 18.3 |
| D Partial occlusion | adaptive | 9 | 0 | 3 | 0 | 4 | 0 | 28.2 |
| E Turbidity increase | fixed | 6 | 3 | 0 | 0 | 1 | 0 | 18.3 |
| E Turbidity increase | adaptive | 8 | 0 | 2 | 1 | 4 | 1 | 45.2 |
| F Lighting degradation | fixed | 6 | 0 | 0 | 0 | 4 | 1 | 18.3 |
| F Lighting degradation | adaptive | 8 | 0 | 2 | 0 | 2 | 1 | 28.7 |
| G Segmentation failure | fixed | 6 | 0 | 0 | 0 | 5 | 1 | 18.3 |
| G Segmentation failure | adaptive | 9 | 0 | 3 | 0 | 5 | 0 | 28.2 |
| H Camera disconnect | fixed | 4 | 0 | 0 | 0 | 5 | 1 | 18.3 |
| H Camera disconnect | adaptive | 9 | 0 | 3 | 1 | 5 | 0 | 35.2 |
| I Gantry limit | fixed | 6 | 0 | 0 | 0 | 4 | 1 | 18.3 |
| I Gantry limit | adaptive | 10 | 0 | 4 | 0 | 5 | 0 | 31.5 |
| J Multiple targets | fixed | 6 | 0 | 0 | 0 | 7 | 1 | 18.3 |
| J Multiple targets | adaptive | 9 | 0 | 3 | 0 | 7 | 0 | 28.2 |

What this shows, within the simulation:

- In the turbidity scenario (E) the fixed scan recorded 3 frames below the unsafe visibility threshold and confirmed 1 target; the adaptive scan paused once, recorded no unreliable frame and confirmed 4.
- Re-observation removed the confusable rope false positive in B, C, D, G, H, I and J (1 to 0).
- In the camera dropout (H) the fixed scan lost 2 of 6 captures; the adaptive scan paused and kept all its captures.
- The cost is time: adaptive inspection took 55 percent longer in clear water (28.2 s against 18.3 s) and 147 percent longer in E, because it re-observes and waits.

Where adaptive did worse, also within the simulation:

- Lighting degradation (F): adaptive confirmed 2 targets against 4 for fixed. The slower scan spends more time in the dark part of the schedule. Lighting is not a controller input today.
- Turbidity (E): adaptive kept 1 false positive that the fixed scan did not produce, from a re-observation made in murky water.

Limits: the detector is the twin's geometric model with seeded noise, not a camera or a neural network; water and light are simulated; one plan; ten presets.
These are properties of the controller in the twin, not field performance.

## 2. Mission parsing accuracy

Data: `shared/fixtures/eval/instructions.json`, 12 instructions with hand-written expected values for objective, targets, scan pattern, reduce-speed and stop-on-unsafe policies.
The labels were written for this evaluation by the developer, before the parsers were scored; they are not real operator data.
Scoring: a case is fully correct only when all five fields match exactly; target precision and recall are averaged over cases.

| Parser | Fully correct | Objective | Targets exact | Scan pattern | Reduce speed | Stop on unsafe | Target precision | Target recall |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Offline keyword parser | 4 / 12 | 1.00 | 0.33 | 0.92 | 1.00 | 0.92 | 0.70 | 0.88 |
| Muse Spark 1.3 | not run | | | | | | | |

Observed offline failures: it always adds pipe joints to pipeline inspections (a deliberate safe default that the labels do not ask for); it cannot map "hose" to a loose cable, "anything that does not belong" to a foreign object, or "lying on it" to a foreign object; it does not understand "keep going even if the water gets murky" or "from the right end".
These are the cases a language model is expected to handle, which is the hypothesis the Muse Spark row will test.

## 3. Segmentation

Data: three 640 x 480 frames captured by the product from the digital twin (`shared/fixtures/eval/frames/`), clear (turbidity 0.15), hazy (0.52) and murky (0.67), each with the renderer's per-object ID pass.
Prompts: "orange cable", "blue crate", "pipe flange", fixed so every run asks the same question.
Metric: best IoU between a returned mask and the ground-truth silhouette of the prompted object, and the rate at which the prompted object is found.
Ground truth is the renderer's silhouette, which is exact for the twin and says nothing about real underwater footage.

Status: not run, because SAM 3.1 needs `MODEL_API_KEY`.

Baseline: there is no image-based baseline in this build.
The twin's simulated detector reads object geometry with noise, so comparing its boxes to SAM masks would compare a model to the answer key.
HydraLoom's COCO YOLO was not migrated because its classes do not describe these objects (docs/ENGINEERING_AUDIT.md).
A fair baseline (colour thresholding or a small detector trained on twin frames) is listed as future work and is not claimed.

## 4. Voice-derived versus manually entered parameters

Design: the recorded demo instruction (`public/demo/instruction.wav`, synthetic speech) goes through Voice Transcribe, the transcript goes to Muse Spark, and the resulting spec is scored against the hand-labelled spec of the same instruction; word error rate of the transcript is reported.
A manually entered mission sets 9 parameters (objective, targets, scan pattern, two visibility policies, region, lane spacing, capture spacing, speed).
Status: not run, because Voice Transcribe and Muse Spark need `MODEL_API_KEY`.
No time saving is claimed; it has not been measured with operators.

## 5. Reproducibility

- `npm run eval:adaptive` throws if any preset differs between two runs; all ten replay identically.
- `npm run sim:check` asserts determinism of mission results, event logs and capture positions, and that the TypeScript gantry trajectory and camera projection equal the shared fixtures that the Python port is tested against.
- The judge demo always loads preset E with fixed disturbance times and the same seed, so the gantry path and the turbidity rise are identical on every run.
- Meta calls are not deterministic and are not replayed; each one is logged instead.

## 6. Failure handling

| Failure | Behaviour | Test |
|---|---|---|
| Segmentation fails | Capture keeps its frame and quality record; the segmentation is FAILED with the error; a failed result is retried, never reused | `test_segmentation_timeout_and_rate_limit_are_isolated_per_request`, `test_duplicate_reuse_requires_same_inputs_and_a_successful_result`, `e2e/perception.spec.ts` scenario G |
| Visibility becomes poor | Reduced speed, then pause; operator resume refused while unsafe; outcome STOPPED_UNSAFE_VISIBILITY if stopped while paused | `sim:check` missions section, `e2e/environment.spec.ts` |
| Camera disconnects | Detections blank immediately, adaptive scan pauses, no capture while offline | `sim:check` preset H |
| API request times out or is rate limited | Retries with backoff and `Retry-After`; 400, 401, 402, 404 not retried; logged as LIVE_META_FAILED when live | `test_meta.py`, `test_integration.py` |
| Mission produces invalid actions | Motion tools are not offered in planning; invalid calls return to the model; after six turns the request fails and nothing is stored or moved | `test_unsafe_model_output_never_becomes_a_mission`, `test_spark_planning_loop_reads_state_recovers_from_bad_args_and_refuses_motion` |
| Gantry reaches a movement limit | Plans compiled inside soft limits; interlocks refuse out-of-bounds moves; preset I reaches the corner | `test_contracts.py`, `test_interlocks_block_unsafe_moves`, `sim:check` preset I |
| Emergency stop | Latches twin and backend, zeroes velocity, refuses start and every command until cleared | `e2e/estop.spec.ts`, `test_simulated_driver_estop_is_immediate` |
| Live Meta call fails during the demo | Error shown in the demo card; the typed instruction or the labelled offline parser is used only with that label; no mocked response is substituted | `e2e/demo.spec.ts`, `test_spark_failure_is_reported_not_faked` |
