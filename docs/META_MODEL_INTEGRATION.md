# Meta model integration

All Meta calls are server-side in `backend/app/meta/`; the browser only talks to the AquaSentinal backend.
Request shapes were taken from https://dev.meta.ai/docs (models, tool calling, structured output, image understanding, SAM segmenting and output grammar, voice transcribe API reference, error handling, pricing) as read on 2026-11-01.

## Status

No `MODEL_API_KEY` was available during development.
Every integration is implemented against the documented request and response formats and tested with mocked HTTP (`httpx.MockTransport`) in `backend/tests/test_meta.py` and `test_integration.py`.
No live Meta request has been made, so behaviour against the real service (latency, mask quality, model choices) is unverified.
That includes the features added on `feat/meta-hero`: Ask the inspector, work orders, the real water camera, Hindi and the credit governor's live path.
They are built to the same documented shapes and tested with `httpx.MockTransport`; their offline, locked and budget-refused paths are tested against the real backend with no key.
What a key unlocks is listed under "What still needs the key" below.

## Models and responsibilities

| Model | Used for | Endpoint and shape |
|---|---|---|
| `muse-spark-1.3` | Mission planning with tool calls; per-mission frame reasoning (which concrete nouns to segment); report summaries | `POST /v1/chat/completions` with nested `function` tools, `tool_choice: "auto"`; `response_format: {type: "json_schema"}` for frame reasoning and summaries; images as `image_url` data URLs in user messages |
| `sam-3.1` | Text-prompted segmentation of captured frames | `POST /v1/responses`, `stream: true`, one `input_text` noun phrase plus one `input_image` data URL, `metadata: {mask_encoding: "one_bit", include_confidence: "true"}` |
| `muse-voice-transcribe-1.0` | Push-to-talk speech to text | `POST /v1/asr/transcribe`, multipart `request` JSON `{model, audioEncoding: "WAV", mode: "PUSH_TO_TALK", keywords, languageBias: ["English"]}` (`["Hindi", "English"]` when the operator language is Hindi) plus `audio` |

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

## Work orders

- `WorkOrderService` (`backend/app/mission/workorders.py`) turns one mission's tracked objects into a prioritised list for a crew, in one `muse-spark-1.3` request with `response_format` json_schema and at most 1500 output tokens.
- The model sees at most 40 tracked objects and, for each, at most six capture ids; those are the only ids an order may cite.
- An order that fails the schema, cites no stored capture or cites an unknown one is dropped and counted (`droppedOrders`, `droppedEvidence`); nothing is repaired.
- Locations are clamped into the gantry travel, and loose cables and foreign objects are written as anomaly candidates to verify on site, never as confirmed defects.
- The request goes through the governed client: repeats are `CACHED_*`, the budget cap applies and a locked request makes no call.
- When Muse Spark cannot write the list, a rule table writes it from the same records, provider `OFFLINE_RULES`, English only, with the reason in `fallback` (`NO_KEY`, `LIVE_LOCKED`, `BUDGET_EXCEEDED`, `LIVE_META_FAILED`, `NO_ANSWER`).
- A mission with no observed object makes no request and orders nothing.

## Real water camera

- `POST /api/ai/segment-image` runs SAM 3.1 on one frame from the operator's phone or laptop camera, with one or two noun phrases and one request per phrase.
- The browser downscales the frame to 1024 px on its long side as JPEG before sending; the backend applies the same size and decode checks as a mission capture.
- Each phrase is its own governed request, so a repeated shutter is served from the cache with `requestsSent` 0 and no cost, and one failed phrase does not hide the other.
- Without a key, or when locked, the route answers 200 with `fallback` `NO_KEY` or `LIVE_LOCKED`, no masks and no request; the UI says SAM 3.1 needs the key.
- The frame is not stored; the execution log holds the same references-only records as any other call.

## Hindi

- The operator language (`en` or `hi`) is sent on Voice Transcribe (`languageBias`), planning, summaries, Ask and work orders.
- Muse Spark is told to write its prose in Hindi (`with_language`); tool arguments, enums, capture ids and numbers stay as they are.
- Offline paths (keyword parser, summary template, records query, work order rules) stay English and are never machine-translated; the UI says `Hindi needs Meta models` wherever that applies.
- Hindi text from a model is rendered with `lang="hi"` and a Devanagari font (Noto Sans Devanagari, loaded when first needed).

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

## Credit governor and live lock

`backend/app/meta/governor.py` sits under `MetaClient`, so Spark, SAM, Voice and every feature above get the same three behaviours.

- Response cache: `meta_cache` in SQLite, key = sha256 of kind, model and the canonical request, with image and audio bytes replaced by their sha256. Only complete successful responses are stored. A hit makes no network call and is logged as its own execution: `CACHED_LIVE` when the original was `LIVE_META`, otherwise `CACHED_<original classification>`, with cost 0 and `cachedFrom` pointing at the original.
- Budget cap: `AQUA_META_BUDGET_USD` (default 1.00). Before a request leaves, its worst-case cost is checked against the cap; spent is the sum of `costUsd` over `LIVE_META` executions, so it survives restarts on a persistent disk, and in-flight requests are reserved. Over budget raises `MetaBudgetExceeded` (HTTP 402) before any transport call.
- Saved calls: one tick per request avoided, by reason (`duplicate`, `unusable_quality`, `not_candidate`, `cache_hit`, `budget`); in memory.
- Live lock: with `AQUA_LIVE_PASSCODE` set, a Meta-calling route needs header `X-Aqua-Passcode`. Without it the route takes its no-key path and is labelled `LIVE_LOCKED`. Failed guesses are rate limited (10 per minute per client address, 30 across all clients) and the comparison uses `hmac.compare_digest`.
- The status route and the header credit chip show the same figures; the chip reads unknown, never a number, when the backend is unreachable.

## What still needs the key

- Every `LIVE_META` execution: none exists yet, so Stage One item 5 in docs/JUDGING_READINESS.md stays open.
- The wire format of the features added on this branch against the real service: Spark structured output for work orders, Spark tool loops for Ask, SAM 3.1 on photographs of real water, Hindi `languageBias`.
- Any real latency, cost or mask-quality figure; with no key the credit chip reads NO KEY, and with a key it shows `$0.000` of the budget until a live call is made.
- A recording of a live run for judges: not built on this branch.
- The murk benchmark, the live recorder, the `/proof` page and replay were planned and not built; nothing in the product or docs claims them.

## Execution log

Every request leaving `MetaClient` is recorded in the `model_executions` table with model, operation, input and output references, timestamps, duration, attempts, outcome and trace id, and served at `GET /api/evidence/model-executions`.
The classification is `LIVE_META` for a successful request to the network endpoint, `LIVE_META_FAILED` for a failed one, `MOCKED` whenever the client was built with `httpx.MockTransport`, and `CACHED_<original>` for a response replayed from the governor's cache.
Operations now also include `inspection_ask` and `work_orders`; the real water camera logs its requests as `segmentation`.
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
