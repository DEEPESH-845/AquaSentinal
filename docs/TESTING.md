# Testing

| Command | What it checks |
|---|---|
| `npm run typecheck` | `tsc --noEmit`, strict |
| `npm run lint` | ESLint (Next.js core web vitals and TypeScript rules) |
| `npm run build` | Production build |
| `npm run sim:check` | Headless engine assertions, about half a second |
| `cd backend && .venv/bin/python -m pytest` | Backend unit, contract, API and integration tests, warnings treated as errors |
| `npm run e2e` | Playwright against `next dev` and the backend |
| `npm run eval:adaptive` | Fixed versus adaptive on all ten presets; fails if any preset does not replay identically (docs/TECHNICAL_EVALUATION.md) |
| `npm run eval:meta` | Mission-parsing accuracy offline; with `MODEL_API_KEY`, live Voice, Spark and SAM sections |

No routine test calls a paid API: Meta is an `httpx.MockTransport` and serial is a fake GRBL.

## `npm run sim:check` (`lib/sim/selfcheck.ts`)

- HydraLoom's original sections run unchanged on `referenceScenario()`: golden run (5 detected, 3 correct, 1 false positive, coverage 90 percent, reward +15.64, 43.4 s), determinism, tick-cadence independence, rail and speed invariants after every substep, detection edge cases, controller convergence, test runner, store.
- Store section: the store's run on the inspection layout equals a bare engine run on the same layout.
- Demo: reaches REPORT with a backend plan, with no backend (fixture fallback, labelled), with water that never clears, and with an operator stop.
- Missions: determinism of results, event logs and capture positions; captures at their waypoints; re-observation removes the confusable false positive in presets B, C, D and J; preset E pauses with no unreliable frames while the fixed strategy records them; no motion or capture while paused; speed capped in degraded visibility; water restored after a mission; operator resume refused in unsafe water; camera dropout blanks detections immediately; emergency stop zeroes velocity, latches and refuses every command; bad plans refused or clamped; every preset completes under both strategies.
- Perception maths: visibility monotonic in turbidity and light, ramp and dropout schedules.
- Cross-language fixtures: TypeScript trajectory and projection must equal `shared/fixtures/*.json`.

## Backend (`backend/tests/`, 56 tests)

| File | Covers |
|---|---|
| `test_contracts.py` | Projection and simulated driver trajectory equal the TypeScript fixtures; compiler produces the contract plan; scan orders; invalid specs rejected (unknown target, empty targets, out-of-range region, reversed region, speed, thresholds, path-like id, unknown field); plan size guards; policy defaults from `shared/perception.json` |
| `test_mission_logic.py` | Offline parser on the demo instruction and on opt-outs; the model sees only planning tools; dispatch refuses wrong phase, unknown tools and bad arguments; visibility controller states |
| `test_meta.py` | Invalid key (not retried, key never echoed); 429 with `Retry-After`; timeouts and 5xx retried then failing; 400 not retried; no key means no request; Spark planning loop recovering from bad arguments and refusing motion; Spark that never plans; structured frame reasoning request shape; non-JSON structured output; SAM output parsing to full-frame masks with null confidence; SAM request shape, stream failure and zero matches; WAV validation; Voice multipart payload and keywords |
| `test_hardware.py` | GRBL status parsing; connect, home, move G-code and e-stop; controller errors, alarms and missing banner; interlocks; watchdog on invalid telemetry, alarm and lost link; command deadline; simulated e-stop |
| `test_api.py` | Health, status and config without secrets; judge preflight lists missing credentials and unverified live Meta as blockers and identifies the simulated gantry and camera; offline mission lifecycle, transitions, captures, duplicate reuse and its guards (different inputs, failed results), injected segmentation failure, completion, JSON and Markdown report, frames, history; capture validation and voice offline; persistence and asset identity across restarts; event socket (invalid message, ping, replay), command socket (invalid, out of bounds, e-stop), start refused while latched, telemetry socket |
| `test_tracking.py` | Two doubtful cable sightings and one confident debris sighting at the same spot make one asset labelled debris; confident valve and pipe segment at one centre stay two assets; an asset keeps its id across two missions |
| `test_quality.py` | The image-quality estimate rises with frame contrast, a clear synthetic frame and a moderately murky one read GOOD, and a flat one reads UNRELIABLE |
| `test_integration.py` | Voice to report with mocked Meta: transcription, Spark tool calls, plan, capture, frame reasoning, three SAM requests, IoU against the ID pass, SAM observations, Spark summary, usage accounting; the execution log holds eight MOCKED records with references only (no key, image or instruction text) and the preflight does not count them as live connectivity; a failed call is logged with its status; unsafe model output never becomes a mission; Spark failure reported, explicit offline fallback; SAM rate limit and 400 isolated per request; backend executor on the simulated gantry with a pause in murky frames and an emergency stop |

## Measured strategy comparison

`npm run eval:adaptive` regenerates this table into `docs/evidence/adaptive-vs-fixed.json`; it was rerun on 2026-11-02 with identical results.
Measured on 2026-11-01 with `compareStrategies(presetScenario(id), shared/fixtures/pipeline-plan.json)`, seed 1337, simulated detector.
Rerunning gives identical numbers; the Environment scene runs the same function live.

| Preset | Strategy | Confirmed targets | False positives | Captures | Unreliable frames | Re-observations | Pauses | Duration s |
|---|---|---|---|---|---|---|---|---|
| A clear water | adaptive | 5 | 0 | 9 | 0 | 3 | 0 | 28.2 |
| A clear water | fixed | 5 | 0 | 6 | 0 | 0 | 0 | 18.3 |
| B loose cable | adaptive | 5 | 0 | 9 | 0 | 3 | 0 | 28.2 |
| B loose cable | fixed | 5 | 1 | 6 | 0 | 0 | 0 | 18.3 |
| C foreign objects | adaptive | 5 | 0 | 9 | 0 | 3 | 0 | 28.2 |
| C foreign objects | fixed | 5 | 1 | 6 | 0 | 0 | 0 | 18.3 |
| D occlusion | adaptive | 4 | 0 | 9 | 0 | 3 | 0 | 28.2 |
| D occlusion | fixed | 4 | 1 | 6 | 0 | 0 | 0 | 18.3 |
| E turbidity | adaptive | 4 | 1 | 8 | 0 | 2 | 1 | 45.1 |
| E turbidity | fixed | 1 | 0 | 6 | 3 | 0 | 0 | 18.3 |
| F lighting | adaptive | 2 | 1 | 8 | 0 | 2 | 0 | 28.7 |
| F lighting | fixed | 4 | 1 | 6 | 0 | 0 | 0 | 18.3 |
| G segmentation failure | adaptive | 5 | 0 | 9 | 0 | 3 | 0 | 28.2 |
| G segmentation failure | fixed | 5 | 1 | 6 | 0 | 0 | 0 | 18.3 |
| H camera dropout | adaptive | 5 | 0 | 9 | 0 | 3 | 1 | 35.2 |
| H camera dropout | fixed | 5 | 1 | 4 | 0 | 0 | 0 | 18.3 |
| I gantry limit | adaptive | 5 | 0 | 10 | 0 | 4 | 0 | 31.5 |
| I gantry limit | fixed | 4 | 1 | 6 | 0 | 0 | 0 | 18.3 |
| J multiple targets | adaptive | 7 | 0 | 9 | 0 | 3 | 0 | 28.2 |
| J multiple targets | fixed | 7 | 1 | 6 | 0 | 0 | 0 | 18.3 |

Observations from these numbers:

- Re-observation removes the rope offcut false positive in every preset where the fixed strategy keeps it.
- In E the fixed scan records three frames below the unsafe threshold and confirms one target; the adaptive scan pauses once and confirms four.
- In F the adaptive strategy is worse: slowing down in fading light only means imaging darker water, so it confirms two targets against four.
- The adaptive strategy always takes longer.
- Preset G is a backend fixture, so the twin numbers equal the default layout; its effect is on segmentation records.
- These are simulated-detector numbers; no SAM accuracy figure exists until a live run supplies IoU against the twin.

## Browser tests (`e2e/`)

`playwright.config.ts` starts `next dev` and the FastAPI backend in offline SIMULATION mode (no `MODEL_API_KEY`, hardware disabled), and reuses a server that is already listening on port 3000 or 8000.
When it starts the backend itself it deletes `e2e/.backend-data` first, so each run begins with an empty database; that folder sits outside `e2e/.results` because Playwright empties the results folder after the servers start.
Tests run in one worker, with a 120 s default timeout and 15 s per assertion.

`e2e/lab.ts` is the shared fixture.
It fails any test with a console error, page error or failed request, unless the test lists the expected ones in `audit.allow`.
It reads canonical state through the development hooks `window.__labStore` and `window.__missionStore`, waits on state predicates instead of sleeping, and fast-forwards the engine in slices (`fastForward`, `fastForwardUntil`) so a mission that takes minutes of simulated time finishes in seconds of wall time.
Chromium runs with software GL (`--use-angle=swiftshader`), so the first seconds of every test render slowly.
Actions go through the DOM; the store is used to read results and to skip waiting.

| Spec | What it checks |
|---|---|
| `boot.spec.ts` | Startup renders the canvas and feed, connects the backend, reports AI providers as OFFLINE, and publishes SIMULATED telemetry; no horizontal overflow at desktop width |
| `navigation.spec.ts` | Every scene opens from the rail with its card and camera preset; keyboard 1 to 8 and arrows navigate, and typing in a field does not; rapid switching settles |
| `camera.spec.ts` | Each scene's camera preset, the follow preset tracking the carriage, feed orientation (right is +X, down is +Y), rapid preset switching and reset mid-tween |
| `gantry.spec.ts` | Home, click to move, travel limits and stop; invalid store commands cannot leave the rails; centring on an object |
| `detection.spec.ts` | Every detected object keeps its box; only anomaly candidates and unknowns get a SIM label, inside the feed; the state is shown by corner style, not text; two labels that would overlap leave only the more confident one; the far corner, turbidity 1, lighting 0 and the threshold gate the detections |
| `environment.spec.ts` | Sliders and object fields clamp and revert junk; preset E loads its disturbance schedule; compare strategies measures adaptive against fixed |
| `perception.spec.ts` | A manual capture renders a 640 x 480 frame, goes through the backend pipeline and shows labelled results; scenario G shows the injected segmentation failure |
| `mission.spec.ts` | Instruction to offline plan to approved run to backend report with exports and history; pause, refused resume in unsafe water and stop; the mission is completed only after its last frame has landed, and a frame that lands late refreshes the report on screen |
| `estop.spec.ts` | E-stop latches the twin and the backend gate, blocks motion and approval, clears on request; an e-stop ends a running mission; a backend latch that outlives the twin's reset still shows Clear e-stop, and approve says how to clear it |
| `intelligence.spec.ts` | Scene 08 offline: preflight says live Meta is not verified and why, the execution log is empty, no step carries a LIVE META tag, an offline plan is tagged OFFLINE FALLBACK and the plan DETERMINISTIC; a mocked execution is shown as MOCKED, never live; every scene's provenance badge matches the registry and inherited scenes never say HACKATHON-BUILT |
| `demo.spec.ts` | The judge demo opens on scene 08 and runs INTRO, COMMAND, PLAN, SCAN, PERCEIVE, ADAPT and REPORT in order (offline, COMMAND says the instruction is typed because Voice Transcribe needs a key), with the engine fast-forwarded in slices while the mission runs; the plan comes from the backend (`demo.usedFixture` is false), the mission pauses at least once and completes, the backend report holds every capture, and the REPORT card shows the mission metrics; pause freezes the demo clock and replay and exit return to a clean lab |
| `redteam.spec.ts` | Seeded random clicks across scenes and buttons; hostile text in the instruction box (markup, injection strings, control characters, the 2000 character limit); number fields and sliders with out-of-range and garbage values; reset during a mission ends it on both sides and the lab can plan again; e-stop spam ends with a way out whenever either latch is set; reload during a mission and demo interrupts |
| `responsive.spec.ts` | At 390 x 844, 768 x 1024, 1024 x 768, 1280 x 720, 1440 x 900 and 1920 x 1080: no horizontal overflow, the AQUASENTINAL brand is whole, Run demo, Reset lab and Emergency stop are inside the viewport, and on every scene the card is inside the viewport and does not cover the camera feed |
| `visual.spec.ts` | One screenshot per scene at 1440 x 900 in the default lab state, with a 4 percent pixel tolerance because the 3D view is software-rendered |
| `refinement.spec.ts` | Card and telemetry collapse and expand, F and the focus button toggle both repeatedly; the guided tour steps through nine steps by button and arrow key, switches scenes, reports "waiting" until the user really plans a mission and "planned" after, lets the controls under the spotlight work, finishes, restarts and closes on Escape; with the backend unreachable the Mode and AI chips read UNKNOWN and the health panel has six UNKNOWN rows and no healthy one; the mission state strip moves IDLE, READY, INTERPRETING, FAILED on cancel, then AWAITING_APPROVAL; perception view modes switch by mouse and arrow key, the compare divider is a range input, and a populated Perception card stays clear of the feed column; the gantry plan view jogs from the keyboard without switching scenes |
| `walkthrough.spec.ts` | `/walkthrough` renders all eight sections; scrolling into section 06 and its range input both change the twin's turbidity; the call to action opens mission control; three client-side round trips leave the same ScrollTrigger count on every visit, none on `/`, and the twin's turbidity restored |
| `backend-offline.spec.ts` | With every backend request failing: the twin keeps working, the UI says the backend is down and refuses to plan, and captures are kept locally and labelled |

Commands:

```bash
npx playwright test                  # whole suite, about 8 minutes, most of it the demo
npx playwright test e2e/estop.spec.ts
npm run e2e:update                   # rewrite the screenshot baselines in e2e/__screenshots__
```

Baselines are only valid for the machine and browser that produced them: review the changed images before committing them, and regenerate them after a deliberate layout change.
