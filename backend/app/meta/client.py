"""Server-side Meta Model API client. https://dev.meta.ai/docs/error-handling

One place owns the key, timeouts, retries, error mapping and usage accounting. The key is held in a private attribute,
sent only as the Authorization header, and never logged, echoed or included in an exception message.
When built with a Governor (meta/governor.py), every request through chat, responses_stream_text and multipart is served
from the response cache or checked against the USD budget first, so callers get both without doing anything.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import time
import uuid
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager, nullcontext
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import httpx

if TYPE_CHECKING:
    from .governor import Governor, Ticket

log = logging.getLogger("aquasentinal.meta")

# Pay-as-you-go Standard-mode prices from https://dev.meta.ai/docs/pricing-rate-limits (2026-11), used for estimates only.
PRICE_SPARK_INPUT_PER_M = 1.25
PRICE_SPARK_OUTPUT_PER_M = 4.25
PRICE_SAM_PER_IMAGE = 2.50 / 1000
PRICE_VOICE_PER_HOUR = 0.18

RETRYABLE_STATUS = {408, 409, 429, 500, 502, 503, 504}


class MetaAPIError(Exception):
    """A failed Meta API call, mapped onto the documented error envelope."""

    def __init__(self, status: int, message: str, *, type_: str | None = None, code: str | None = None, retryable: bool = False):
        super().__init__(message)
        self.status = status
        self.type = type_
        self.code = code
        self.retryable = retryable

    def public(self) -> dict[str, Any]:
        return {"status": self.status, "type": self.type, "code": self.code, "message": str(self)}


class MetaUnavailable(MetaAPIError):
    def __init__(self) -> None:
        super().__init__(503, "MODEL_API_KEY is not configured; Meta models are unavailable in this deployment", code="not_configured")


class MetaBudgetExceeded(MetaAPIError):
    """Refused before any request was sent: spent + the request's worst-case cost would pass the budget."""

    def __init__(self, message: str) -> None:
        super().__init__(402, message, type_="budget_error", code="budget_exceeded")


@dataclass
class ModelUsage:
    requests: int = 0
    errors: int = 0
    retries: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    images: int = 0
    audio_ms: int = 0
    latency_ms_total: float = 0.0
    last_error: str | None = None

    @property
    def cost_usd(self) -> float:
        return (
            self.prompt_tokens / 1e6 * PRICE_SPARK_INPUT_PER_M
            + self.completion_tokens / 1e6 * PRICE_SPARK_OUTPUT_PER_M
            + self.images * PRICE_SAM_PER_IMAGE
            + self.audio_ms / 3_600_000 * PRICE_VOICE_PER_HOUR
        )


@dataclass
class UsageTracker:
    by_model: dict[str, ModelUsage] = field(default_factory=dict)

    def get(self, model: str) -> ModelUsage:
        return self.by_model.setdefault(model, ModelUsage())

    def snapshot(self) -> dict[str, Any]:
        return {
            m: {
                "requests": u.requests,
                "errors": u.errors,
                "retries": u.retries,
                "promptTokens": u.prompt_tokens,
                "completionTokens": u.completion_tokens,
                "images": u.images,
                "audioMs": u.audio_ms,
                "avgLatencyMs": round(u.latency_ms_total / u.requests, 1) if u.requests else None,
                "estimatedCostUsd": round(u.cost_usd, 5),
                "lastError": u.last_error,
            }
            for m, u in self.by_model.items()
        }


def _count_images(payload: dict[str, Any]) -> int:
    """input_image parts of a Responses API payload."""
    parts = (p for m in payload.get("input") or [] if isinstance(m, dict) for p in m.get("content") or [] if isinstance(p, dict))
    return sum(p.get("type") == "input_image" for p in parts)


# Execution records emitted by the calls of the task that opened collect_executions(), for a caller that must say which executions made its answer.
_sink: ContextVar[list[dict[str, Any]] | None] = ContextVar("meta_execution_sink", default=None)


@contextmanager
def collect_executions() -> Iterator[list[dict[str, Any]]]:
    """Copies of every execution record (live, failed, cached or mocked) the calls made inside the block produce, in order."""
    records: list[dict[str, Any]] = []
    token = _sink.set(records)
    try:
        yield records
    finally:
        _sink.reset(token)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


# Response headers that may carry a provider trace id. Only the value is kept; no other header is recorded.
TRACE_HEADERS = ("x-request-id", "x-fb-trace-id", "x-trace-id", "request-id")


def _trace_id(resp: httpx.Response | None) -> str | None:
    if resp is None:
        return None
    for h in TRACE_HEADERS:
        if resp.headers.get(h):
            return resp.headers[h][:128]
    return None


def _map_error(resp: httpx.Response) -> MetaAPIError:
    type_ = code = None
    message = f"HTTP {resp.status_code}"
    try:
        body = resp.json()
        err = body.get("error", body) if isinstance(body, dict) else {}
        if isinstance(err, dict):
            message = str(err.get("message") or message)
            type_ = err.get("type")
            code = err.get("code")
    except (json.JSONDecodeError, ValueError):
        if resp.text:
            message = resp.text[:300]
    if resp.status_code == 401:
        message = "authentication failed: check MODEL_API_KEY"  # never echo anything key-shaped
    return MetaAPIError(resp.status_code, message, type_=type_, code=code, retryable=resp.status_code in RETRYABLE_STATUS)


class MetaClient:
    def __init__(
        self,
        api_key: str,
        base_url: str = "https://api.meta.ai/v1",
        *,
        timeout_s: float = 30.0,
        max_retries: int = 3,
        transport: httpx.AsyncBaseTransport | None = None,
        usage: UsageTracker | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        on_execution: Callable[[dict[str, Any]], None] | None = None,
        governor: Governor | None = None,
    ):
        self.__key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s
        self.max_retries = max_retries
        self.usage = usage or UsageTracker()
        self._sleep = sleep
        self._on_execution = on_execution
        self.gov = governor  # None means ungoverned: no cache, no budget (tests that exercise the client alone)
        # Evidence classification is decided by construction, never by a flag a caller could forget:
        # a test transport is MOCK_TRANSPORT, anything else is the network endpoint at base_url.
        self.transport_kind = "MOCK_TRANSPORT" if isinstance(transport, httpx.MockTransport) else "META_API"
        self._http = httpx.AsyncClient(base_url=self.base_url, transport=transport, timeout=httpx.Timeout(timeout_s, connect=10.0))

    @property
    def available(self) -> bool:
        return bool(self.__key)

    def __repr__(self) -> str:  # the key must never appear in a repr or a traceback
        return f"MetaClient(base_url={self.base_url!r}, available={self.available})"

    async def aclose(self) -> None:
        await self._http.aclose()

    def _headers(self, accept: str = "application/json") -> dict[str, str]:
        return {"Authorization": f"Bearer {self.__key}", "Accept": accept}

    def _emit(self, rec: dict[str, Any]) -> None:
        """Finishes an execution record and hands it to the sink. A failing sink never fails the model call."""
        rec["responseAt"] = _now_iso()
        rec.setdefault("costUsd", 0.0)  # what a request cost; only LIVE_META records count toward the budget
        if "classification" not in rec:  # a cache hit arrives classified: it inherits from the execution it replays
            rec["classification"] = "MOCKED" if rec["transport"] == "MOCK_TRANSPORT" else "LIVE_META" if rec["success"] else "LIVE_META_FAILED"
        if (sink := _sink.get()) is not None:
            sink.append(dict(rec))
        if self._on_execution:
            try:
                self._on_execution(rec)
            except Exception:  # noqa: BLE001
                log.exception("could not record a model execution")

    async def _with_retries(
        self, model: str, call: Callable[[], Awaitable[httpx.Response]], op: str = "", input_ref: str = ""
    ) -> tuple[httpx.Response, float, dict[str, Any]]:
        """Returns the response, latency and an open execution record. On failure the record is emitted here;
        on success the caller adds its output reference and emits it."""
        if not self.available:
            raise MetaUnavailable()
        usage = self.usage.get(model)
        attempt = 0
        rec: dict[str, Any] = {
            "id": f"exe_{uuid.uuid4().hex[:12]}", "model": model, "operation": op, "inputRef": input_ref, "requestAt": _now_iso(),
            "transport": self.transport_kind, "endpoint": self.base_url, "attempts": 0, "success": False,
            "status": None, "error": None, "traceId": None, "outputRef": None, "durationMs": None,
        }
        started = time.perf_counter()
        while True:
            t0 = time.perf_counter()
            try:
                resp = await call()
            except (httpx.TimeoutException, httpx.TransportError) as e:
                err: MetaAPIError = MetaAPIError(504 if isinstance(e, httpx.TimeoutException) else 502, f"{type(e).__name__} contacting the Meta API", retryable=True)
                resp = None
            else:
                err = _map_error(resp) if resp.status_code >= 400 else None  # type: ignore[assignment]
            latency = (time.perf_counter() - t0) * 1000
            rec["attempts"] = attempt + 1
            rec["traceId"] = _trace_id(resp) or rec["traceId"]
            if err is None:
                usage.requests += 1
                usage.latency_ms_total += latency
                rec.update(success=True, status=resp.status_code, durationMs=round((time.perf_counter() - started) * 1000, 1))  # type: ignore[union-attr]
                return resp, latency, rec  # type: ignore[return-value]
            if not err.retryable or attempt >= self.max_retries:
                usage.requests += 1
                usage.errors += 1
                usage.last_error = f"{err.status} {err.code or err.type or ''}".strip()
                rec.update(status=err.status, error=usage.last_error, durationMs=round((time.perf_counter() - started) * 1000, 1))
                self._emit(rec)
                log.warning("meta call failed", extra={"model": model, "status": err.status, "code": err.code, "attempts": attempt + 1})
                raise err
            attempt += 1
            usage.retries += 1
            retry_after = None
            if resp is not None:
                try:
                    retry_after = float(resp.headers.get("retry-after", ""))
                except ValueError:
                    retry_after = None
            delay = retry_after if retry_after is not None else min(8.0, 0.5 * 2 ** (attempt - 1)) * (0.75 + random.random() * 0.5)
            log.info("meta call retry", extra={"model": model, "status": err.status, "attempt": attempt, "delay_s": round(delay, 2)})
            await self._sleep(delay)

    async def _governed(
        self, kind: str, model: str, request: Any, op: str, input_ref: str, live: Callable[[], Awaitable[tuple[Any, Any, dict[str, Any]]]], replay: Callable[[Any], Any]
    ) -> Any:
        """The one door every Meta request goes through. A cached answer is replayed as a CACHED_* execution with no network
        call; otherwise the worst-case cost is reserved against the budget while live() runs, and a success is remembered.
        live() returns (result, response to cache or None, its execution record); replay() rebuilds a result from a cached response."""
        if not self.available:
            raise MetaUnavailable()
        ticket = self.gov.begin(kind, model, request) if self.gov else None
        if ticket and ticket.hit:
            return replay(self._replayed(ticket, op, input_ref))
        with self.gov.reserve(ticket) if ticket else nullcontext():
            result, cacheable, rec = await live()
            if ticket and cacheable is not None and rec["success"]:
                self.gov.cache_put(ticket, rec["id"], cacheable)
            return result

    def _replayed(self, ticket: Ticket, op: str, input_ref: str) -> Any:
        """Records a cache hit as an execution of its own, pointing at the original, and returns the stored response."""
        orig = ticket.hit["execution"] or {}
        self._emit(
            {
                "id": f"exe_{uuid.uuid4().hex[:12]}", "model": ticket.model, "operation": op, "inputRef": input_ref, "requestAt": _now_iso(),
                "transport": orig.get("transport", self.transport_kind), "endpoint": orig.get("endpoint", self.base_url), "attempts": 0, "success": True,
                "status": orig.get("status"), "error": None, "traceId": orig.get("traceId"), "outputRef": orig.get("outputRef"), "durationMs": None,
                "costUsd": 0.0, "cachedFrom": ticket.hit["executionId"], "classification": ticket.classification,
            }
        )
        return ticket.hit["response"]

    async def chat(self, payload: dict[str, Any], *, timeout_s: float | None = None, op: str = "chat", input_ref: str = "") -> tuple[dict[str, Any], float | None]:
        """POST /chat/completions. Returns the body and latency (None for a cached answer: nothing was measured); token usage is recorded."""
        return await self._governed("chat", payload["model"], payload, op, input_ref, lambda: self._chat(payload, timeout_s, op, input_ref), lambda body: (body, None))

    async def _chat(self, payload: dict[str, Any], timeout_s: float | None, op: str, input_ref: str) -> tuple[tuple[dict[str, Any], float], dict[str, Any], dict[str, Any]]:
        model = payload["model"]
        resp, latency, rec = await self._with_retries(
            model, lambda: self._http.post("/chat/completions", json=payload, headers=self._headers(), timeout=timeout_s or self.timeout_s), op, input_ref
        )
        body = resp.json()
        u = body.get("usage") or {}
        usage = self.usage.get(model)
        usage.prompt_tokens += int(u.get("prompt_tokens") or 0)
        usage.completion_tokens += int(u.get("completion_tokens") or 0)
        msg = ((body.get("choices") or [{}])[0].get("message") or {}) if isinstance(body, dict) else {}
        calls = [str((c.get("function") or {}).get("name")) for c in msg.get("tool_calls") or []]
        rec["outputRef"] = f"completion:{body.get('id') or '?'}" + (f" tool_calls={','.join(calls)}" if calls else "")
        rec["traceId"] = rec["traceId"] or (str(body["id"])[:128] if body.get("id") else None)
        rec["tokens"] = {"prompt": int(u.get("prompt_tokens") or 0), "completion": int(u.get("completion_tokens") or 0)}
        rec["costUsd"] = round(ModelUsage(prompt_tokens=rec["tokens"]["prompt"], completion_tokens=rec["tokens"]["completion"]).cost_usd, 6)
        self._emit(rec)
        return (body, latency), body, rec

    async def responses_stream_text(
        self, payload: dict[str, Any], *, timeout_s: float | None = None, op: str = "responses", input_ref: str = ""
    ) -> tuple[str, dict[str, Any], float | None]:
        """POST /responses with stream=true and accumulate the output_text lane. Returns (text, final response, latency); latency is None for a cached answer."""
        return await self._governed(
            "responses", payload["model"], payload, op, input_ref, lambda: self._responses(payload, timeout_s, op, input_ref), lambda c: (c["text"], c["final"], None)
        )

    async def _responses(self, payload: dict[str, Any], timeout_s: float | None, op: str, input_ref: str) -> tuple[tuple[str, dict[str, Any], float], dict[str, Any] | None, dict[str, Any]]:
        model = payload["model"]

        async def call() -> httpx.Response:
            req = self._http.build_request(
                "POST", "/responses", json={**payload, "stream": True}, headers=self._headers("text/event-stream"), timeout=timeout_s or self.timeout_s
            )
            resp = await self._http.send(req, stream=True)
            if resp.status_code >= 400:
                await resp.aread()
            return resp

        resp, head_ms, rec = await self._with_retries(model, call, op, input_ref)
        t0 = time.perf_counter()
        text_parts: list[str] = []
        final: dict[str, Any] = {}
        try:
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    event = json.loads(data)
                except json.JSONDecodeError:
                    continue
                kind = event.get("type")
                if kind == "response.output_text.delta":
                    text_parts.append(event.get("delta") or "")
                elif kind in ("response.completed", "response.incomplete"):
                    final = event.get("response") or {}
                    if kind == "response.incomplete":
                        final["_incomplete"] = True
                    break
                elif kind in ("response.failed", "error"):
                    err = event.get("error") or (event.get("response") or {}).get("error") or {}
                    rec.update(success=False, status=502, error=f"stream {err.get('code') or err.get('type') or 'failed'}")
                    raise MetaAPIError(502, str(err.get("message") or "stream failed"), type_=err.get("type"), code=err.get("code"))
        except (httpx.TimeoutException, httpx.TransportError) as e:
            rec.update(success=False, status=504 if isinstance(e, httpx.TimeoutException) else 502, error=f"stream {type(e).__name__}")
            raise MetaAPIError(rec["status"], f"{type(e).__name__} reading the Meta API stream", retryable=False) from e
        finally:
            await resp.aclose()
            total = head_ms + (time.perf_counter() - t0) * 1000
            rec["durationMs"] = round(total, 1)
            text = "".join(text_parts)
            rec["outputRef"] = f"response:{final.get('id') or '?'} chars={len(text)}" + (" incomplete" if final.get("_incomplete") else "")
            rec["traceId"] = rec["traceId"] or (str(final["id"])[:128] if final.get("id") else None)
            images = _count_images(payload) if rec["success"] else 0
            rec["costUsd"] = round(ModelUsage(images=images).cost_usd, 6)
            self.usage.get(model).images += images
            self._emit(rec)
        # only a stream that ran to response.completed is a whole answer worth replaying
        return (text, final, total), ({"text": text, "final": final} if final and not final.get("_incomplete") else None), rec

    async def multipart(
        self, path: str, model: str, files: dict[str, tuple[str | None, bytes | str, str]], *, timeout_s: float | None = None, op: str = "multipart", input_ref: str = ""
    ) -> tuple[dict[str, Any], float | None]:
        return await self._governed(
            "multipart", model, {"path": path, "files": files}, op, input_ref, lambda: self._multipart(path, model, files, timeout_s, op, input_ref), lambda body: (body, None)
        )

    async def _multipart(
        self, path: str, model: str, files: dict[str, tuple[str | None, bytes | str, str]], timeout_s: float | None, op: str, input_ref: str
    ) -> tuple[tuple[dict[str, Any], float], dict[str, Any], dict[str, Any]]:
        resp, latency, rec = await self._with_retries(
            model, lambda: self._http.post(path, files=files, headers=self._headers(), timeout=timeout_s or self.timeout_s), op, input_ref
        )
        body = resp.json()
        sid = body.get("sessionId") if isinstance(body, dict) else None
        rec["outputRef"] = f"session:{sid or '?'} chars={len(str(body.get('transcript', ''))) if isinstance(body, dict) else 0}"
        rec["traceId"] = rec["traceId"] or (str(sid)[:128] if sid else None)
        audio_ms = int(body.get("audioDurationMs") or 0) if isinstance(body, dict) else 0
        self.usage.get(model).audio_ms += audio_ms
        rec["costUsd"] = round(ModelUsage(audio_ms=audio_ms).cost_usd, 6)
        self._emit(rec)
        return (body, latency), body, rec
