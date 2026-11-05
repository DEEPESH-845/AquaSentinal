# Architecture

## 1. Approach

Three approaches were compared.

1. Browser digital twin as the plant, Python backend for AI, validation, persistence and the hardware gateway (chosen).
2. Port the engine to Python and render backend telemetry in the browser.
3. Next.js API routes only, no Python.

Approach 2 was rejected because it duplicates HydraLoom's tested engine, loses the bit-identical Node and browser determinism, and puts a network hop between the camera render and the feed.
Approach 3 was rejected because OpenCV, pyserial, the GRBL driver and the official Python SAM parser belong server-side in Python, and the brief asks for a Python hardware and AI service.
In approach 1 the twin executes plans deterministically, while the backend compiles and validates every plan, owns every Meta call and every secret, stores evidence and gates any motion on hardware.

## 2. Service boundaries

| Layer | Owns | Never does |
|---|---|---|
| Browser (`app/`, `components/`, `lib/`) | 3D twin, simulation, mission execution in SIMULATION, frame capture, operator UI | Call Meta APIs, hold secrets, invent plans that bypass the backend |
| Simulation (`lib/sim/`) | Gantry motion, detector, scenarios, disturbances, adaptive policy, replay | Network, React |
| Backend (`backend/app/`) | Meta clients, mission compiler and lifecycle, tool allowlist, perception pipeline, tracking, SQLite, reports, motion controller and drivers | Run missions on the twin; move hardware without the interlocks |
| Shared (`shared/`) | Geometry, perception thresholds, contract fixtures | Code |

## 3. Data flow

```
voice (WAV 16 kHz) --POST /api/voice/transcribe--> Muse Voice Transcribe --> transcript
transcript + twin context --POST /api/ai/interpret--> Muse Spark tool loop
    get_telemetry / get_environment_conditions / get_camera_status --> create_inspection_mission
    --> MissionSpec (Pydantic) --> compile_plan --> MissionPlan (bounded waypoints) --> stored PLANNED
operator approves --POST /api/missions/{id}/start--> RUNNING; twin runMission(plan)
twin at each capture waypoint --> CaptureRequest --> FeedRenderer renders frame + ID pass
    --POST /api/inspection/capture--> quality (OpenCV) --> Spark frame reasoning --> SAM 3.1 per phrase
    --> IoU vs ID pass --> track association --> observations --> stored, event capture.processed
twin mission ends --POST /api/missions/{id}/complete--> COMPLETED/ABORTED --> summary (Spark or template)
    --> event report.ready --> GET /api/inspection/{id}/report (JSON or Markdown)
```

## 4. REST routes

All bodies are JSON in camelCase unless noted; unknown fields are rejected.

| Route | Purpose |
|---|---|
| `GET /api/health` | `{status, version, db, uptimeS}` |
| `GET /api/system/status` | Mode, hardware flags, provider status (LIVE, LIVE_LOCKED or OFFLINE plus fallback), usage and cost estimates, `credits` (`budgetUsd, spentUsd, remainingUsd, liveCalls, cachedCalls, saved: {total, byReason}`), `live` (`lockEnabled, unlocked`), inference queue, gantry snapshot, camera status |
| `POST /api/system/unlock` | `{passcode}`; returns `{unlocked}`, 429 after 10 failed attempts per minute per client address (rightmost `X-Forwarded-For` entry) or 30 across all clients; a correct passcode is never counted. With `AQUA_LIVE_PASSCODE` set, Meta-calling routes need header `X-Aqua-Passcode`; without it they take the offline path (transcribe and segment return 403 `{error: "live mode locked"}`). See `backend/app/meta/governor.py` |
| `GET /api/system/config` | Non-secret config: models, limits, geometry, perception thresholds |
| `POST /api/voice/transcribe` | Multipart `audio` (WAV), optional `inputSource`, optional `language` (`en` default, or `hi`: sends `languageBias: ["Hindi", "English"]`, otherwise `["English"]`); returns `{transcript, provider, model, sessionId, audioDurationMs, latencyMs}`; 503 without a key |
| `POST /api/ai/interpret?offline=` | `{instruction, context?, language?}` (`language` is `en` by default, or `hi`: Muse Spark writes its explanation in Hindi, tool arguments stay English enums; the instruction may be Hindi or Hinglish either way, and the mission stores the language); returns `{mission, provider, model}`; Spark failures return the error and tool timeline, never a substitute |
| `POST /api/ai/segment` | `{captureId, prompt}`; one SAM 3.1 request on a stored frame |
| `POST /api/missions` | Create from an operator `MissionSpec` |
| `GET /api/missions`, `GET /api/missions/{id}` | Mission records |
| `POST /api/missions/{id}/plan` | Re-compile a PLANNED or APPROVED mission, optionally with a new spec |
| `POST /api/missions/{id}/start` | `{executor: "TWIN" or "BACKEND"}`; BACKEND requires active hardware; refused while the e-stop is latched |
| `POST /api/missions/{id}/pause`, `/resume`, `/stop` | Status transitions, enforced by `TRANSITIONS`; stop cancels in-flight inference |
| `POST /api/missions/{id}/complete` | The twin's `MissionResult`; starts the summary task, written in the mission's language |
| `POST /api/inspection/capture` | Multipart `meta` (JSON `CaptureMeta`), `frame` (JPEG, at most 4 MB), optional `idmask` (PNG); returns `CaptureResult` |
| `GET /api/inspection/frames/{captureId}?kind=frame or ids` | Stored frame or ID mask |
| `GET /api/inspection/captures/{missionId}` | Captures with quality, reasoning and segmentations |
| `POST /api/inspection/observations` | Operator observation at gantry coordinates |
| `GET /api/inspection/history`, `GET /api/inspection/assets` | Mission history and persistent assets |
| `GET /api/inspection/{id}/report?format=json or md` | Report built from stored records |
| `POST /api/inspection/{id}/summary` | Regenerate the summary; optional body `{language}` overrides the mission's language. Offline templates stay English and are never machine-translated |
| `POST /api/gantry/command` | Command envelope (below) |
| `GET /api/telemetry` | Gantry snapshot after one watchdog check, camera status |
| `GET /api/camera/stream` | MJPEG of the latest frame |

## 5. WebSockets and envelopes

- `WS /ws/events?since=N`: server sends `hello`, replays history after `seq` N, then live events and a `heartbeat` every 10 s of silence; the client may send `{"type":"ping"}` (answered with `pong`); anything else gets an `error` envelope and the socket stays open.
- `WS /ws/telemetry`: `{v, type: "telemetry", ts, data: {gantry, camera}}` at 5 Hz.
- `WS /ws/commands`: `{v: 1, id, command}` where `command` is `MOVE_TO {x, y, speedFraction}` or one of `HOME`, `STOP`, `ESTOP`, `CLEAR_ESTOP`, `CONNECT`, `DISCONNECT`; replies `{v, id, ok, error?, state}`; invalid payloads get `ok: false` with the validation errors.
- Event envelope v1: `{v: 1, seq, type, ts, data}`; types are `mission.planned`, `mission.status`, `capture.processed`, `segmentation.started`, `hardware.status` (published only on change), `hardware.estop`, `report.ready`, plus `hello`, `heartbeat`, `pong`, `error`.
- The browser client (`lib/api/events.ts`) reconnects with exponential backoff from 1 s to 10 s and resumes with `since` set to the last seq it saw.

## 6. Shared contracts

- `shared/geometry.json`: travel, motion limits, origin offset, lens height, FOV, aspect, capture size; imported by `lib/sim/constants.ts` and `backend/app/geometry.py`.
- `shared/perception.json`: visibility thresholds, reduced speed, resume and operator timeouts, re-observation limits.
- `shared/fixtures/pipeline-spec.json` and `pipeline-plan.json`: the compiler must turn the spec into exactly the plan; the twin executes the plan in `sim:check`.
- `shared/fixtures/trajectory.json` and `projection.json`: generated by `npm run fixtures`; `sim:check` fails if TypeScript drifts from them and pytest checks the Python ports against them.

## 7. Persistence

- `backend/app/db.py` `Repository` is the only class that writes SQL (stdlib `sqlite3`, WAL mode).
- Tables: `missions`, `captures`, `segmentations`, `assets`, `observations`, `summaries`; records are stored as validated JSON next to indexed keys.
- Frames and ID masks are files under `AQUA_DATA_DIR/frames/<mission>/`.
- `DATABASE_URL` accepts only `sqlite:///` in this build; a PostgreSQL implementation is a second class with the same methods, since every caller speaks Pydantic models.

## 8. Frontend state

- `useSimStore` (`lib/sim/store.ts`) is the twin: engine, 20 Hz snapshot, scene and demo state.
- `useMissionStore` (`lib/store/mission.ts`) holds everything that crosses the network: backend status, the mission record, captures and their results, reports, history.
- `BackendBridge` polls status every 5 s, holds the event socket, posts finished twin missions and requests the demo plan.
- The live-mode passcode is held by `lib/api/client.ts`: in `sessionStorage` (this tab only, never the URL or `localStorage`) with an in-memory copy for browsers that block storage, and sent as `X-Aqua-Passcode` on every API request.
  The backend counts a wrong passcode header as a failed attempt on `/api/system/status` and the Meta-calling routes, so the client forgets it as soon as the status read shows the lock refused it, or a model route answers 403 `live mode locked`, and then stops sending it.
  Overlapping status reads share one request so a stale passcode costs one attempt, not several, and only the newest read may write the status, so a slow read from before an unlock or re-lock cannot overwrite it.
  A 429 on any other route is Meta rate limiting the backend and does not touch the passcode.
- The operator language (`en` or `hi`, default `en`) is `language` in `useMissionStore`, chosen with the EN | हिन्दी control in AI mission control and remembered in `localStorage` under `aqua.language` (read after mount; a blocked storage leaves the choice for the page only).
  It is sent as `language` on Voice Transcribe and planning requests, and only Meta models honour it.
  Wherever the output came from the offline parser or a template while Hindi is selected, the UI says `Hindi needs Meta models`: those paths stay English.
- `components/ui/credits.tsx` holds the header credit chip with its popover and the unlock dialog.
  Every figure comes from the `credits` object of the status; the popover carries the lock and unlock button wherever the header draws no AI chip (locked: below 600 px, unlocked: below 999 px).
