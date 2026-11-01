"""Server-side Meta Model API client. https://dev.meta.ai/docs/error-handling

One place owns the key, timeouts, retries, error mapping and usage accounting. The key is held in a private attribute,
sent only as the Authorization header, and never logged, echoed or included in an exception message.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx

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
    ):
        self.__key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s
        self.max_retries = max_retries
        self.usage = usage or UsageTracker()
        self._sleep = sleep
        self._on_execution = on_execution
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
        if rec["transport"] == "MOCK_TRANSPORT":
            rec["classification"] = "MOCKED"
        else:
            rec["classification"] = "LIVE_META" if rec["success"] else "LIVE_META_FAILED"
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

    async def chat(self, payload: dict[str, Any], *, timeout_s: float | None = None, op: str = "chat", input_ref: str = "") -> tuple[dict[str, Any], float]:
        """POST /chat/completions. Returns the body and latency; token usage is recorded."""
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
        self._emit(rec)
        return body, latency

    async def responses_stream_text(
        self, payload: dict[str, Any], *, timeout_s: float | None = None, op: str = "responses", input_ref: str = ""
    ) -> tuple[str, dict[str, Any], float]:
        """POST /responses with stream=true and accumulate the output_text lane. Returns (text, final response, latency)."""
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
            self._emit(rec)
        return text, final, total

    async def multipart(
        self, path: str, model: str, files: dict[str, tuple[str | None, bytes | str, str]], *, timeout_s: float | None = None, op: str = "multipart", input_ref: str = ""
    ) -> tuple[dict[str, Any], float]:
        resp, latency, rec = await self._with_retries(
            model, lambda: self._http.post(path, files=files, headers=self._headers(), timeout=timeout_s or self.timeout_s), op, input_ref
        )
        body = resp.json()
        sid = body.get("sessionId") if isinstance(body, dict) else None
        rec["outputRef"] = f"session:{sid or '?'} chars={len(str(body.get('transcript', ''))) if isinstance(body, dict) else 0}"
        rec["traceId"] = rec["traceId"] or (str(sid)[:128] if sid else None)
        self._emit(rec)
        return body, latency
