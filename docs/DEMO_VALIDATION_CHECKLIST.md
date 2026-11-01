# Demo validation checklist

Run top to bottom before recording or presenting.
Any unchecked item in "Blockers" means the live Meta demo cannot be claimed; use the technical backup in docs/FINAL_DEMO_SCRIPT.md.

## 1. Automated checks

- [ ] `npm run typecheck` clean
- [ ] `npm run lint` clean
- [ ] `npm run sim:check` prints `sim:check OK`
- [ ] `npm run backend:test` all pass
- [ ] `npm run e2e` all pass (52 tests, about 10 minutes under software GL)
- [ ] `npm run build` succeeds
- [ ] `npm run eval:adaptive` reports all ten presets replayed identically

## 2. Blockers for a live Meta demo

- [ ] `MODEL_API_KEY` exported in the shell that runs `npm run dev:all` (the backend reads the process environment only)
- [ ] `npm run eval:meta` finished with `voice: LIVE_META`, `segmentation: LIVE_META` and a Spark parsing row
- [ ] `docs/evidence/model-executions.json` contains `LIVE_META` rows for `transcription`, `mission_planning`, `frame_reasoning` and `segmentation`
- [ ] Scene 08 Judge preflight reads "live Meta verified"
- [ ] Top bar AI chip reads META LIVE

## 3. Preflight panel (scene 08)

- [ ] Backend available
- [ ] Evidence store writable
- [ ] Meta credentials loaded
- [ ] Meta API connectivity verified
- [ ] SAM 3.1 segmentation available
- [ ] Voice Transcribe available
- [ ] Camera input identified as SIMULATED: digital-twin render
- [ ] Simulation or hardware identified as SIMULATED gantry
- [ ] Emergency stop available and armed

## 4. One dry run of the judge demo

- [ ] Demo opens on scene 08, not the tank overview
- [ ] COMMAND shows the transcript with RECORDED INPUT and LIVE META
- [ ] PLAN shows a mission id and the MUSE SPARK tag, not OFFLINE FALLBACK, and no fixture-plan warning
- [ ] Perception shows SAM 3.1 masks on captured frames, with LIVE META on the Segmentation step in scene 08
- [ ] Turbidity rises, the scan slows, pauses, resumes and re-observes
- [ ] REPORT shows outcome COMPLETED and at least one pause
- [ ] Report (07) lists assets with coordinates and marks candidates unverified
- [ ] Scene 08 execution log shows the new rows, all LIVE META, no LIVE CALL FAILED
- [ ] E-stop pressed once during a rehearsal stops motion at once and Clear e-stop restores it

## 5. Honesty checks on screen

- [ ] No step shows LIVE META unless the log has a matching successful row
- [ ] Nothing says hardware, physical or real camera; gantry and frames are labelled simulated or digital twin
- [ ] Recorded audio is labelled RECORDED INPUT
- [ ] System (02) and Navigation (04) carry the INHERITED FOUNDATION badge and are not featured
- [ ] No hidden model reasoning is displayed; only tool calls, specs and one-line explanations

## 6. After the run

- [ ] `curl -s localhost:8000/api/evidence/model-executions?limit=1000 > docs/evidence/demo-executions.json`
- [ ] Report Markdown saved to `docs/evidence/demo-report.md`
- [ ] Screenshots saved to `docs/evidence/screenshots/`
- [ ] docs/META_USAGE_EVIDENCE.md evidence table updated with the real counts
- [ ] docs/JUDGING_READINESS.md scores revisited with the new evidence
