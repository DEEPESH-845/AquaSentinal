# Demo script

About two minutes in simulation; works without Meta credentials, and every offline output is labelled.

## Setup

1. `npm run dev:all` (frontend on :3000, backend on :8000).
2. Open http://localhost:3000 and check the top bar: MODE SIMULATION, BACKEND ONLINE, AI META LIVE or OFFLINE.

## Automated run

Press Run demo.
The director loads scenario E (turbidity increase) and walks through seven phases:

1. Overview: the tank, the pipeline, the gantry.
2. Command: the instruction appears and the backend plans it (Muse Spark when live, the offline parser otherwise, labelled on the plan).
3. Plan: waypoint count, captures and estimated time; the mission starts on the twin.
4. Scan: the carriage homes, then follows the plan, capturing at each waypoint.
5. Perceive: frames go through quality, reasoning, segmentation and tracking.
6. Adapt: silt rises; the scan slows, then pauses until visibility recovers.
7. Report: outcome, targets, false positives, unreliable frames, pauses, coverage; then the closing moment.

If the backend never answers, the demo runs the contract fixture plan and says so.

## Manual run (what to say and show)

1. Mission (05): hold Hold to talk and say the instruction, or press Use the example instruction.
   - "Inspect the submerged pipeline from left to right. Identify loose cables and foreign objects. Track any relevant objects and record their coordinates. Reduce scanning speed when visibility deteriorates and stop if visibility becomes unreliable."
2. Press Plan mission; show the provider tag, explanation, spec, plan and the tool-call timeline.
3. Press Approve and run; the view moves to Navigation (04) with the planned path on the sand and the pad.
4. Environment (06): choose preset E before approving to show the pause, or C for the false positive that re-observation corrects.
5. Perception (03): show a capture with masks (SAM when live, dashed twin-geometry outlines offline), toggle Sim detector boxes, read the image quality and observations.
6. Press E-stop mid-scan: motion stops at once and every command is refused until Clear e-stop.
7. Report (07): summary with its source, unverified anomaly candidates, map with uninspected strips, JSON and Markdown export, history, Replay on twin.
8. Environment (06): Compare strategies shows measured adaptive and fixed numbers for the current scenario.

## What not to claim

- No hardware was moved; the serial driver is unverified.
- Without a key, nothing shown came from a Meta model.
- Segmentation is not a structural diagnosis.
