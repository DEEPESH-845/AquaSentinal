# Meta model usage evidence

## Current status

**No live Meta model request has been made.**
No `MODEL_API_KEY` has been available during development, so every Meta integration has only run against mocked HTTP in the test suite.
The integrations are complete to the documented API (docs/META_MODEL_INTEGRATION.md), but a judge has no evidence yet that they work against the real service.
This is the single largest compliance risk for the submission (docs/JUDGING_READINESS.md, Stage One item 5).

| Model | Role in AquaSentinal | Code | Mocked tests | Live executions logged |
|---|---|---|---|---|
| Muse Voice Transcribe 1.0 | Spoken instruction to text | `backend/app/meta/voice.py` | yes | 0 |
| Muse Spark 1.3 | Mission planning through tools; frame reasoning; report summary | `backend/app/meta/spark.py` | yes | 0 |
| SAM 3.1 | Text-prompted segmentation of captured frames | `backend/app/meta/sam.py` | yes | 0 |
| Muse Wonder | Not used: planning is one constrained tool call; no demonstrated benefit for 3 to 5 times the price | none | none | n/a |

## How usage is recorded

Every request that leaves `MetaClient` produces one record in the `model_executions` table, served at `GET /api/evidence/model-executions` and shown in the Intelligence scene (08).

| Field | Meaning |
|---|---|
| `id` | Execution id |
| `model` | Model identifier sent in the request |
| `operation` | `transcription`, `mission_planning`, `frame_reasoning`, `segmentation`, `report_summary` |
| `inputRef` | Reference to the input, never the content: instruction hash and length, `capture:<id> prompt='...'`, `audio:<source> sha1=...` |
| `requestAt`, `responseAt` | UTC timestamps around the whole call, including retries |
| `durationMs`, `attempts` | Wall time and number of HTTP attempts |
| `success`, `status`, `error` | Outcome; errors carry the status and error code only |
| `traceId` | Provider request id from a response header, or the completion or response id |
| `outputRef` | Provider output id and size, for example `completion:<id> tool_calls=create_inspection_mission` or `response:<id> chars=812` |
| `transport` | `META_API` (network endpoint) or `MOCK_TRANSPORT` (test double) |
| `classification` | `LIVE_META` (successful request to the Meta API), `LIVE_META_FAILED`, or `MOCKED` |

The classification is decided by how the client was constructed, not by a flag a caller sets.
A client built with `httpx.MockTransport` can only ever log `MOCKED`.
`test_integration.py` asserts that a full mocked pipeline logs eight `MOCKED` records and zero `LIVE_META` records, and that no key, image data URL or instruction text appears in the log.
The judge preflight (`GET /api/system/preflight`) reports "Meta API connectivity verified" only when at least one `LIVE_META` record exists.

## Producing live evidence

With a key, from the repository root:

```bash
export MODEL_API_KEY=...            # never commit it
npm run eval:meta                   # writes docs/evidence/evaluation.json and docs/evidence/model-executions.json
```

`npm run eval:meta` runs through the real FastAPI routes and makes, in order:

1. One Voice Transcribe request on `public/demo/instruction.wav` (RECORDED_INPUT: synthetic speech generated with macOS `say`).
2. Muse Spark planning for the transcript and for each of the 12 hand-labelled instructions (typically two or more chat completions each).
3. Three captures of twin frames (`shared/fixtures/eval/frames/`) with three SAM 3.1 prompts each.

Expected cost at the published Standard-mode prices is well under one US dollar; `GET /api/system/status` reports the running estimate.

Then run the judge demo once with the same key (`npm run dev:all`, scene 08, Start judge demo) and export the log:

```bash
curl -s localhost:8000/api/evidence/model-executions?limit=1000 > docs/evidence/demo-executions.json
```

Commit both files.
Each `LIVE_META` record is the evidence; this document should then be updated with the counts, median latency per operation, and one screenshot of the Intelligence scene with LIVE META tags.

## Evidence log

| Date | Run | LIVE_META | LIVE_META_FAILED | MOCKED | File |
|---|---|---:|---:|---:|---|
| 2026-11-02 | `npm run eval:meta` without a key | 0 | 0 | 0 | `docs/evidence/evaluation.json` (live sections `NOT_RUN`) |
| 2026-11-02 | `pytest` full mocked pipeline | 0 | 0 | 8 | asserted in `backend/tests/test_integration.py`, not stored |

## What must not be claimed until the log shows otherwise

- That any transcript, mission, mask or summary on screen came from a Meta model.
- Any latency, cost or IoU figure for the Meta models.
- That the integration "works" against the live API.
