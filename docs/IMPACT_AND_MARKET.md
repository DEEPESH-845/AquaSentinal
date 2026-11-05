# Impact and market

Status of this document: a problem and market hypothesis, not validated research.
No customer interviews have been done, and no performance improvement has been measured with operators.
Three context figures are sourced with a URL (next section); every other market figure is deliberately left out because no source was found.
Every claim below is a sourced figure, a description of how the prototype works, or an explicitly labelled hypothesis.

## The need of the hour: sourced context

Only figures with a source are listed.
Where no source was found, the gap is stated instead of filled.

| Context | Figure | Source |
|---|---|---|
| Who depends on Indian fisheries and aquaculture | About 3 crore fishers and fish farmers | PIB, 12 Jan 2026: https://www.pib.gov.in/PressReleseDetailm.aspx?PRID=2213532&reg=3&lang=2 |
| Scale | India is the world's second-largest fish producer with 8% of global output; production rose to 197.75 lakh tonnes in FY 2024-25 from 95.79 lakh tonnes in FY 2013-14 | Same PIB release |
| Diver risk (United States, not India) | 39 fatal occupational injuries among commercial divers in 2011 to 2017, counted by the US Bureau of Labor Statistics and reported on the NIOSH page | https://www.cdc.gov/niosh/maritime/industries/commercial_diving.html |
| Why murky water is a vision problem | Light absorption and scattering in water degrade underwater images; surveyed with experimental comparison of enhancement and restoration methods | Wang et al., arXiv 1907.03246: https://arxiv.org/abs/1907.03246 |

Not sourced, so not claimed: the cost of an underwater inspection in India, diver fatality or injury figures for India, the size of the land-based aquaculture or treatment-plant inspection market, and how much inspection time murk costs operators.
The diver figure is American and says nothing about Indian practice; it is here only to show that putting people in the water is a known occupational risk.

Why now, as a design argument and not a market figure: one set of Meta models now covers the whole chain (Voice Transcribe for Hindi and English speech, Muse Spark for planning with tools and for grounded answers, SAM 3.1 for outlines), so a single product can go from a spoken sentence to a cited work order.

## Problem

Underwater inspection of fixed infrastructure is slow and its evidence is weak.
Visibility changes during a single inspection, so the same camera pass can produce usable frames at one end of a pipe and useless frames at the other.
An operator has to drive the camera, watch the video, decide what each object is, write down where it was, and judge afterwards whether the footage was good enough.
The resulting record is usually video plus notes: hard to search, hard to compare between inspections, and silent about which areas were never seen clearly.

## What AquaSentinal does about it

- The operator states the inspection in plain language, by voice or text, instead of configuring speed, pattern, region and thresholds by hand.
- Muse Spark turns that into a structured mission through allowlisted tools; a deterministic compiler bounds it; the operator approves it.
- The camera gantry executes it, capturing frames at planned waypoints.
- SAM 3.1 segments the objects named for the mission; observations are tied to persistent assets with gantry coordinates.
- A deterministic controller slows, pauses and re-observes when visibility drops, so the record does not silently fill with unusable frames.
- The report lists what was found, where, from which frame, with which model and confidence, and which strips could not be inspected reliably.
- The operator can speak and read in Hindi or English (Meta models only; offline mode says so).
- Ask the Inspector answers questions about a mission from its stored records and cites captures; clicking a citation moves the twin to that asset.
- Findings become prioritised work orders with their evidence frames, printable one per page.
- The credit governor (response cache, cascade gating, USD budget cap, passcode live lock) keeps Meta spend bounded, and a header chip shows it.
- The real water camera takes one frame from a phone or laptop camera and runs SAM 3.1 on it; without the Meta key it says "SAM 3.1 needs the Meta key".

## Initial market: fixed-rail inspection of tanks and basins

The prototype is a camera on an XY gantry over a tank.
That matches environments where a rail-mounted or bridge-mounted camera is physically realistic, not open water.

| Segment | Why it fits | Why it might not |
|---|---|---|
| Recirculating aquaculture systems (land-based fish farm tanks) | Fixed tanks, recurring inspections, turbidity that changes with feeding and stock; debris, fouling and loose equipment matter | Fish in the frame are a perception problem the prototype has not addressed |
| Water and wastewater treatment basins and clarifiers | Fixed geometry, many already have bridge structures that move along the tank, recurring inspections of submerged equipment | Very low visibility in many basins; regulatory record-keeping requirements unknown to us |
| Test tanks and research flumes | The exact setup of this prototype; users are technical | Small market |

Recommended first target, as a hypothesis: recirculating aquaculture and treatment-plant operators who already own a moving bridge or rail over a tank.

Not targeted now: open-water pipelines, ship hulls and ports.
They need a free-swimming vehicle, navigation without rails, and certification work that this project has not started.

## Users and buyers (hypotheses)

| Role | Pain | What they would use |
|---|---|---|
| Technician or operator (user) | Drives the camera, watches video, takes notes | Voice instruction, live pipeline view, automatic pause in murky water |
| Maintenance or site manager (buyer) | Needs comparable records between inspections and evidence of what was checked | Reports, asset history across missions, uninspected-area list |
| Compliance or quality lead (influencer) | Needs to know which findings are verified | Unverified-candidate marking, source and confidence on every finding |

## Existing workflow (assumed, to be checked with operators)

1. Schedule an inspection; prepare the camera or diver.
2. Drive or tow the camera along the structure while watching a monitor.
3. Pause and go back manually when the picture is poor or something looks wrong.
4. Note observations and approximate positions.
5. Write a report from notes and video afterwards.

AquaSentinal replaces steps 2 to 5 with an approved plan, adaptive execution and a generated record; step 1 and the final judgement stay with people.

## Value proposition

Turn a spoken inspection request into a bounded, repeatable scan whose record says what was seen, where, how confidently, and what could not be seen.

## Measurable impact targets

These are targets, not results.
None of them has been measured with real operators. The prototype can measure the simulated versions today.

| Metric | Definition | How it would be measured | What exists today |
|---|---|---|---|
| Inspection setup time | Time from request to an approved plan | Operator study: manual parameter entry against voice instruction | 9 parameters replaced by one instruction; time not measured |
| Time to locate a target | From mission start to first confirmed observation of the target | Mission event log | Logged in the twin; not reported |
| Tracking continuity | Share of captures of an asset associated to the same asset id | Observation records | Implemented; not measured on live SAM output |
| Inspection coverage | Share of the planned region inspected with reliable frames | Report uninspected strips | Reported per mission (simulated) |
| Manual interventions | Operator pauses, resumes and re-plans per mission | Mission timeline | Logged |
| Evidence completeness | Findings with frame, coordinates, source and confidence | Report validation | 100 percent by construction; not a performance claim |
| Repeatability | Same plan and conditions give the same record | Replay | Exact in the twin (docs/TECHNICAL_EVALUATION.md) |
| Unreliable frames recorded | Frames below the unsafe visibility threshold | Capture records | Simulated preset E: 3 for fixed speed, 0 for adaptive |

## Commercialisation (hypothesis)

- Software licence per site for the inspection agent, running on an edge computer at the tank, with Meta model usage passed through at cost.
- Retrofit kit for existing tank bridges and rails (camera housing, motion controller), sold with integration services.
- Later: report history and cross-site asset tracking as a hosted service.

Unit economics are unknown.
Model cost per inspection can be estimated from the usage tracker once live calls exist; at the published Standard-mode prices a mission's budget cap (60 SAM requests, 12 Spark calls) bounds it.

## What is not claimed

- No regulatory approval, safety certification or commercial deployment.
- No physical hardware run: the gantry driver has only been tested against a fake controller.
- No live Meta model run (docs/META_USAGE_EVIDENCE.md): no MODEL_API_KEY has been set, so no recorded live run exists yet.
- No measured improvement over current practice.

## Next steps to make this credible

1. Five conversations with aquaculture or treatment-plant operators to confirm or kill the workflow and buyer assumptions.
2. Source Indian figures for inspection cost and diver safety, and market size for land-based aquaculture and treatment-plant inspection, with citations (the context table above has only the three figures that could be sourced).
3. Run the live Meta evaluation and one physical tank run, then repeat the time-to-plan comparison with at least three people.
