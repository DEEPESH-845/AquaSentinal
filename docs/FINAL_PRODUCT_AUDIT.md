# Final product audit

Audit and refinement of the AquaSentinal interface, 2 November 2026.
Method: read every route, component, store and 3D module; ran the application (Next.js dev server and the FastAPI backend in offline SIMULATION mode, no `MODEL_API_KEY`); captured Chromium screenshots at 1920 x 1080, 1600 x 900, 1440 x 900, 1366 x 768, 1280 x 800, 1024 x 768, 768 x 1024, 390 x 844 and 375 x 812, before and after; drove a full mission to its report; then fixed, re-captured and re-checked.
Individual defects, their reproduction, root cause and regression test are in [UI_BUG_AUDIT.md](UI_BUG_AUDIT.md).

## Starting point

One route (`/`) with eight scenes over a full-screen Three.js digital twin: a scene rail on the left, the gantry camera feed and telemetry on the right, and a context card at the bottom.
The engineering underneath was sound: one simulation loop, 20 Hz snapshots to React, hot 3D reads straight from the engine, provenance tags on every model output, and 48 browser tests.
No route crashed and the console was clean.
The weaknesses were in presentation and honesty at the edges: status shown as healthy or offline before it had been checked, a layout band where panels overlapped, inert or mouse-only controls, no way to give the 3D view the screen, no product story for a first-time visitor, and no onboarding.

## Findings by area

Severity: CRITICAL prevents primary functionality, HIGH breaks a major workflow or misleads, MEDIUM is a visual or functional inconsistency, LOW is polish.

| Area | Finding | Severity | Resolution |
|---|---|---|---|
| Reliability | Provider status stayed LIVE after the backend dropped (UB-01) | HIGH | Status cleared on failure; last successful read recorded |
| Reliability | Unchecked dependencies shown as SIMULATION, OFFLINE or OFF (UB-02) | HIGH | Tri-state health with grey UNKNOWN |
| Interaction | A pending Muse Spark plan could not be cancelled; caller signals disabled the 90 s timeout (UB-07) | MEDIUM | Real abort plus timeout; cancel button |
| Layout | Card over the rail at 1000 to 1259 px; card ignored the wide Perception column; a populated Perception card ran under the feed at 1440 (UB-03) | MEDIUM | Card centred in the space between rail and column at every width |
| Layout | Feed labels clipped and collided with the corner tag in narrow feeds (UB-04) | MEDIUM | Width-based alignment, fixed tags reserved |
| Layout | Mobile card header squeezed the copy into a narrow column beside the provenance tag | MEDIUM | Tag and collapse button stack above the title below 760 px |
| Accessibility | System component rows and the gantry plan view were mouse-only (UB-05, UB-06) | MEDIUM | Buttons; keyboard jog with arrow keys |
| Accessibility | Closing overlay had no dialog semantics or focus handling (UB-12) | LOW | Modal dialog, focus in and back |
| Visual consistency | Two near-identical palettes (CSS tokens and hex literals in SVG and Three.js) | MEDIUM | One token set in `app/globals.css`, mirrored in `lib/theme.ts` for SVG and WebGL |
| Visual consistency | Detection rings amber for every class (UB-08) | MEDIUM | Semantic colour per ring, tracked halo |
| 3D rendering | Particle cloud fixed at 400 points whatever the water | LOW | Density, size and opacity follow turbidity |
| 3D rendering | Flat background behind the rig | LOW | Dithered radial backdrop in WebGL, so the feed pass is unaffected |
| 3D rendering | Fixed 1.5x pixel ratio and 2048 shadow map on every device | LOW | Lighter ceiling on phones and small windows; adaptive drop to 1x when the frame rate cannot hold |
| Animation | GSAP used ad hoc in one file, plugins and ticker set there | LOW | Single registration module and a context-scoped hook |
| Animation | Camera presets tweened under reduced motion | MEDIUM | Snap when `prefers-reduced-motion` is set |
| Application flow | No way to prioritise the 3D view | MEDIUM | Collapsible card and telemetry, focus view (F) |
| Application flow | The instruction-to-execution path had no single visible state | MEDIUM | Mission state strip read from the stores |
| Application flow | No explanation of the product for a first-time visitor, no onboarding | HIGH for the demo | `/walkthrough` and a nine-step guided tour |
| Performance | No leaks found; draw calls and frame time unchanged by the refinement | - | Measured below |
| Reliability | `THREE.Clock` deprecation warning from @react-three/fiber (UB-14) | LOW | Open, library side |

## Design system

Palette from the brief, applied through the existing token names so every component moved at once: ground `#080F16`, panel `#101D28`, hover `#162633`, teal `#42D6C5`, cyan `#31AFC8`, amber `#F2B45D`, danger `#F16F70`, ok `#59D5A0`, text `#E9F0F4` and `#94A6B2`, borders `rgb(159 190 200 / 0.13)`.
The dim text colour is `#7A8E9B` rather than the draft `#627681`: the draft is 3.6:1 on the panel, under the 4.5:1 floor for the 9 to 10 px labels it is used on; the chosen value is 5:1.
Colour stays semantic: teal is active or healthy, amber an inspection target or warning, red a real fault or safety condition, grey unknown.
Panels keep 1 px borders with a faint top light and a soft drop; no blur stacks.
Inter for interface text, IBM Plex Mono with tabular numerals for every value.
Buttons have hover, press (a 1 px surface compression) and disabled states; icons shift 1 px on hover.

## Mission control

The brief's composition maps onto the existing one rather than replacing it, because the scene system, camera presets and free-rect framing are tested and work.
Left: the scene rail (mission, perception, navigation, environment, report, intelligence, system).
Centre: the twin, which refits automatically to whatever space the panels leave.
Right: the camera feed with a new status strip (mission state, waypoint progress bar, the visibility the controller acts on), telemetry, and a new twin event log of what the controller did and when.
Bottom: the context card for the current scene.
New: the card and telemetry collapse independently, F or the header button collapses both, and the camera refits each time.
The header links to the walkthrough and the guided tour and shows Mode, Backend and AI chips that stay grey until the backend has answered.

AI mission control gains a seven-stage state strip (Input, Transcribe, Interpret, Plan, Approve, Execute, Result) that names the state from the brief: IDLE, READY, LISTENING, TRANSCRIBING, INTERPRETING, AWAITING_APPROVAL, EXECUTING, COMPLETED or FAILED.
Every stage is read from the stores; nothing advances on a timer.
A typed instruction marks Transcribe as skipped, not done.
Push-to-talk shows elapsed recording time; a pending plan names who is planning (Muse Spark or the offline parser) and can be cancelled.

The perception studio has four views, Raw, Masks, Tracked and Annotated, in a segmented control with a GSAP-driven indicator and arrow-key support.
Tracked draws each mask's box with the persistent asset id of the observation the backend derived from it (same label, same world position); a mask with no observation is drawn dashed and labelled UNTRACKED.
Compare splits the frame at a draggable divider (a native range input) with the raw pixels on the left.
New results fade in; positions never animate, so overlays stay on the model's coordinates.

The report replaces a monospace text dump with an evidence timeline: each stored capture with its time, reason, position, controller state, simulated and image-derived visibility, duplicates, camera dropouts, and the tracked objects first seen in it; hovering a capture highlights it on the inspection map.
Exports confirm with a short check state.

The System scene is now system health and architecture: backend with last successful answer, Meta API connectivity from the backend preflight, each model, camera, gantry driver with serial connection and homing, and the active mission.

## Three.js

The inherited scene, coordinate system, camera model and simulation coupling are unchanged.
Silt is denser as well as murkier: the particle cloud draws a quarter of its 1600 points in clear water and all of them at full turbidity, with size and opacity rising too (700 points on phones).
A dithered radial backdrop replaces the flat clear colour; the feed pass swaps it out, so the camera feed and the captured frames are untouched.
Detection rings carry state: amber for anomaly-candidate classes, teal for infrastructure, the text colour for the operator's selection, solid when locked and faint when only detected, and a thin teal halo for objects the backend has turned into tracked assets.
Quality adapts: a 1.25x ceiling and a 1024 shadow map on phones and small windows, and `PerformanceMonitor` drops to 1x for the session if the frame rate cannot hold (decline only, so the resolution never oscillates).
The gantry already moves from the engine's own acceleration-limited state each frame; nothing was added that could move it independently of its controller.

## Animation architecture

`lib/animations/gsap.ts` is the only place GSAP plugins are registered (ScrollTrigger), the ticker's lag smoothing is disabled for wall-clock camera moves, and defaults are set.
`useGsap(setup, deps, scope)` runs a setup inside `gsap.context` and reverts it on unmount or dependency change, killing every tween, timeline and ScrollTrigger it made.
`lib/animations/motion.ts` holds the motion tokens (fast 0.18 s, base 0.3 s, panel 0.45 s, section 0.7 s, cinematic 1.1 s), the three eases (`power3.out`, `power2.inOut`, `expo.out`), the same curves as cubic-beziers for framer-motion, and `prefersReducedMotion`.
framer-motion is kept for mount and unmount presence (card swaps, the closing overlay), where it is the simpler tool; it reads the same tokens.
GSAP drives the camera, the tour spotlight, the segmented-control indicator, perception overlay fades and the whole walkthrough.
CSS covers hover and press micro-interactions and the global reduced-motion rule.

## Walkthrough (`/walkthrough`)

Seven sections over the live twin, built with ScrollTrigger inside `gsap.matchMedia`.
01 The problem, 02 The system (specs read from `lib/sim/constants`), 03 The intelligence (voice to Muse Spark to plan to inspection, with the real demo instruction and the contract fixture plan, labelled as such), 04 The perception (a wipe between a twin capture and outlines from the twin's own object ids, labelled TWIN GEOMETRY, NOT A MODEL), 05 Adaptive perception (scroll drives the real engine turbidity; the live gantry feed, visibility band and controller command respond; a range input does the same without scrolling), 06 The result (`compareStrategies` on scenario E in the browser, path drawn on scroll), 07 Enter mission control.
Desktop pins only sections 03 and 05; phones and reduced motion pin nothing.
Leaving the page restores the water and the camera preset it found.
Measured: 12 ScrollTriggers per visit on desktop, 0 after leaving, unchanged over six round trips.

## Guided onboarding

Nine steps: the environment, gantry controls, the camera feed, issuing a command, reviewing the plan, segmentation, changing the water, adaptive perception, and evidence.
A spotlight ring glides between targets and dims the rest without blocking it, so the controls it points at stay usable.
Steps that ask the user to do something show "Waiting for you" until the stores show it done; nothing is claimed that the user has not done.
Next, Back, Skip, progress, arrow keys and Escape; restartable from the header or the Overview card.

## Accessibility

Visible focus ring everywhere; `aria-current` on the active scene; radio-group semantics and arrow keys on the segmented control; the compare divider and walkthrough controls are native range inputs; the tour popover is a labelled non-modal dialog that takes focus; the closing overlay is a modal dialog that returns focus; health and state are always written out, never colour or animation alone.
`prefers-reduced-motion` disables CSS transitions and animations, framer-motion transforms, camera tweens, tour and indicator glides, overlay fades and every walkthrough pin and scrub.

## Performance

Measured on an Apple M5 (ANGLE Metal), Chromium via Playwright, 1440 x 900 at device pixel ratio 2, dev build, offline mode; five-second samples after a 2.5 s settle; "before" is commit `0710c47` served side by side.

| Scene | Before fps / p95 frame / draw calls | After fps / p95 frame / draw calls |
|---|---|---|
| Overview, clear water | 120.2 / 9.9 ms / 185 | 120.2 / 9.5 ms / 186 |
| Environment, turbidity 0.8 | 120.2 / 9.6 ms / 171 | 120.0 / 9.3 ms / 172 |
| Perception, follow camera | 120.2 / 9.5 ms / 176 | 120.1 / 9.5 ms / 173 |

120 fps is the display's refresh cap, so both builds are at the ceiling with the same frame-time tail; the refinement did not cost frames.
JS heap after a forced GC on `/`: 31.2 MB before, 35.1 MB after (the tour, ScrollTrigger and the new panels).
Leak check, after: six client-side round trips between `/` and `/walkthrough` left the heap at 60.3 MB after every trip, 12 triggers on every visit, 0 on `/`, and one canvas; the WebGL context is released on each unmount and no "too many contexts" warning appeared.
Not measured: low-end GPUs and phones (the adaptive pixel ratio is untested on real hardware), and React commit counts.

## Verification

Run on 2 November 2026 against the final tree, backend in offline SIMULATION mode.

| Check | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run lint` | Pass, no warnings |
| `npm run build` | Pass; routes `/` and `/walkthrough` prerendered |
| `npm run sim:check` | Pass |
| `npm run backend:test` | 56 passed |
| `npm run e2e` (Playwright, 64 tests) | 63 passed in the full run; the one failure was a case-sensitive heading match in the new reduced-motion test, fixed, and `refinement.spec.ts` then passed 8 of 8 |

Visual baselines in `e2e/__screenshots__` were regenerated with `--update-snapshots=all` for the new design.
The e2e suite assumes the fresh database Playwright creates when it starts the backend; against a long-running development backend, a manual capture identical to an earlier one is reused as a near-duplicate and carries no new frame reasoning, which `perception.spec.ts` does not expect.

## Screenshots

Captured with a real GPU (Apple M5, ANGLE Metal) after a full offline mission:
[mission control](screenshots/01-mission-control.jpg),
[AI mission control with a plan under review](screenshots/02-ai-mission-control.jpg),
[mission executing](screenshots/03-mission-executing.jpg),
[perception studio in compare mode](screenshots/04-perception-studio.jpg),
[inspection report with evidence timeline](screenshots/05-inspection-report.jpg),
[turbid water](screenshots/06-environment-turbid.jpg),
[system health](screenshots/07-system-health.jpg),
[focus view](screenshots/08-focus-view.jpg),
[guided tour](screenshots/09-guided-tour.jpg),
walkthrough [01](screenshots/10-walkthrough-problem.jpg), [03](screenshots/11-walkthrough-intelligence.jpg), [04](screenshots/12-walkthrough-perception.jpg), [05](screenshots/13-walkthrough-adaptive.jpg), [06](screenshots/14-walkthrough-result.jpg),
mobile [mission control](screenshots/15-mobile-mission-control.jpg), [tour](screenshots/16-mobile-tour.jpg), [walkthrough](screenshots/17-mobile-walkthrough.jpg),
and [1024 x 768](screenshots/18-laptop-1024-intelligence.jpg).

## Remaining limitations

- No `MODEL_API_KEY` was available, so no screen shows a live Meta result; every model step is labelled offline or not run, and the walkthrough's perception section shows twin geometry, labelled.
- The mission-control composition keeps the scene system instead of permanently visible left panels for mission, targets and environment; those are scenes 05 and 06.
- Optional audio cues were not added.
- In the walkthrough, scrolling within section 05 overrides a value set with its range input.
- Telemetry and the event log are hidden below 1000 px, as before; the feed and its status strip remain.
- The tour popover places itself from an estimated height, so a step whose text wraps unusually long can sit closer to its target than intended.
- Physical gantry hardware has still never been run.
- The walkthrough leaves the water alone while a mission is running in mission control, so section 05 is static in that case.
