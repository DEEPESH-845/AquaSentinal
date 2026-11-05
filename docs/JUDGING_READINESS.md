# Judging readiness

Internal estimate on 2026-11-02, written to be critical.
These are not official results.
A score above 8 requires evidence a judge can see; planned or mocked work does not count.

## Stage One: pass or fail

| # | Requirement | Status | Evidence | Action |
|---|---|---|---|---|
| 1 | Matches the Push the Frontier track | Pass, to confirm | Multimodal agent controlling a physical-world system with perception-conditioned behaviour | Team to check the official track wording |
| 2 | Tangible real-world problem | Pass | docs/IMPACT_AND_MARKET.md | Validate with operators (not a blocker) |
| 3 | Uses the Meta Model API or open-weight models | Pass in code | `backend/app/meta/` for Voice Transcribe, Muse Spark, SAM 3.1 | none |
| 4 | Meta usage is meaningful | Pass in design | Voice to tool-calling planner to frame reasoning to segmentation to tracking; each model's output feeds the next subsystem | none |
| 5 | **The integration works** | **FAIL: unverified** | Zero LIVE_META executions; only mocked HTTP tests (docs/META_USAGE_EVIDENCE.md) | **Blocker.** Obtain a key, run `npm run eval:meta` and one judge demo, commit the execution logs |
| 6 | Hackathon contributions distinguishable | Pass | docs/HACKATHON_CONTRIBUTIONS.md, `docs/evidence/provenance.tsv`, registry-driven badges, e2e provenance test | Explain the batch-created first 49 commits (docs/CONTRIBUTION_AUDIT.md) if asked |
| 7 | Demo does not misrepresent inherited or simulated work | Pass if the script is followed | Execution tags derived from logged state; INHERITED FOUNDATION badges; SIMULATED gantry everywhere; e2e checks that no LIVE META tag appears offline | Follow docs/FINAL_DEMO_SCRIPT.md |

Stage One is blocked on item 5.
No amount of UI work changes that; a live run does.
A second risk outside the code: the hackathon's start date has not been checked against the 2026-11-01 start of AquaSentinal work.

## Stage Two: weighted estimate

| Category | Weight | Score | Weighted |
|---|---:|---:|---:|
| Impact | 30% | 5 | 1.50 |
| Use of Meta AI tooling | 25% | 4 | 1.00 |
| Technical depth and execution | 20% | 7 | 1.40 |
| Demo | 25% | 5 | 1.25 |
| **Total** | | | **5.15 / 10** |

### Impact: 5

- Evidence: a clear problem statement, a narrow first market (fixed tanks and basins), defined metrics, honest non-claims.
- Missing: any operator conversation, any sourced market figure, any measured improvement, a deployment environment beyond a bench tank.
- Risks: judges may see a bench-top gantry as far from open-water inspection; aquaculture tanks bring fish into the frame, which is untested.
- Actions: five operator conversations; two cited market numbers; one sentence each on buyer, budget line and replacement cost.

### Use of Meta AI tooling: 4

- Evidence: three Meta models in the core loop, not a chat wrapper; Muse Spark tool calling with a phase allowlist and self-correction; structured outputs; SAM 3.1 via Meta's own parser with masks back-projected into tracked, positioned assets; an execution log that cannot classify a mocked call as live.
- Missing: a single live execution. Without it the judge sees offline fallbacks where the models should be.
- Risks: if the live API differs from the documented shapes (SSE events, mask grammar, multipart fields) the first live run may fail and need fixes.
- Actions: get a key today; run `npm run eval:meta`; fix whatever the live API disagrees with; record the judge demo with LIVE META tags. With that evidence this category plausibly moves to 7 or 8; that is a projection, not a score.

### Technical depth and execution: 7

- Evidence: deterministic twin shared with a Python port through cross-language fixtures; AI-to-hardware split where the model produces a spec and a compiler bounds motion; latching e-stop, interlocks and watchdog; adaptive controller with measured fixed versus adaptive results on ten presets and a replay check; 143 backend tests, 22 Playwright spec files, failure handling mapped to tests (docs/TECHNICAL_EVALUATION.md).
- Missing: SAM IoU and Spark parsing accuracy (need a key); an image-based segmentation baseline; any physical hardware run.
- Risks: the twin's detector is geometric, so simulated perception results flatter the system; adaptive control did worse under fading light (preset F).
- Actions: run the live evaluation; add a simple colour-threshold baseline on the three eval frames; feed lighting into the controller or state the limit in the demo.

### Demo: 5

- Evidence: a one-click judge mode on a fixed scenario that runs the real services, opens on the new pipeline, labels every step's provenance, and has a written script, shot list and checklist; the automated demo passes end to end in Playwright.
- Missing: the live Meta moments that make it impressive; a recorded video.
- Risks: without a key every model step reads OFFLINE FALLBACK, which is honest but not compelling; network failure on stage.
- Actions: record the video with a key, following docs/DEMO_SHOT_LIST.md; keep the technical backup path rehearsed.

## Update on 2026-11-05 (branch `feat/meta-hero`)

The scores above are not re-estimated: the gaps that carry the weight (a live execution, a recorded live run) still need the key.
This section lists what changed so the next estimate starts from facts.

| Area | What changed | Where to see it | Still needs the key |
|---|---|---|---|
| Credit discipline | Response cache, USD budget cap, saved-calls counter and an optional passcode lock sit under every Meta call; a header chip shows spend and lock state | Credit chip in the header, `GET /api/system/status`, `backend/tests/test_governor.py`, `e2e/credits.spec.ts` | A live call to move the chip off `$0.000` |
| Meta as visible hero | Ask the inspector (Spark over read-only record tools, cited answers) and Work orders (Spark structured output, evidence frames, print) in scene 07, each with offline, locked and failed paths labelled | Scene 07, `test_ask.py`, `test_workorders.py`, `e2e/ask.spec.ts`, `e2e/workorders.spec.ts` | Live Spark replies: only mocked HTTP so far |
| Physical-world input | Real water camera: a phone or laptop frame goes to SAM 3.1 through the governor and the masks are drawn over the still | Header camera button, `test_realwater.py`, `e2e/realcam.spec.ts` | SAM 3.1 on real water: no measurement exists, so no accuracy is claimed |
| Impact | Hindi for voice, plans, summaries, Ask and work orders (Meta models only; offline paths stay English and say so); a walkthrough opening with sourced context | Scene 05 language control, `/walkthrough`, `test_language.py`, `e2e/language.spec.ts`, docs/IMPACT_AND_MARKET.md | Hindi quality from the real models |
| Submission kit | README, submission strategy and demo script updated; a scripted demo recorder | README.md, docs/SUBMISSION_STRATEGY.md, docs/FINAL_DEMO_SCRIPT.md | The recording itself needs a live run |

Stage One item 5 is unchanged: zero `LIVE_META` executions exist, and every feature above is tested with mocked HTTP.
Planned and not built on this branch: the murk benchmark, the live recorder, the `/proof` page and replay of a recorded run.
No page or document claims them, and no recorded Meta run ships in `public/`.

## Priority order from here

1. Live Meta key and evidence (unblocks Stage One, moves two categories).
2. Fix anything the live API disagrees with.
3. Record the demo video with LIVE META tags.
4. Operator conversations and cited market figures.
5. Segmentation baseline and lighting-aware control.
