# Submission strategy

Judging weights: Impact 30%, Use of Meta AI tooling 25%, Technical depth 20%, Demo 25%.
This file is the plan for the video, the judge path, the answers to likely questions and the owner's steps once the Meta key exists.

## Where we stand (state this plainly in the submission)

Built and tested:

- Mission control: voice or text instruction, Muse Spark planning with allowlisted tools, operator approval, the twin executes, SAM perception, a deterministic controller that slows and pauses in murky water, an evidence report.
- Credit governor: response cache, cascade gating, a USD budget cap and a passcode live lock, with a credit meter chip in the top bar.
- Hindi and English voice and AI output.
- Ask the Inspector: questions answered from the stored records, citing captures; clicking a citation moves the twin to that asset.
- Work orders with evidence frames and a print layout.
- Real water camera: one phone or laptop frame to SAM 3.1.
- Provenance on every output (scene 08 and the credit chip popover) and `GET /api/evidence/model-executions`, the log of every Meta request.

Not built: the murk benchmark, the live-run recorder, the `/proof` page and the recorded replay.
They need a live key to have anything to show, so they were cut.

Not true yet: there is no recorded live run.
No `MODEL_API_KEY` has been set, so the deployed app and the demo video are in labelled offline mode, and every Meta code path has only been tested against mocked HTTP.
The first real run may need shape fixes (docs/JUDGING_READINESS.md item 5 is still the blocker).
Say this in the submission text before a judge discovers it.

## Judge path

Three steps, also in the README.

1. Watch the demo video (about 2:30).
2. Open https://aquasentinal-meta.vercel.app and run the demo: press `8`, then Start judge demo; then in Report (`7`) try Ask the inspector and Print work orders; open the credit chip popover.
   The backend (https://aquasentinal-backend.onrender.com) sleeps when idle, so the first load can take a minute.
3. Try the real water camera from the header camera icon on a phone or laptop.
   Without the key it says "SAM 3.1 needs the Meta key" and still shows the frame.

What a judge can verify without a key: the labels.
Anything not logged as a Meta request says OFFLINE, SIMULATED or DETERMINISTIC.
Once the key is set, `GET /api/evidence/model-executions` is the proof, row by row.

## Video: 2:30, beat by beat

The existing recording (`../AquaSentinal-demo.mp4`, outside the repo, not committed) was made offline by `scripts/record-demo.mjs`, so it follows these beats with OFFLINE captions.
The live re-recording keeps the same beats.

| Time | Screen | Say | Must be visible |
|---|---|---|---|
| 0:00 to 0:08 | The hook. Cold open on the camera feed in the twin as the water clouds from clear to murky (scenario with a turbidity rise) | "In murky water you find out afterwards that half your footage is useless. We built a rig that finds out first." | The feed degrading, no title card first |
| 0:08 to 0:22 | Walkthrough opening, the need of the hour | "About three crore people in India live off fisheries and aquaculture, and checking water you cannot see through is hard for people and for cameras." Show the PIB and arXiv source line on screen | Sources from docs/IMPACT_AND_MARKET.md only |
| 0:22 to 0:50 | Mission (05): language set to Hindi or English, instruction spoken or typed, Muse Spark plan, tool timeline, Approve | "You say the job. Muse Spark turns it into a plan through allowlisted tools. It cannot move anything. A person approves." | Provider tag on the plan; HindiNeedsMeta label if offline |
| 0:50 to 1:10 | The twin executes; Perception (03) with SAM 3.1 masks and asset ids | "Each frame goes to SAM 3.1. Masks become tracked findings, so one cable is one cable." | SAM provider tag |
| 1:10 to 1:30 | Environment (06): turbidity rises, state goes NORMAL to REDUCED VISIBILITY to PAUSED | "This is deterministic code, not the model. It slows, then refuses to record frames it cannot trust." | The word DETERMINISTIC or the controller state |
| 1:30 to 1:50 | Report (07): Ask the inspector, click a citation, the twin moves to that capture | "Ask where the loose cable is. Every claim cites a capture, and clicking it takes you there." | The citation and the twin camera moving |
| 1:50 to 2:05 | Work orders, then Print work orders | "Findings become prioritised work orders with their evidence, one page each." | Print preview or the panel, evidence frames |
| 2:05 to 2:20 | Credit chip popover, then scene 08 provenance | "Every Meta call passes a governor: cache, budget cap, passcode lock. Every output says where it came from." | Cache, saved and budget lines; the provenance tags |
| 2:20 to 2:30 | Real water camera, a hand-held phone clip of eight seconds if live, else the panel with the offline label; then the closing card | "Point a camera at real water. Talk to the rig. Trust the findings." Links on screen | Frontend URL; "SAM 3.1 needs the Meta key" if offline |

Rules for the cut:

- Never let a caption claim a live Meta call that the log does not show.
- Offline recording: keep the "Honest by design" caption (no key is set, every panel says OFFLINE).
- The camera shot cannot be scripted headless; record it by hand on a phone and cut it in at 2:20.

## Likely judge questions and honest answers

| Question | Answer |
|---|---|
| Did you actually call Meta's models? | Not yet in a recorded run: no `MODEL_API_KEY` was available. Muse Spark, SAM 3.1 and Voice Transcribe are implemented to the documented API shapes and tested against mocked HTTP (143 backend tests). A LIVE label appears only after a successful request is logged, and `GET /api/evidence/model-executions` will show it. |
| Why does the live site say OFFLINE? | Because the deployment has no key. That is the system working as designed: it never shows offline output as live. |
| What stops you burning credits? | The governor: identical requests come from a cache, perception calls pass a cascade gate, a USD cap (`AQUA_META_BUDGET_USD`, default 1.00) refuses a call before it is sent, and an optional passcode keeps strangers from spending. The meter is in the top bar. Spend is an estimate from list prices. |
| Is the rig real? | No. The digital twin is the plant. The GRBL driver and interlocks are tested against a fake controller and have never moved hardware. The real-world input is the phone or laptop camera frame. |
| Does the language model drive the motors? | No. It can only call allowlisted planning tools; the backend validates and compiles bounded waypoints; a human approves; a deterministic controller slows and pauses. |
| How well does SAM 3.1 work in murky water? | Unmeasured. The murk benchmark was not built. The adaptive numbers in the walkthrough come from the simulation (fixed speed records three unreliable frames, adaptive records none on preset E) and are labelled SIMULATED. |
| Who is the customer? | A hypothesis: recirculating aquaculture and treatment-plant operators with a rail or bridge over a tank. No operator has been interviewed. Context figures with sources are in docs/IMPACT_AND_MARKET.md; Indian inspection cost and diver safety figures could not be sourced and are not claimed. |
| Why Hindi? | The people who would use this in India work in Hindi and English. Voice Transcribe is biased to both and the AI output follows the chosen language. Hindi quality has not been checked live; offline the app says Hindi needs the Meta models. |
| Is Ask the Inspector just a chatbot? | It reads stored mission records through read-only tools and must cite captures; the citation moves the twin. Offline, a labelled records query answers instead. |
| What is new versus inherited? | The tank, gantry and camera rig come from HydraLoom. Everything about Meta models, planning, perception, evidence, governor, Hindi, Ask and work orders was built for the hackathon. See docs/HACKATHON_CONTRIBUTIONS.md and `docs/evidence/provenance.tsv`. |
| Are the impact numbers real? | They are targets, not results. Three context figures are sourced (PIB, NIOSH, arXiv). The prototype's own numbers are simulated. |

## Owner's checklist once the key arrives

1. On Render, set `MODEL_API_KEY` and `AQUA_LIVE_PASSCODE` (at least 16 random characters, for example `openssl rand -hex 12`).
   Keep `AQUA_META_BUDGET_USD` at 1.00 unless you decide otherwise; the free plan's disk is ephemeral, so the tally restarts with the service.
2. Redeploy Render first, wait for `/api/health`, then redeploy Vercel.
   The interpret request now carries a `language` field and the backend rejects unknown fields, so a new frontend against an old backend breaks planning.
3. Verify on the live site: enter the passcode from the AI chip, plan one mission, check that scene 08 Judge preflight reads "live Meta verified", and that `curl https://aquasentinal-backend.onrender.com/api/evidence/model-executions?limit=50` shows LIVE_META rows for transcription, mission_planning and segmentation.
   Expect to fix response-shape mismatches: these paths have only run against mocks.
4. Run `npm run eval:meta` once and commit the resulting evidence files (docs/META_USAGE_EVIDENCE.md says where).
5. Re-record: `SITE=... API=... node scripts/record-demo.mjs <out-dir>`, then edit the captions in `scripts/record-demo.mjs` for live mode before you run it.
   The "Honest by design" caption and the closing "plug in a key" caption currently describe offline mode and would be false.
   The script does not enter the passcode, so record against a local stack with `MODEL_API_KEY` exported and no `AQUA_LIVE_PASSCODE` (`SITE=http://localhost:3000 API=http://localhost:8000`), or unset the passcode on Render for the recording and set it again afterwards.
   Speed up the segment between the `wait-start` and `wait-end` marks in `marks.json`.
6. Update the README status row, docs/JUDGING_READINESS.md item 5 and this file's "Not true yet" section to match what the log shows.
7. After the recording and submission, remove `MODEL_API_KEY` from Render, or keep the passcode set, so the budget cannot be spent by strangers.
   If you remove the key, the deployed app goes back to labelled offline mode, so say in the submission that the video is the live evidence.
