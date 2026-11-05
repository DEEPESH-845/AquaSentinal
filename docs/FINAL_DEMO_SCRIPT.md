# Final demo script

One scenario: a submerged pipeline inspection with a loose cable, foreign objects and a controlled rise in turbidity (preset E).
Every segment shows a hackathon-built capability; the inherited tank and gantry appear only as the place where it happens.
Target length two minutes for the automated judge demo, or 2:30 for the full video in docs/SUBMISSION_STRATEGY.md; adapt to the official video limit if it differs.
The public deployment has no Meta key yet, so it runs in labelled offline mode and no recorded live run exists; claim only what the labels show.

## Before you start

1. Run the preflight in docs/DEMO_VALIDATION_CHECKLIST.md.
2. Start the stack with the key exported in the same shell:

   ```bash
   export MODEL_API_KEY=...
   npm run dev:all
   ```

3. Open http://localhost:3000, press `8` (Intelligence), and confirm the Judge preflight panel.
   "live Meta verified" appears only after one successful live call; run `npm run eval:meta` once beforehand, or plan one mission by hand, so it is green before recording.
4. If the preflight shows "live Meta not verified", the Meta parts of this script cannot be claimed. Use the technical backup at the end.
5. If `AQUA_LIVE_PASSCODE` is set on the backend, enter the passcode once from the AI chip in the top bar; until then every Meta-calling step is labelled LIVE LOCKED and behaves as offline.
6. Glance at the credit chip in the top bar: it shows spend against the budget cap.

## Execution labels the audience will see

| Tag | Meaning |
|---|---|
| LIVE META | The backend logged a successful request to the Meta API for this step |
| LIVE CALL FAILED | The request was made and failed; the error is shown |
| RECORDED INPUT | The audio is a prepared file (synthetic speech of the instruction), not a live microphone |
| LIVE MICROPHONE | The audio was recorded with push-to-talk just now |
| SIMULATED | Digital twin: gantry motion, water, camera frames |
| DETERMINISTIC | Ordinary code: compiler, tracker, controller |
| CACHED LIVE | An identical earlier live request was answered from the response cache; zero cost, and it points at the original execution |
| LIVE LOCKED | Live mode is locked by the passcode; the step behaved as if no key were set |
| OFFLINE FALLBACK | No key or the model failed; a labelled rule-based or geometric substitute was used |
| NOT RUN | The step has not happened yet |

Gantry motion is always SIMULATED in this build. Never call it hardware.

## Script (automated judge demo, about 2 minutes)

Press **Start judge demo** on scene 08. The director loads preset E and runs the same services as manual operation.

### 0:00 to 0:15, the problem and the claim

Screen: scene 08, "New inspection intelligence", with the eight-step pipeline.

Say: "Underwater inspection fails quietly: visibility changes mid-scan, and you only find out afterwards that half the footage is useless. AquaSentinal is an inspection agent built this week on Meta's models. Everything on this panel is new; the tank and gantry are the testbed we already had."

### 0:15 to 0:35, Act 1 and Act 2: instruction and mission

Screen: COMMAND card. The recorded instruction goes through Voice Transcribe; the transcript appears with RECORDED INPUT and LIVE META tags and its latency. Muse Spark plans it.

Instruction: "Inspect the pipeline from left to right. Identify the loose cable and foreign objects. Track them, record their coordinates and adapt the inspection speed when visibility deteriorates."

Say: "That is the only input. Muse Spark reads the environment through tools and calls create_inspection_mission. It cannot move anything: motion tools are not even offered. The backend validates the spec and compiles bounded waypoints."

Screen: PLAN card with mission id, captures and time, provider tag MUSE SPARK. Optional cut to Mission (05) for the tool-call timeline and spec.

Do not show or describe hidden model reasoning; show the tool calls, the spec and the one-line explanation only.

### 0:35 to 1:05, Act 3: perception

Screen: SCAN, then PERCEIVE on Perception (03). Captures arrive; SAM 3.1 masks are drawn on the frame with prompts, confidence and asset ids; the loose cable and crate are amber.

Say: "Each frame goes to Muse Spark once to choose what to look for, then to SAM 3.1, one concept per request. Masks become positioned observations, associated to persistent assets, so the cable seen in three frames is one cable with one coordinate."

### 1:05 to 1:30, Act 4: adaptation

Screen: ADAPT on Environment (06). Turbidity rises; perception state goes NORMAL to REDUCED VISIBILITY, speed drops, then PAUSED when visibility crosses the unsafe line; the scan resumes and re-observes when the water clears.

Say: "This is a deterministic controller, not the language model. It slows down, then refuses to record frames it cannot trust. In the same scenario a fixed-speed scan records three unreliable frames and confirms one target; this one records none and confirms four. Those are simulation numbers, and they are in the repo."

### 1:30 to 1:50, Act 5: the record

Screen: REPORT. Outcome, captures, pauses, targets; then Report (07) with assets, coordinates, unverified anomaly candidates, uninspected strips and the summary with its source.

Say: "Every finding keeps its frame, its model, its confidence and its coordinates. Nothing is called a defect until a person verifies it, and the report says which strips could not be inspected."

### 1:50 to 2:20, Act 6: ask, act, afford (adds 30 seconds; skip in the 2:00 cut)

Screen: Report (07). Under the report, Ask the inspector: type or click "Where is the loose cable?".

Say: "The answer is built from the stored records through read-only tools, and every claim cites a capture. Click the citation and the twin moves to that asset."

Screen: Work orders card, then Print work orders.

Say: "Findings become prioritised work orders with their evidence frames, one page each. Hindi works here too, with the Meta models."

Screen: the credit chip popover in the top bar.

Say: "Every Meta call passes a governor: a cache, a hard budget cap and a passcode lock. This is how the credits stay under control."

Offline, the Ask answer carries a labelled fallback tag and Hindi shows "Hindi needs the Meta models"; say so out loud.

### 1:50 to 2:00 (2:20 to 2:30 in the full cut), impact

Screen: scene 08 execution log with LIVE META rows (offline, the rows carry their offline labels; do not call them live).

Say: "Target: fixed tanks and basins in aquaculture and water treatment, where a rail camera is realistic. Next: a physical tank run and operator trials."

### Optional: real water camera (adds 15 seconds, hand-held)

Press the camera icon in the header, allow the camera on a phone or laptop, point it at water or any scene, press the shutter.
With the key SAM 3.1 outlines the named things and the masks carry LIVE META.
Without it the panel says "SAM 3.1 needs the Meta key" and shows only the frame; say that.
It cannot be part of the headless scripted recording; film it by hand.

## Optional live voice moment (adds 15 seconds)

Before pressing Start judge demo, go to Mission (05), choose the language (EN or Hindi) in the mission panel, hold **Hold to talk**, speak the instruction, release.
The transcript appears tagged LIVE MICROPHONE, and the plan explanation follows the chosen language.
Plan it, show the tool timeline, then discard and start the judge demo.

## Technical backup (network or key failure)

1. If Voice Transcribe fails, the COMMAND card says so and the typed instruction is used. Say so out loud.
2. If Muse Spark fails, the card shows the error. Press Exit demo, go to Mission (05), and press "Use the offline parser instead" only if you say "this is the rule-based fallback, not Muse Spark". The plan is tagged OFFLINE FALLBACK.
3. If there is no key at all, run the demo anyway as a demonstration of the deterministic layers (validation, adaptive control, evidence) and say clearly that no Meta model ran. Every model step will read OFFLINE FALLBACK or NOT RUN.
4. Never replace a live call with a recording of a previous run without saying it is a recording.
5. If the budget cap is reached, calls are refused before they are sent (HTTP 402) and the credit chip turns red; the offline paths keep working. Say so.
6. If the backend is asleep (Render free tier), open the backend URL first and wait for it to answer.

## What not to claim

- No hardware was moved; the serial driver is unverified.
- Without LIVE META tags on screen, nothing shown came from a Meta model.
- Segmentation is not a structural diagnosis.
- No measured improvement over current practice; the comparison numbers are from the simulation.
- No recorded live run exists and the SAM 3.1 murk benchmark was not built; do not say SAM performs well in murky water.
- The sourced context figures are only those in docs/IMPACT_AND_MARKET.md; the impact metrics are targets, not results.
- Hindi quality has not been checked on live Meta output.
