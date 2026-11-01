# AquaSentinal

Multimodal AI underwater inspection on a camera gantry, built on the HydraLoom testbed (commit `d59308e`).

An operator describes an inspection by voice or text.
Muse Spark 1.3 turns it into a structured mission through allowlisted tools; the backend validates it and compiles bounded waypoints.
After the operator approves, a deterministic digital twin of the XY gantry scans a pipeline in a test tank, capturing a frame at each waypoint.
Each frame goes through OpenCV image-quality analysis, Muse Spark frame reasoning, SAM 3.1 segmentation and track association.
The scan slows in degraded visibility, pauses when the camera cannot be trusted, and re-observes uncertain detections.
Every finding is stored with its frame, source and uncertainty, and the report marks anomaly candidates as unverified.

## Status

| Area | State |
|---|---|
| Digital twin, missions, adaptive policy, ten scenarios | Working and tested (`npm run sim:check`) |
| Backend API, persistence, reports, event sockets | Working and tested (54 pytest tests) |
| Muse Spark, SAM 3.1, Voice Transcribe | Implemented to the documented API, tested with mocked HTTP only: no API key was available, so no live request has been made |
| Offline mode (no key) | Working; labelled keyword parser, simulated detector, twin-geometry outlines, template summary |
| Gantry hardware | GRBL 1.1 serial driver, interlocks and watchdog implemented and tested against a fake controller; never run on physical hardware; disabled by default |

## Run it

Requirements: Node.js 20 or later, Python 3.11 or later.

```bash
npm install
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements-dev.txt
export MODEL_API_KEY=...       # optional: enables the Meta models; leave unset for labelled offline mode
npm run dev:all                # frontend http://localhost:3000, backend http://localhost:8000
```

To run the two halves separately:

```bash
npm run dev
cd backend && .venv/bin/uvicorn app.main:app --port 8000
```

The backend reads its configuration from the process environment only; no `.env` file is loaded.
Export the variables listed in `.env.example` in the shell that starts the backend, or prefix the command, for example `MODEL_API_KEY=... npm run dev:all`.
Without `MODEL_API_KEY` everything runs in labelled offline mode.

## Check it

```bash
npm run typecheck
npm run lint
npm run build
npm run sim:check
npm run e2e
cd backend && .venv/bin/python -m pytest
```

## Layout

```
app/                 Next.js shell and design tokens
components/lab/      Three.js twin: tank, gantry, pipeline objects, overlays, feed and capture renderer
components/ui/       Mission control, perception, navigation, environment, report, telemetry
lib/sim/             Deterministic engine: gantry, detector, missions, perception policy, scenarios, demo
lib/api/, lib/store/ Backend client, event socket, mission store
backend/app/         FastAPI: Meta clients, mission compiler and tools, perception pipeline, hardware, SQLite, reports
shared/              Geometry and perception config read by both languages, contract fixtures
docs/                Audit, migration map, architecture, integration, safety, testing, demo, roadmap
```

## Documents

- [Engineering audit](docs/ENGINEERING_AUDIT.md)
- [Migration map](docs/MIGRATION_MAP.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Meta model integration](docs/META_MODEL_INTEGRATION.md)
- [Perception pipeline](docs/PERCEPTION_PIPELINE.md)
- [Hardware integration](docs/HARDWARE_INTEGRATION.md)
- [Safety](docs/SAFETY.md)
- [Testing](docs/TESTING.md)
- [Demo script](docs/DEMO_SCRIPT.md)
- [Roadmap](docs/ROADMAP.md)
