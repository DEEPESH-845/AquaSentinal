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
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
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
    ):
        self.__key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s
        self.max_retries = max_retries
        self.usage = usage or UsageTracker()
        self._sleep = sleep
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

    async def _with_retries(self, model: str, call: Callable[[], Awaitable[httpx.Response]]) -> tuple[httpx.Response, float]:
        if not self.available:
            raise MetaUnavailable()
        usage = self.usage.get(model)
        attempt = 0
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
            if err is None:
                usage.requests += 1
                usage.latency_ms_total += latency
                return resp, latency  # type: ignore[return-value]
            if not err.retryable or attempt >= self.max_retries:
                usage.requests += 1
                usage.errors += 1
                usage.last_error = f"{err.status} {err.code or err.type or ''}".strip()
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

    async def chat(self, payload: dict[str, Any], *, timeout_s: float | None = None) -> tuple[dict[str, Any], float]:
        """POST /chat/completions. Returns the body and latency; token usage is recorded."""
        model = payload["model"]
        resp, latency = await self._with_retries(
            model, lambda: self._http.post("/chat/completions", json=payload, headers=self._headers(), timeout=timeout_s or self.timeout_s)
        )
        body = resp.json()
        u = body.get("usage") or {}
        usage = self.usage.get(model)
        usage.prompt_tokens += int(u.get("prompt_tokens") or 0)
        usage.completion_tokens += int(u.get("completion_tokens") or 0)
        return body, latency

    async def responses_stream_text(self, payload: dict[str, Any], *, timeout_s: float | None = None) -> tuple[str, dict[str, Any], float]:
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

        resp, head_ms = await self._with_retries(model, call)
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
                    raise MetaAPIError(502, str(err.get("message") or "stream failed"), type_=err.get("type"), code=err.get("code"))
        finally:
            await resp.aclose()
        return "".join(text_parts), final, head_ms + (time.perf_counter() - t0) * 1000

    async def multipart(self, path: str, model: str, files: dict[str, tuple[str | None, bytes | str, str]], *, timeout_s: float | None = None) -> tuple[dict[str, Any], float]:
        resp, latency = await self._with_retries(
            model, lambda: self._http.post(path, files=files, headers=self._headers(), timeout=timeout_s or self.timeout_s)
        )
        return resp.json(), latency
