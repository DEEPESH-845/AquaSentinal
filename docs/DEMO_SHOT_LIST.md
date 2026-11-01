# Demo shot list

Capture at 1440 x 900 or larger in a browser with GPU acceleration (headless software GL renders the camera feed dark).
Record model outputs and software behaviour unedited; cutting between shots is fine, altering what a shot shows is not.
Every shot that shows a model output must also show its execution tag.

| # | Time | Shot | Must be visible | Contribution | Evidence to keep |
|---|---|---|---|---|---|
| 1 | 0:00 | Scene 08 full panel, pipeline steps all NOT RUN, preflight green | Title "New inspection intelligence", HACKATHON-BUILT badge, "live Meta verified" | Pipeline, execution log, preflight | Screenshot |
| 2 | 0:08 | Press Start judge demo | Demo card INTRO, progress bar | Judge demo | none |
| 3 | 0:15 | COMMAND card, transcript appears | Transcript text, RECORDED INPUT, LIVE META, latency | Voice Transcribe | `demo-executions.json` transcription row |
| 4 | 0:22 | COMMAND to PLAN | Mission id, capture count, MUSE SPARK tag | Muse Spark planning, validation | mission_planning rows; mission JSON from `/api/missions/{id}` |
| 5 | 0:28 | Cut to Mission (05) for 5 s (optional, pause demo first) | Tool timeline: get_environment_conditions then create_inspection_mission; spec | Tool calling | Screenshot |
| 6 | 0:35 | Navigation path on the sand as the carriage homes and scans | Plan path overlay, SIMULATED label in telemetry | Orchestration (twin) | none |
| 7 | 0:42 | Perception (03), first capture with SAM masks | Mask outlines on the frame, prompts, confidence, SAM 3.1 tag, asset ids | SAM 3.1, frame reasoning | segmentation rows; capture JSON from `/api/inspection/captures/{mission}` |
| 8 | 0:55 | Second capture of the same cable | Same asset id on a later frame | Tracking | Screenshot |
| 9 | 1:05 | Environment (06) as turbidity rises | Turbidity value, perception state REDUCED VISIBILITY, speed fraction | Adaptive control | Screenshot |
| 10 | 1:15 | Pause | PAUSED state, visibility below the unsafe line, no new captures | Safety threshold enforced by deterministic controller | Mission timeline |
| 11 | 1:24 | Resume and re-observation | Perception back to NORMAL, REOBSERVE capture | Re-observation | Capture list |
| 12 | 1:30 | REPORT demo card | Outcome, captures, pauses, targets, coverage | Evidence | Report JSON |
| 13 | 1:38 | Report (07) | Assets with coordinates, unverified candidates, uninspected strips, summary source tag | Evidence, history | `/api/inspection/{id}/report?format=md` |
| 14 | 1:50 | Scene 08 execution log | Rows of LIVE META with durations | Meta usage evidence | `demo-executions.json` |
| 15 | 1:55 | Closing line over the twin | Nothing new claimed | Impact | none |

## Evidence capture after recording

```bash
curl -s localhost:8000/api/evidence/model-executions?limit=1000 > docs/evidence/demo-executions.json
curl -s "localhost:8000/api/inspection/<mission-id>/report?format=md" > docs/evidence/demo-report.md
```

Add screenshots of shots 1, 3, 7, 10 and 14 to `docs/evidence/screenshots/` and update docs/META_USAGE_EVIDENCE.md.

## Shots not to include

- Orbiting or zooming the 3D tank for its own sake.
- System (02) or Navigation (04) scene cards: inherited.
- The jog pad, camera presets or object highlighting: inherited.
- Any model step without its tag in frame.
