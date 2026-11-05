# Meta model integration

All Meta calls are server-side in `backend/app/meta/`; the browser only talks to the AquaSentinal backend.
Request shapes were taken from https://dev.meta.ai/docs (models, tool calling, structured output, image understanding, SAM segmenting and output grammar, voice transcribe API reference, error handling, pricing) as read on 2026-11-01.

## Status

No `MODEL_API_KEY` was available during development.
Every integration is implemented against the documented request and response formats and tested with mocked HTTP (`httpx.MockTransport`) in `backend/tests/test_meta.py` and `test_integration.py`.
No live Meta request has been made, so behaviour against the real service (latency, mask quality, model choices) is unverified.

## Models and responsibilities

| Model | Used for | Endpoint and shape |
|---|---|---|
| `muse-spark-1.3` | Mission planning with tool calls; per-mission frame reasoning (which concrete nouns to segment); report summaries | `POST /v1/chat/completions` with nested `function` tools, `tool_choice: "auto"`; `response_format: {type: "json_schema"}` for frame reasoning and summaries; images as `image_url` data URLs in user messages |
| `sam-3.1` | Text-prompted segmentation of captured frames | `POST /v1/responses`, `stream: true`, one `input_text` noun phrase plus one `input_image` data URL, `metadata: {mask_encoding: "one_bit", include_confidence: "true"}` |
| `muse-voice-transcribe-1.0` | Push-to-talk speech to text | `POST /v1/asr/transcribe`, multipart `request` JSON `{model, audioEncoding: "WAV", mode: "PUSH_TO_TALK", keywords, languageBias: ["English"]}` plus `audio` |

## Muse Spark planning loop

- `Spark.plan` offers only the PLANNING tools: `get_telemetry`, `get_environment_conditions`, `get_camera_status`, `create_inspection_mission`.
- Each tool call is dispatched through `ToolRegistry`, which validates arguments with Pydantic and refuses tools outside the phase allowlist.
- Invalid or refused calls are returned to the model as tool results so it can correct itself, for at most six turns.
- The backend assigns the mission id, compiles the plan and stores it as PLANNED; nothing moves until the operator approves.
- If the model answers without creating a mission, or the API fails, the route returns the error and the tool timeline; it never substitutes another provider silently.
- The operator can explicitly choose the offline parser (`?offline=true`), and the result is labelled `OFFLINE_RULE_PARSER`.

## Ask the inspector

- `AskService` (`backend/app/mission/ask.py`) answers one question about one mission with `muse-spark-1.3`, at most three requests, each capped at `ASK_MAX_TOKENS` output tokens.
- The model is offered only the ASK phase of `ToolRegistry`: five read-only views of the stored records, and no tool that writes, moves or calls a model.
- The system prompt requires `[cap_id]` after every factual claim; the backend keeps only ids that a tool result contained, numbers them `[1]`, `[2]` and lists the rest as `droppedCitations`.
- An answer given without reading any record is sent back once to read them, and refused on the last turn.
- Every request goes through the governed client, so repeats are served as `CACHED_*` executions, the budget cap applies, and a locked request makes no call. `executionIds` lists the executions behind the answer and `classification` is derived from them.
- When Muse Spark cannot answer, the offline records query answers from the same tools and is labelled `OFFLINE_RECORDS_QUERY` with the reason (`LIVE_LOCKED`, `NO_KEY`, `BUDGET_EXCEEDED`, `LIVE_META_FAILED`, `NO_ANSWER`). It never translates: its answers are English.

## SAM 3.1

- One concept per request, as the docs require; the pipeline sends at most three phrases per capture.
- Phrases come from Muse Spark's structured frame reasoning on the first frame of a mission and are cached for the mission; a target the model did not mention gets a fixed fallback phrase (`FALLBACK_PHRASES` in `perception/pipeline.py`).
- The SSE stream is read by `MetaClient.responses_stream_text`, which accumulates `response.output_text.delta` until `response.completed` and raises on `response.failed` or `error`.
- The text is parsed by Meta's `meta-sam-parser` (`image_segmentation_format().create_parser()`), and masks are decoded with `decode_mask_to_raster` into box-local rasters placed at their bounds.
- Zero matches is an `EMPTY` result, not an error.
- Confidence is the model's `c` field; when absent it is stored as null, never zero.
- Masks are reduced to simplified polygons for the browser and kept as rasters only long enough to score IoU against the twin's ID pass.

## Voice Transcribe

- The browser records with `MediaRecorder`, resamples to 16 kHz mono with an `OfflineAudioContext` and wraps it as 16-bit PCM WAV (`lib/audio/wav.ts`).
- The backend checks the WAV header (mono, 16-bit, 16 or 24 kHz, 0.2 s to 10 minutes, at most 32 MB) before sending.
- `keywords` biases recognition toward gantry, pipeline, turbidity, inspection, carriage, debris, object tracking, segment, scan, waypoint, flange, valve, loose cable.
- The transcript fills the instruction box for the operator to review; Voice Transcribe does not synthesise speech and the UI never presents it as doing so.

## Models not used

- Muse Wonder (`muse-wonder-1.0`): takes the same requests as Spark at three to five times the token price ($4 and $20 per million input and output tokens); planning here is a single constrained tool call, so it adds cost without a demonstrated benefit.
- Muse Image: image generation has no role in the inspection loop; overlays are drawn from real segmentation geometry.
- Muse Glimmer and Muse Spark Open: open-weight models needing self-hosted GPU inference (Spark Open is an 816B mixture-of-experts model); no checkpoint was downloaded and no stub integration was added.

## Reliability and cost control

- One `MetaClient` owns the key (private attribute, Authorization header only, never in logs, reprs or error messages; a 401 message is replaced with a fixed text).
- Timeouts: 30 s request, 10 s connect (configurable with `META_REQUEST_TIMEOUT_S`).
- Retries: 408, 409, 429, 500, 502, 503, 504, timeouts and transport errors, up to `META_MAX_RETRIES` (3), honouring `Retry-After`, otherwise exponential backoff from 0.5 s capped at 8 s with jitter; 400, 401, 402 and 404 are not retried.
- Errors map onto the documented envelope `{message, type, code, param}` as `MetaAPIError`.
- `InferenceQueue`: concurrency limit (`sam_concurrency`, default 2), per-request timeout, in-flight deduplication by frame hash and prompt, cancellation of a mission's requests when it stops.
- Budgets per mission: 60 SAM requests and 12 Spark calls; beyond that the request is recorded as `SKIPPED_BUDGET` before any money is spent.
- Near-duplicate frames from the same position reuse the previous segmentation (`REUSED`), but only when the targets, prompts and fault fixture are identical and the previous result succeeded.
- A failed or budget-skipped segmentation is always retried, never reused.
- `UsageTracker` records requests, errors, retries, tokens, images, audio milliseconds, mean latency and an estimated cost using the published Standard-mode prices: Spark $1.25 and $4.25 per million input and output tokens, SAM $2.50 per 1,000 images, Voice $0.18 per audio hour.

## Execution log

Every request leaving `MetaClient` is recorded in the `model_executions` table with model, operation, input and output references, timestamps, duration, attempts, outcome and trace id, and served at `GET /api/evidence/model-executions`.
The classification is `LIVE_META` for a successful request to the network endpoint, `LIVE_META_FAILED` for a failed one, and `MOCKED` whenever the client was built with `httpx.MockTransport`.
Records hold references, never keys, audio, images or instruction text.
docs/META_USAGE_EVIDENCE.md explains how to produce and read live evidence.

## Offline behaviour

| Capability | Without a key |
|---|---|
| Interpretation | Keyword parser, provider `OFFLINE_RULE_PARSER`, with a warning on the mission |
| Frame reasoning | Not run; reported as `UNAVAILABLE` |
| Segmentation | Observations come from the twin's simulated detector (`SIM_DETECTOR`); outlines are the twin's ID-pass silhouettes for detector hits on target classes, provider `OFFLINE_FIXTURE`, confidence null |
| Voice | 503 with a message to type instead |
| Summary | Deterministic template, provider `TEMPLATE_FROM_RECORDS` |
