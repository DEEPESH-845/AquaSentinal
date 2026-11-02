# UI bug audit

Defects found during the final product refinement pass (2 November 2026).
Each was reproduced in the running application (Next.js dev server plus the FastAPI backend in offline SIMULATION mode, Chromium via Playwright) before it was fixed.
Priorities: P0 crash or core workflow failure, P1 broken model integration, camera, mission control or major layout, P2 visual, responsive or interaction defect, P3 polish.

No P0 defect was found: the application loaded on every route and viewport with no console errors or failed requests before and after the pass.

| ID | Pri | Route | Defect | Status |
|---|---|---|---|---|
| UB-01 | P1 | `/` | Provider status stayed LIVE after the backend stopped answering | Fixed, regression test |
| UB-02 | P2 | `/` | Unchecked dependencies were shown with asserted values | Fixed, regression test |
| UB-03 | P2 | `/` 1000 to 1259 px | Context card covered the scene rail; card ignored the wider Perception column | Fixed, verified by screenshot |
| UB-04 | P2 | `/` narrow feed | Detection labels clipped at the feed edge and collided with the state tag | Fixed, verified by screenshot |
| UB-05 | P2 | `/` scene 2 | Component list not keyboard operable | Fixed |
| UB-06 | P2 | `/` scene 4 | Gantry plan view was mouse-only | Fixed, regression test |
| UB-07 | P2 | `/` scene 5 | A pending planning request could not be cancelled; caller signals disabled the request timeout | Fixed, regression test |
| UB-08 | P2 | `/` | Detection rings in the 3D scene were amber for every class | Fixed, verified by screenshot |
| UB-09 | P2 | `/walkthrough` | Twin framed off-centre inside an off-centre stage | Fixed |
| UB-10 | P2 | `/walkthrough` mobile | `gsap.matchMedia` ran no setup on mobile | Fixed, regression test |
| UB-11 | P3 | all | Next.js dev badge drawn over the scene rail and the mobile card during demos | Fixed |
| UB-12 | P3 | `/` | Closing overlay had no dialog semantics or focus handling | Fixed |
| UB-13 | P3 | `/` | Feed corner tag read "CAM D", an internal camera preset id | Fixed |
| UB-14 | P3 | all | `THREE.Clock` deprecation warning in the browser console | Open: emitted by @react-three/fiber 9.6 with three 0.184 |
| UB-15 | P2 | `/walkthrough` | Scrolling section 05 changed the water under a mission running in mission control | Fixed, regression test |
| UB-17 | P2 | `/` 760 to 999 px | Scene strip overflowed by 178 px; "08 Intelligence" unreachable without scrolling | Fixed, regression test |
| UB-18 | P1 | `/` phones in landscape | Context card stacked over the camera feed at 667 x 375 and 844 x 390 | Fixed, regression test |
| UB-19 | P2 | `/` 320 px | Brand truncated to "AQUASE"; scene strip 4 to 26 px too wide | Fixed, regression test |
| UB-20 | P3 | `/` below 1000 px | Compact feed header pushed the position readout past the panel edge | Fixed |
| UB-16 | P2 | e2e | Gantry stop test read target and position after a click while the twin kept ticking in real time | Fixed: deterministic assertion |

## UB-01 Stale provider status after the backend is lost

Reproduction: start the app with the backend running, wait for the chips, stop the backend.
The Backend chip turned OFFLINE but the AI chip, the System card services and the voice button kept the last status, so a live key would still have read META LIVE.
Root cause: `refreshStatus` in `lib/store/mission.ts` set `backend: "OFFLINE"` in its error branch and left `system` holding the last successful response.
Fix: the error branch clears `system`, so every consumer falls back to its unknown state, and `lastStatusOkAt` records the last successful read for the health panel.
Regression test: `e2e/refinement.spec.ts` "an unreachable backend shows UNKNOWN or offline, never a stale healthy state".

## UB-02 Unchecked dependencies shown with asserted values

Reproduction: load the app with the backend unreachable.
The Mode chip read SIMULATION and the System card listed every provider as OFFLINE and the camera as OFF, although nothing had been checked.
Root cause: `sys?.mode ?? "SIMULATION"` and `p?.spark.status ?? "OFFLINE"` defaults in `LabUI.tsx` and `scenes.tsx`.
Fix: a tri-state `Service` with UNKNOWN in grey, UNKNOWN chips, and a Meta API connectivity row that reads the backend preflight and says "not checked" until it answers.
Regression test: the same test asserts six UNKNOWN rows and no LIVE or ON row.

## UB-03 Card and rail overlap between 1000 and 1259 px

Reproduction: 1024 x 768, scene 8.
The card started at `left-32` (128 px) while the rail, sized by its longest label, ended at about 148 px, so "08 INTELLIGENCE" was cut by the card.
In the same band the card's right edge was a constant 332 px from the edge while the Perception column widens to 339 px.
Root cause: hard-coded offsets unrelated to the elements they avoid.
Fix: the rail has a fixed 148 px width, the card starts at 176 px, and the card's right offset reads the column width through a `--col-w` custom property set by the layout.

## UB-04 Detection labels clipped in narrow feeds

Reproduction: 390 x 844; the feed is 176 px wide and "SIM LOOSE_CABLE 60.1%" ran off its right edge over the corner tag.
Root cause: `labelRight` decided right alignment from a fixed `bbox.x + bbox.w > 0.72` heuristic, not from the label's width, and the overlap check did not know about the fixed state tag and position readout.
Fix: alignment uses the estimated label width against the real feed width, and the two fixed tags are seeded into the overlap set so labels yield to them.

## UB-05 System component list not keyboard operable

The six component rows were `li` elements with mouse handlers only.
Fix: each row is a button with `aria-pressed`; focus highlights the component in the scene as hover does.

## UB-06 Gantry plan view mouse-only

Fix: the plan view is focusable (`role="application"` with a description) and the arrow keys jog 5 cm, or 1 cm with Shift, from the current target.
The key events stop propagating so they do not also switch scenes.
Regression test: "the gantry plan view moves the carriage from the keyboard".

## UB-07 Planning could not be cancelled

A Muse Spark planning request has a 90 s timeout and no way to stop it.
While fixing it, a latent bug surfaced in `lib/api/client.ts`: `signal: init.signal ?? ctrl.signal` meant a caller-supplied signal replaced the timeout controller, so such a request could never time out.
Fix: the caller's signal now aborts the request's own controller, so cancel and timeout both apply; the store exposes `cancelInterpret` and reports "Planning cancelled".
Regression test: "mission state strip follows the real request, and planning can be cancelled" holds the request with a route handler, cancels it and plans again.

## UB-08 Detection rings did not carry meaning

Every detection ring in the 3D scene used one amber material, so pipe joints and the valve looked like anomaly candidates.
Fix: one material per ring; amber for anomaly-candidate classes, teal for infrastructure, the text colour for the operator's selection, solid when the detector has locked and faint when it has only detected.
A thin teal halo marks objects the backend has turned into persistent tracked assets.

## UB-09 Walkthrough twin framed off-centre

`fitRect` in `CameraRig.tsx` always centred the subject on the canvas, so a stage area beside the copy produced a negative half-width and a tiny model.
Fix: a stage rect carries `stage: true` and the fit centres on it; mission control is unchanged.

## UB-10 Walkthrough mobile setup never ran

`gsap.matchMedia` only runs a callback when at least one of its conditions matches; the mobile branch had none that matched.
Fix: an always-true condition; covered by `e2e/walkthrough.spec.ts`.

## UB-11 to UB-13

The judge demo runs on `next dev`, whose badge sat over the scene rail and the mobile card: `devIndicators: false`.
The closing "simulation to field" overlay is now a modal dialog that takes focus and returns it on close.
The feed's idle tag reads NADIR (the camera's orientation) instead of CAM D.

## UB-14 Open

`THREE.Clock: This module has been deprecated` is logged by @react-three/fiber 9.6's internal clock with three 0.184.
It is a warning, not an error, and is already in the e2e suite's known-warning list; it goes away with a fiber release that uses `THREE.Timer`.

## UB-15 Walkthrough changed a running mission's water

Reproduction: approve a mission on `/`, open the walkthrough from the header and scroll into section 05.
The walkthrough and mission control share one twin, so the scrubbed turbidity reached the running mission and its evidence would no longer have matched its plan.
Fix: the walkthrough writes the water only when no mission is running; its slider is disabled with a note, and the restore on leaving obeys the same rule.
Regression test: "the walkthrough leaves a running mission's water alone".

## UB-16 Racy gantry stop test

`gantry.spec.ts` clicked Stop and then compared the target with the position, but the twin keeps running in real time and decelerates past the stop point, so any frame between the click and the read failed it; extra panels made that frame more likely.
Fix: the test records the stop point, fast-forwards the engine deterministically, and asserts that the target stayed at the stop point and the carriage settled on it instead of continuing to the clicked corner.

## UB-17 to UB-20 Responsive sweep

A second sweep added 2560 x 1440, 900 x 700, 667 x 375, 844 x 390 and 320 x 568 to the earlier sizes.
UB-17: below 1000 px the strip showed every scene name, which only fits below 760 px where names were already hidden; inactive names are now hidden below 1000 px, the strip can scroll as a last resort, and below 400 px the active name becomes screen-reader-only (the card title names the scene).
UB-18: the compact layout stacks the strip and card under the feed, which assumes a portrait screen; a `short` variant (height up to 520 px, width under 1000 px) puts the card beside the feed column instead, and the 3D framing detects the side-by-side case and frames the tank left of the feed.
UB-19: the header buttons and brand get tighter spacing below 380 px.
UB-20: the feed's provenance tag reads TWIN in compact feeds and the readout truncates.
On displays of 2200 x 1200 CSS pixels or more the instrument overlay is scaled by 1.25 so 10 px labels stay legible; the feed pass and the 3D framing read zoomed rects correctly.
`e2e/responsive.spec.ts` now runs 11 viewports and also asserts that the scene strip fits.
