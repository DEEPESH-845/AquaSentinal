# Perception pipeline

## Stages

```
CAPTURE (twin render or camera) -> IMAGE QUALITY (OpenCV) -> ENVIRONMENT ESTIMATE
  -> MUSE SPARK FRAME REASONING -> SAM 3.1 SEGMENTATION -> TRACK ASSOCIATION -> OBSERVATIONS -> EVIDENCE STORAGE
```

- Frames are sampled by the plan: one capture per capture waypoint, one per re-observation, and manual captures, never every rendered frame.
- `components/lab/capture.ts` renders the gantry camera at 640 x 480 into a linear HalfFloat target and passes it through three's `OutputPass`, so tone mapping and sRGB match the live feed.
- The same call renders an ID pass: each test object in a flat linear colour (red channel = 4 x object index), everything else black, no fog.
- `PerceptionPipeline.process` stores the frame first, so a later model failure never loses evidence.

## Image quality

`backend/app/perception/quality.py` computes brightness (mean HSV value), RMS contrast, Laplacian variance (sharpness) and the red-to-blue ratio.
`visibility_estimate = 0.9 * min(1, contrast / 0.07) + 0.1 * min(1, sharpness / 500)`, capped at 0.05 for frames darker than 6 percent brightness.
These are image statistics labelled `IMAGE_DERIVED_ESTIMATE`; they are not a turbidity measurement.
The constants were fitted on 2026-11-01 to 20 twin captures (headless Chromium, SwiftShader GL) at gantry (50, 20) and (75, 25), turbidity 0 to 1 at lighting 0.8 and lighting 0.2 and 0.5 at turbidity 0.15.
Against the twin's simulated visibility, all 20 frames land in the same GOOD, DEGRADED or UNRELIABLE band, with an RMS error of 0.040 and a worst error of 0.083.
The earlier constants (0.16, 120, weights 0.6 and 0.4) were never fitted and put 8 of those 20 frames in the right band; clear water at visibility 0.91 read 0.64.
Sharpness is not monotonic in turbidity on twin frames, which is why it only carries a 0.1 weight.
The fit says nothing about real camera frames or a physical turbidity sensor.

## Environment and visibility

- The twin's visibility is `exp(-1.1 * turbidity^2) * lighting^0.3`, the detector's water and light factors at the nadir, or 0 while the camera is offline (`lib/sim/perception.ts`).
- It is labelled SIMULATED everywhere it appears.
- Scripted disturbances (turbidity and lighting ramps, camera dropouts) run on the mission clock and are restored when the mission ends.

## Adaptive states

Thresholds come from `shared/perception.json`: degraded below 0.75, unsafe below 0.45, reduced speed 35 percent, resume after 2 s of normal visibility, operator intervention after 15 s paused, at most 4 re-observations within 5 cm.

| State | Entered when | Behaviour (adaptive strategy) |
|---|---|---|
| `NORMAL_VISIBILITY` | visibility at or above 0.75 | plan speed |
| `REDUCED_VISIBILITY` | 0.45 to 0.75 | speed capped at the reduced fraction |
| `LOW_CONFIDENCE` | after a capture dwell, a detection below the 0.65 classify threshold that is not near an already confirmed observation | re-centre on its estimated position |
| `REOBSERVATION_REQUIRED` | arrived at the re-observation point | dwell 1.2 s, capture again, then continue the plan |
| `INSPECTION_PAUSED` | visibility below 0.45 or camera offline | controlled stop at the nearest stoppable point; no captures |
| `OPERATOR_INTERVENTION_REQUIRED` | paused 15 s without recovery | stays paused; operator resume is refused until visibility is at least 0.45 |

The fixed strategy runs the same plan with the policy ignored, which is the comparison baseline.
The backend executor (`perception/controller.py`) implements the same states except re-observation, fed by the image-derived estimate.

## Track association

- `backend/app/perception/tracking.py` associates each sighting with a persistent asset when it is within 6 cm of the asset centre or inside its footprint plus 2 cm, and the labels are compatible.
- Labels are compatible when equal, or when either side is uncertain (confidence below 0.65); a null confidence counts as certain.
- Each asset keeps two confidence-weighted vote tallies, certain (confidence at least 0.65, or none) and uncertain, in the `labels` column.
- The asset label is the top certain label if any certain vote exists, otherwise the top uncertain one, so two doubtful loose cable sightings never outvote one confident debris sighting.
- That matches the twin, which judges an object by its best observation, so the report no longer lists as an anomaly candidate an object the twin has resolved.
- Assets persist across missions, which keeps an object's identity between inspection sessions; SAM's own object ids are only used within one response.
- Observation status: loose cables and foreign objects are `UNVERIFIED_ANOMALY_CANDIDATE`, other observations below 0.65 are `LOW_CONFIDENCE`, the rest `OBSERVED`.

## SAM evaluation against the twin

When the capture carries an ID pass, each SAM mask is scored by IoU against every object silhouette and the best match is stored with the instance.
Reports give the mean IoU and sample count; this is the only accuracy figure the system reports for SAM, and it exists only for live runs.

## Deduplication and queueing

- A frame whose 16 x 12 grey thumbnail differs from the mission's previous frame by less than 1.5 grey levels on average, taken within 0.5 cm of the same position, reuses that frame's segmentations.
- SAM and Spark requests go through `InferenceQueue` (docs/META_MODEL_INTEGRATION.md).
