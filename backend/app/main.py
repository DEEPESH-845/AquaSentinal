"""AquaSentinal backend: FastAPI app, routes and WebSockets. docs/ARCHITECTURE.md lists every contract.

Run: uvicorn app.main:app --port 8000  (from backend/)
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel, Field, ValidationError

from .config import Settings, load_settings
from .db import Repository
from .events import EventBus
from .geometry import capture_size, perception_defaults, travel
from .hardware.camera import CameraManager
from .hardware.drivers import DriverFault, SerialGantryDriver, SimulatedGantryDriver, open_serial
from .hardware.motion import InterlockError, MotionController
from .meta.client import MetaAPIError, MetaClient
from .meta.governor import Governor, LiveLocked, client_ip, live_access
from .meta.sam import Sam
from .meta.spark import Spark
from .meta.voice import Voice
from .mission.ask import AskService
from .mission.service import MissionError, MissionService
from .mission.workorders import WorkOrderService
from .perception.pipeline import PerceptionPipeline
from .perception.realwater import clean_prompts, frame_size, segment_image
from .reporting import build_report, to_markdown
from .schemas import (
    AskRequest,
    AskResponse,
    CaptureMeta,
    CommandEnvelope,
    InterpretRequest,
    InterpretResponse,
    Language,
    MissionSpec,
    ObservationCreate,
    RealSegmentResponse,
    SegmentRequest,
    StartRequest,
    SummaryRequest,
    TranscriptResult,
    TwinMissionResult,
    WorkOrdersRequest,
    WorkOrdersResponse,
)

VERSION = "1.0.0"
log = logging.getLogger("aquasentinal")
MAX_FRAME_BYTES = 4 * 1024 * 1024
# 16 kHz mono WAV is 32 kB/s, so this is about five minutes of speech
MAX_AUDIO_BYTES = 10 * 1024 * 1024


async def read_frame(upload: UploadFile) -> bytes:
    """The uploaded frame, or 413 when it is missing, empty or over MAX_FRAME_BYTES. One check for every route that takes a frame."""
    jpeg = await upload.read(MAX_FRAME_BYTES + 1)
    if not jpeg or len(jpeg) > MAX_FRAME_BYTES:
        raise HTTPException(413, "frame missing or larger than 4 MB")
    return jpeg


class UnlockBody(BaseModel):
    passcode: str = Field("", max_length=256)


@dataclass
class Services:
    settings: Settings
    repo: Repository
    events: EventBus
    governor: Governor
    meta: MetaClient | None
    spark: Spark | None
    sam: Sam | None
    voice: Voice | None
    pipeline: PerceptionPipeline
    motion: MotionController
    camera: CameraManager
    missions: MissionService
    asker: AskService
    work_orders: WorkOrderService
    sim_driver: SimulatedGantryDriver | None
    started_at: float


def build_services(settings: Settings, meta_transport=None, serial_factory=None) -> Services:
    repo = Repository(settings.sqlite_path, settings.data_dir)
    events = EventBus()
    governor = Governor(repo, settings.meta_budget_usd, settings.live_passcode)
    meta = spark = sam = voice = None
    if settings.meta_available:
        meta = MetaClient(
            settings.model_api_key, settings.meta_base_url, timeout_s=settings.request_timeout_s, max_retries=settings.max_retries,
            transport=meta_transport, on_execution=repo.save_execution, governor=governor,
        )
        spark, sam, voice = Spark(meta, settings.spark_model), Sam(meta, settings.sam_model), Voice(meta, settings.voice_model)
    hardware = settings.app_mode == "HARDWARE" and settings.hardware_enable and bool(settings.serial_port or serial_factory)
    sim_driver = None
    if hardware:
        driver = SerialGantryDriver(serial_factory or open_serial(settings.serial_port, settings.serial_baud))
    else:
        driver = sim_driver = SimulatedGantryDriver()
    motion = MotionController(driver, events, hardware=hardware)
    camera = CameraManager(settings.camera_device if settings.app_mode == "HARDWARE" else "")
    pipeline = PerceptionPipeline(settings, repo, events, spark, sam, governor)

    async def hw_status() -> dict:
        return motion.snapshot()

    missions = MissionService(repo, events, spark, pipeline, hw_status)
    return Services(settings, repo, events, governor, meta, spark, sam, voice, pipeline, motion, camera, missions, AskService(repo, spark), WorkOrderService(repo, spark), sim_driver, time.time())


def create_app(settings: Settings | None = None, *, meta_transport=None, serial_factory=None) -> FastAPI:
    settings = settings or load_settings()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        s = build_services(settings, meta_transport, serial_factory)
        app.state.s = s
        tasks: list[asyncio.Task] = []
        if s.sim_driver is not None:
            async def advance() -> None:  # the simulated driver runs in real time
                last = time.monotonic()
                while True:
                    await asyncio.sleep(1 / 60)
                    now = time.monotonic()
                    s.sim_driver.advance(now - last)  # type: ignore[union-attr]
                    last = now

            tasks.append(asyncio.create_task(advance()))
        s.motion.start()
        s.camera.start_device()
        if settings.app_mode == "HARDWARE" and not s.motion.hardware:
            log.warning("APP_MODE=HARDWARE but AQUA_HARDWARE_ENABLE is false or no serial port is set: using the simulated driver")
        try:
            yield
        finally:
            for t in tasks:
                t.cancel()
            await s.motion.shutdown()
            s.camera.stop()
            if s.meta:
                await s.meta.aclose()
            s.repo.close()

    app = FastAPI(title="AquaSentinal", version=VERSION, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_origin_regex=settings.cors_origin_regex or None,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Retry-After"],  # the browser may show how long the passcode throttle lasts
    )

    def S(request: Request) -> Services:
        return request.app.state.s

    @app.exception_handler(MissionError)
    async def _mission_error(_: Request, e: MissionError):
        return JSONResponse({"error": str(e), "detail": e.detail}, status_code=e.status)

    @app.exception_handler(MetaAPIError)
    async def _meta_error(_: Request, e: MetaAPIError):
        status = e.status if 400 <= e.status < 600 else 502
        return JSONResponse({"error": str(e), "detail": e.public()}, status_code=status)

    @app.exception_handler(LiveLocked)
    async def _live_locked(_: Request, __: LiveLocked):
        return JSONResponse({"error": "live mode locked"}, status_code=403)

    @app.exception_handler(InterlockError)
    async def _interlock(_: Request, e: InterlockError):
        return JSONResponse({"error": str(e), "interlock": True}, status_code=409)

    # ------------------------------------------------------------ system

    @app.get("/api/health")
    async def health(request: Request):
        s = S(request)
        return {"status": "ok", "version": VERSION, "db": s.repo.ping(), "uptimeS": round(time.time() - s.started_at, 1)}

    def providers(s: Services, unlocked: bool) -> dict[str, Any]:
        live = "OFFLINE" if not s.meta else "LIVE" if unlocked else "LIVE_LOCKED"
        return {
            "spark": {"status": live, "model": settings.spark_model, "fallback": None if live == "LIVE" else "OFFLINE_RULE_PARSER"},
            "sam": {"status": live, "model": settings.sam_model, "fallback": None if live == "LIVE" else "SIM_DETECTOR + OFFLINE_FIXTURE masks"},
            "voice": {"status": live, "model": settings.voice_model, "fallback": None if live == "LIVE" else "text input"},
        }

    @app.get("/api/system/status")
    async def system_status(request: Request, live: bool = Depends(live_access)):
        s = S(request)
        return {
            "version": VERSION,
            "mode": settings.app_mode,
            "hardwareEnabled": settings.hardware_enable,
            "hardwareActive": s.motion.hardware,
            "providers": providers(s, live),
            "usage": s.meta.usage.snapshot() if s.meta else {},
            "credits": s.governor.credits(),
            "live": {"lockEnabled": s.governor.lock_enabled, "unlocked": live},
            "inference": {"active": s.pipeline.queue.active, "concurrency": settings.sam_concurrency},
            "gantry": s.motion.snapshot(),
            "camera": s.camera.status(),
            "db": s.repo.ping(),
            "eventSubscribers": s.events.subscribers,
        }

    @app.post("/api/system/unlock")
    async def unlock(request: Request, body: UnlockBody):
        """Checks a passcode so the browser can tell the operator whether it will work. The browser then sends it as X-Aqua-Passcode."""
        unlocked, limited = S(request).governor.unlock(body.passcode, client_ip(request))
        if limited:
            return JSONResponse({"error": "too many passcode attempts; try again in a minute", "unlocked": False}, status_code=429, headers={"Retry-After": "60"})
        return {"unlocked": unlocked}

    @app.get("/api/system/config")
    async def system_config():
        tx, ty = travel()
        w, h = capture_size()
        return {**settings.public(), "geometry": {"travelX": tx, "travelY": ty, "captureWidth": w, "captureHeight": h}, "perception": perception_defaults()}

    # ------------------------------------------------------------ evidence

    @app.get("/api/evidence/model-executions")
    async def model_executions(request: Request, limit: int = Query(100, ge=1, le=1000)):
        """The model execution log. LIVE_META means a successful request to the Meta API endpoint; nothing else does."""
        s = S(request)
        return {"transport": s.meta.transport_kind if s.meta else "NONE", "counts": s.repo.execution_counts(), "executions": s.repo.executions(limit)}

    @app.get("/api/system/preflight")
    async def preflight(request: Request):
        """Judge-demo readiness, from facts this process can check. Connectivity is only proven by a logged LIVE_META call."""
        s = S(request)
        counts = s.repo.execution_counts()
        live_ok = counts.get("LIVE_META", 0)
        cam = s.camera.status()
        checks = [
            {"id": "backend", "label": "Backend available", "ok": True, "detail": f"FastAPI {VERSION}"},
            {"id": "db", "label": "Evidence store writable", "ok": s.repo.ping(), "detail": "SQLite"},
            {"id": "credentials", "label": "Meta credentials loaded", "ok": s.meta is not None, "detail": "MODEL_API_KEY set" if s.meta else "MODEL_API_KEY not set: Meta models cannot run"},
            {
                "id": "meta_live", "label": "Meta API connectivity verified", "ok": live_ok > 0,
                "detail": f"{live_ok} successful live call(s) logged" if live_ok else "no successful live Meta call logged by this backend yet",
            },
            {"id": "sam", "label": "SAM 3.1 segmentation available", "ok": s.sam is not None, "detail": settings.sam_model if s.sam else "offline: twin-geometry outlines, labelled"},
            {"id": "voice", "label": "Voice Transcribe available", "ok": s.voice is not None, "detail": settings.voice_model if s.voice else "offline: typed instruction"},
            {"id": "camera", "label": "Camera input identified", "ok": True, "detail": "OPENCV device (unverified on the rig)" if cam.get("source") == "OPENCV_DEVICE" else "SIMULATED: digital-twin render"},
            {"id": "mode", "label": "Simulation or hardware identified", "ok": True, "detail": "HARDWARE (serial GRBL, unverified)" if s.motion.hardware else "SIMULATED gantry: no physical motion"},
            {"id": "estop", "label": "Emergency stop available", "ok": True, "detail": "latched" if s.motion.snapshot().get("estop") else "armed"},
        ]
        blockers = [c["id"] for c in checks if not c["ok"]]
        return {"ready": not blockers, "liveMetaReady": s.meta is not None and live_ok > 0, "blockers": blockers, "checks": checks}

    # ------------------------------------------------------------ voice and AI

    @app.post("/api/voice/transcribe", response_model=TranscriptResult)
    async def transcribe(
        request: Request, audio: UploadFile = File(...), input_source: str = Form("LIVE_MICROPHONE", alias="inputSource"), language: Language = Form("en"), live: bool = Depends(live_access)
    ):
        s = S(request)
        if not live:
            raise LiveLocked()
        if input_source not in ("LIVE_MICROPHONE", "RECORDED_INPUT"):
            raise HTTPException(422, "inputSource must be LIVE_MICROPHONE or RECORDED_INPUT")
        if s.voice is None:
            raise HTTPException(503, "Muse Voice Transcribe is unavailable: MODEL_API_KEY is not configured. Type the instruction instead.")
        data = await audio.read(MAX_AUDIO_BYTES + 1)
        if not data or len(data) > MAX_AUDIO_BYTES:
            raise HTTPException(413, "audio missing or larger than 10 MB (about five minutes)")
        body, latency = await s.voice.transcribe(data, ref=f"audio:{input_source} sha1={hashlib.sha1(data).hexdigest()[:10]}", language=language)
        return TranscriptResult(
            transcript=str(body.get("transcript", "")), provider="MUSE_VOICE_TRANSCRIBE", model=settings.voice_model,
            session_id=str(body.get("sessionId", "")), audio_duration_ms=int(body.get("audioDurationMs") or 0), latency_ms=None if latency is None else round(latency, 1),
        )

    @app.post("/api/ai/interpret", response_model=InterpretResponse)
    async def interpret(request: Request, body: InterpretRequest, offline: bool = Query(False, description="force the labelled offline parser"), live: bool = Depends(live_access)):
        s = S(request)
        mission, model = await s.missions.interpret(body, force_offline=offline, live=live)
        return InterpretResponse(mission=mission, provider=mission.provider, model=model)

    @app.post("/api/ai/segment")
    async def segment(request: Request, body: SegmentRequest, live: bool = Depends(live_access)):
        s = S(request)
        if not live:
            raise LiveLocked()
        cap = s.repo.get_capture(body.capture_id)
        if cap is None:
            raise HTTPException(404, "capture not found")
        if s.sam is None:
            raise HTTPException(503, "SAM 3.1 is unavailable: MODEL_API_KEY is not configured")
        meta = CaptureMeta.model_validate(cap["meta"])
        jpeg = open(cap["frame_path"], "rb").read()
        from .perception.pipeline import decode_id_mask

        ids = None
        if cap["idmask_path"]:
            w, h = capture_size()
            ids = decode_id_mask(open(cap["idmask_path"], "rb").read(), w, h)
        img_w, img_h = capture_size()
        seg = await s.pipeline._segment_one(meta, cap["id"], jpeg, img_w, img_h, ids, {"phrase": body.prompt, "target_class": None})
        s.repo.save_segmentation(seg)
        return seg.model_dump(by_alias=True)

    @app.post("/api/ai/segment-image", response_model=RealSegmentResponse)
    async def segment_real_image(request: Request, frame: UploadFile = File(...), prompt: list[str] = Form(...), live: bool = Depends(live_access)):
        """SAM 3.1 on one camera frame, one request per prompt (one or two). A keyless or locked backend still answers, saying so, and sends nothing."""
        try:
            prompts = clean_prompts(prompt)
        except ValueError as e:
            raise HTTPException(422, str(e))
        jpeg = await read_frame(frame)
        try:
            size = frame_size(jpeg)
        except ValueError as e:  # not a decodable image
            raise HTTPException(422, str(e))
        return await segment_image(S(request).sam, jpeg, size, prompts, live)

    # ------------------------------------------------------------ missions

    @app.post("/api/missions")
    async def create_mission(request: Request, spec: MissionSpec):
        return (await S(request).missions.create(spec)).model_dump(by_alias=True)

    @app.get("/api/missions")
    async def list_missions(request: Request, limit: int = Query(50, ge=1, le=200)):
        return [m.model_dump(by_alias=True) for m in S(request).repo.list_missions(limit)]

    @app.get("/api/missions/{mission_id}")
    async def get_mission(request: Request, mission_id: str):
        return S(request).missions.get(mission_id).model_dump(by_alias=True)

    @app.post("/api/missions/{mission_id}/plan")
    async def replan(request: Request, mission_id: str, spec: MissionSpec | None = None):
        return (await S(request).missions.replan(mission_id, spec)).model_dump(by_alias=True)

    @app.post("/api/missions/{mission_id}/start")
    async def start(request: Request, mission_id: str, body: StartRequest | None = None):
        s = S(request)
        body = body or StartRequest()
        if body.executor == "BACKEND" and not s.motion.hardware:
            raise MissionError(409, "the backend executor drives physical hardware; in SIMULATION the digital twin executes missions")
        if s.motion.estop:
            raise MissionError(409, "emergency stop is latched")
        return (await s.missions.set_status(mission_id, "RUNNING", body.executor)).model_dump(by_alias=True)

    for action, status in (("pause", "PAUSED"), ("resume", "RUNNING"), ("stop", "ABORTED")):

        async def handler(request: Request, mission_id: str, _status: str = status):
            return (await S(request).missions.set_status(mission_id, _status)).model_dump(by_alias=True)

        app.post(f"/api/missions/{{mission_id}}/{action}", name=f"mission_{action}")(handler)

    @app.post("/api/missions/{mission_id}/complete")
    async def complete(request: Request, mission_id: str, result: TwinMissionResult, live: bool = Depends(live_access)):
        return (await S(request).missions.complete(mission_id, result, live)).model_dump(by_alias=True)

    # ------------------------------------------------------------ inspection

    @app.post("/api/inspection/capture")
    async def capture(request: Request, meta: str = Form(...), frame: UploadFile = File(...), idmask: UploadFile | None = File(None), live: bool = Depends(live_access)):
        s = S(request)
        try:
            m = CaptureMeta.model_validate_json(meta)
        except ValidationError as e:
            raise HTTPException(422, e.errors(include_url=False, include_context=False))
        jpeg = await read_frame(frame)
        ids = await idmask.read(MAX_FRAME_BYTES + 1) if idmask else None
        if ids and len(ids) > MAX_FRAME_BYTES:
            raise HTTPException(413, "id mask larger than 4 MB")
        w, h = capture_size()
        s.camera.push(jpeg, w, h)
        try:
            result = await s.pipeline.process(m, jpeg, ids, live)
        except ValueError as e:
            raise HTTPException(422, str(e))
        return result.model_dump(by_alias=True)

    @app.get("/api/inspection/frames/{capture_id}")
    async def frame(request: Request, capture_id: str, kind: str = Query("frame", pattern="^(frame|ids)$")):
        cap = S(request).repo.get_capture(capture_id)
        path = cap and (cap["frame_path"] if kind == "frame" else cap["idmask_path"])
        if not path:
            raise HTTPException(404, "frame not found")
        return FileResponse(path, media_type="image/jpeg" if kind == "frame" else "image/png")

    @app.get("/api/inspection/captures/{mission_id}")
    async def captures(request: Request, mission_id: str):
        s = S(request)
        out = []
        for c in s.repo.captures_for(mission_id):
            out.append({"id": c["id"], "seq": c["seq"], "meta": c["meta"], "quality": c["quality"], "reasoning": c["reasoning"], "duplicateOf": c["duplicate_of"],
                        "segmentations": [g.model_dump(by_alias=True) for g in s.repo.segmentations_for(c["id"])]})
        return out

    @app.post("/api/inspection/observations")
    async def add_observation(request: Request, body: ObservationCreate):
        s = S(request)
        s.missions.get(body.mission_id)
        from .perception.tracking import Sighting

        asset = s.pipeline.tracker.associate(body.mission_id, Sighting(label=body.label, x=body.x, y=body.y, w=4, h=4, confidence=None))
        from .db import new_id
        from .schemas import Observation

        o = Observation(id=new_id("obs"), mission_id=body.mission_id, capture_id=None, asset_id=asset.id, source="OPERATOR", label=body.label, confidence=None,
                        confidence_source=None, x=body.x, y=body.y, status="OBSERVED", created_at=time.time())
        s.repo.save_observation(o)
        return o.model_dump(by_alias=True)

    @app.get("/api/inspection/history")
    async def history(request: Request, limit: int = Query(30, ge=1, le=200)):
        s = S(request)
        out = []
        for m in s.repo.list_missions(limit):
            obs = s.repo.observations_for(m.id)
            out.append({"id": m.id, "createdAt": m.created_at, "status": m.status, "provider": m.provider, "instruction": m.instruction,
                        "captures": len(s.repo.captures_for(m.id)), "observations": len(obs), "assets": len({o.asset_id for o in obs}), "result": m.result})
        return out

    @app.get("/api/inspection/assets")
    async def assets(request: Request):
        return [a.model_dump(by_alias=True) for a in S(request).repo.assets()]

    @app.get("/api/inspection/{mission_id}/report")
    async def report(request: Request, mission_id: str, format: str = Query("json", pattern="^(json|md)$")):
        r = build_report(S(request).repo, mission_id)
        if r is None:
            raise HTTPException(404, "mission not found")
        if format == "md":
            return PlainTextResponse(to_markdown(r), media_type="text/markdown", headers={"Content-Disposition": f'attachment; filename="{mission_id}.md"'})
        return r

    @app.post("/api/inspection/{mission_id}/summary")
    async def regenerate_summary(request: Request, mission_id: str, body: SummaryRequest | None = None, live: bool = Depends(live_access)):
        return await S(request).missions.summarize(mission_id, live, body.language if body else None)

    @app.post("/api/inspection/{mission_id}/ask", response_model=AskResponse)
    async def ask(request: Request, mission_id: str, body: AskRequest, live: bool = Depends(live_access)):
        """Grounded Q&A over one mission's stored records: Muse Spark through read-only tools, else the labelled offline records query."""
        return await S(request).asker.ask(mission_id, body.question, body.language, live)

    @app.post("/api/inspection/{mission_id}/work-orders", response_model=WorkOrdersResponse)
    async def work_orders(request: Request, mission_id: str, body: WorkOrdersRequest, live: bool = Depends(live_access)):
        """Work orders for one mission, grounded in its stored captures: Muse Spark structured output, else the labelled offline rule table."""
        return await S(request).work_orders.generate(mission_id, body.language, live)

    # ------------------------------------------------------------ gantry and telemetry

    async def run_command(s: Services, env: CommandEnvelope) -> dict[str, Any]:
        c = env.command
        try:
            if c.type == "ESTOP":
                await s.motion.emergency_stop("operator")
            elif c.type == "CLEAR_ESTOP":
                await s.motion.clear_estop()
            elif c.type == "STOP":
                await s.motion.stop()
            elif c.type == "HOME":
                await s.motion.home()
            elif c.type == "CONNECT":
                await s.motion.connect()
            elif c.type == "DISCONNECT":
                await s.motion.disconnect()
            elif c.type == "MOVE_TO":
                await s.motion.move_to(c.x, c.y, c.speed_fraction)  # type: ignore[union-attr]
            return {"v": 1, "id": env.id, "ok": True, "state": s.motion.snapshot()}
        except (InterlockError, DriverFault) as e:
            return {"v": 1, "id": env.id, "ok": False, "error": str(e), "state": s.motion.snapshot()}

    @app.post("/api/gantry/command")
    async def gantry_command(request: Request, env: CommandEnvelope):
        return await run_command(S(request), env)

    @app.get("/api/telemetry")
    async def telemetry(request: Request):
        s = S(request)
        await s.motion.check_once()
        return {"gantry": s.motion.snapshot(), "camera": s.camera.status(), "mode": settings.app_mode}

    @app.get("/api/camera/stream")
    async def camera_stream(request: Request):
        return StreamingResponse(S(request).camera.mjpeg(), media_type="multipart/x-mixed-replace; boundary=frame")

    @app.websocket("/ws/telemetry")
    async def ws_telemetry(ws: WebSocket):
        await ws.accept()
        s: Services = ws.app.state.s
        try:
            while True:
                await ws.send_json({"v": 1, "type": "telemetry", "ts": time.time(), "data": {"gantry": s.motion.snapshot(), "camera": s.camera.status()}})
                await asyncio.sleep(0.2)
        except (WebSocketDisconnect, RuntimeError):
            return

    @app.websocket("/ws/events")
    async def ws_events(ws: WebSocket, since: int = 0):
        await ws.accept()
        s: Services = ws.app.state.s
        q = s.events.subscribe()
        try:
            await ws.send_json(s.events.envelope("hello", {"version": VERSION, "mode": settings.app_mode}))
            for env in s.events.since(since):
                await ws.send_json(env)
            recv = asyncio.create_task(ws.receive_text())
            while True:
                get = asyncio.create_task(q.get())
                done, _ = await asyncio.wait({get, recv}, timeout=10, return_when=asyncio.FIRST_COMPLETED)
                if not done:
                    get.cancel()
                    await ws.send_json(s.events.envelope("heartbeat", {}))
                    continue
                if get in done:
                    await ws.send_json(get.result())
                else:
                    get.cancel()
                if recv in done:
                    raw = recv.result()
                    try:
                        msg = json.loads(raw)
                        kind = msg.get("type") if isinstance(msg, dict) else None
                    except json.JSONDecodeError:
                        kind = None
                    if kind == "ping":
                        await ws.send_json(s.events.envelope("pong", {}))
                    elif kind != "ack":
                        await ws.send_json(s.events.envelope("error", {"message": "unrecognised message; this socket only accepts ping"}))
                    recv = asyncio.create_task(ws.receive_text())
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            s.events.unsubscribe(q)

    @app.websocket("/ws/commands")
    async def ws_commands(ws: WebSocket):
        await ws.accept()
        s: Services = ws.app.state.s
        try:
            while True:
                raw = await ws.receive_text()
                try:
                    env = CommandEnvelope.model_validate_json(raw)
                except ValidationError as e:
                    await ws.send_json({"v": 1, "ok": False, "error": "invalid command", "detail": e.errors(include_url=False, include_context=False)})
                    continue
                await ws.send_json(await run_command(s, env))
        except (WebSocketDisconnect, RuntimeError):
            return

    return app


app = create_app()
