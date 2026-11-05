"""Credit governor and live lock. Every Meta request is cached, budget-checked and counted here, exactly once.

Governor
    MetaClient calls `begin()` / `reserve()` / `cache_put()` for chat, responses_stream_text and multipart, so Spark, SAM,
    Voice and any later feature built on them get the three behaviours without doing anything:
    1. response cache: SQLite `meta_cache`, key = sha256(kind, model, canonical request) with image and audio bytes replaced by
       their sha256. Only successful, complete responses are stored. A hit makes no network call and is logged as its own
       execution, `CACHED_LIVE` when the original was LIVE_META and `CACHED_<original classification>` otherwise (CACHED_MOCKED
       in tests), with costUsd 0 and `cachedFrom` pointing at the original execution.
    2. budget cap: before a request leaves, its worst-case cost (existing price constants) is checked against
       AQUA_META_BUDGET_USD. Spent is the sum of costUsd over LIVE_META executions in SQLite, so it survives restarts on a
       persistent disk; in-flight requests are reserved so concurrent callers cannot overshoot together. Over budget raises
       MetaBudgetExceeded (HTTP 402, code budget_exceeded) before any transport call.
    3. saved-calls counter: one tick per Meta request avoided, by reason. The perception pipeline reports its own gate
       decisions through `record_saved()`. In memory: it restarts with the process, unlike spent.

Live lock
    When AQUA_LIVE_PASSCODE is set, a request may use Meta only if header X-Aqua-Passcode matches. The decision is per request,
    so it is made at the route boundary: routes declare `live: bool = Depends(live_access)` and pass the bool to the services,
    which take their no-key path when it is False. Nothing below the route reads the header. The passcode is kept only as a
    sha256 digest, compared with hmac.compare_digest. Only FAILED guesses are limited, so a correct passcode never uses up the
    allowance: 10 per minute per client address plus a backstop of 30 per minute across all clients (in memory; one pair of
    buckets serves POST /api/system/unlock and wrong headers on any route). The client address is the rightmost
    X-Forwarded-For entry, the hop the hosting edge appended, because the leftmost entries are whatever the caller sent.
    Behind no proxy that header is still caller-controlled, which is what the 30 per minute backstop is for.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from collections import defaultdict, deque
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

from fastapi import Request

from ..db import Repository
from .client import MetaBudgetExceeded, ModelUsage

__all__ = ["Governor", "MetaBudgetExceeded", "LiveLocked", "Ticket", "cache_key", "canonical", "live_access", "SAVED_REASONS"]

SAVED_REASONS = ("duplicate", "unusable_quality", "not_candidate", "cache_hit", "budget")

# Worst-case request sizing for the budget check (estimates, not billing): dense JSON tokenises below the usual ~4 characters
# per token, an inlined image is allowed a flat token count, a chat with no output cap may answer up to MAX_COMPLETION_TOKENS,
# and 16 kHz mono 16-bit WAV (32 kB/s) is the lowest byte rate the voice endpoint accepts, so it gives the most seconds per byte.
CHARS_PER_TOKEN = 3
MEDIA_TOKENS = 2000
MAX_COMPLETION_TOKENS = 4096
AUDIO_BYTES_PER_S = 32_000


class LiveLocked(Exception):
    """A route that only exists to call Meta was reached without the passcode. Mapped to 403 {"error": "live mode locked"}."""


# ---------------------------------------------------------------- canonical request and cache key


def canonical(obj: Any) -> tuple[str, dict[str, int]]:
    """Stable JSON of a request with media bytes replaced by their sha256, plus counts of media items and raw bytes."""
    stats = {"media": 0, "bytes": 0}

    def walk(o: Any) -> Any:
        if isinstance(o, (bytes, bytearray)):
            stats["bytes"] += len(o)
            return "bytes:sha256=" + hashlib.sha256(o).hexdigest()
        if isinstance(o, str) and o.startswith("data:") and ";base64," in o:
            head, _, b64 = o.partition(";base64,")
            try:
                raw = base64.b64decode(b64)
            except ValueError:
                raw = b64.encode()
            stats["media"] += 1
            return f"{head};sha256={hashlib.sha256(raw).hexdigest()}"
        if isinstance(o, dict):
            return {str(k): walk(v) for k, v in o.items()}
        if isinstance(o, (list, tuple)):
            return [walk(v) for v in o]
        return o

    return json.dumps(walk(obj), sort_keys=True, separators=(",", ":"), default=str), stats


def _digest(kind: str, model: str, canon: str) -> str:
    return hashlib.sha256(f"{kind}\n{model}\n{canon}".encode()).hexdigest()


def cache_key(kind: str, model: str, request: Any) -> str:
    """kind is chat, responses or multipart; request is the payload (multipart: {"path": ..., "files": ...})."""
    return _digest(kind, model, canonical(request)[0])


def _estimate_usd(kind: str, request: Any, canon: str, stats: dict[str, int]) -> float:
    if kind == "chat":
        out = int(request.get("max_completion_tokens") or request.get("max_tokens") or MAX_COMPLETION_TOKENS)
        return ModelUsage(prompt_tokens=len(canon) // CHARS_PER_TOKEN + stats["media"] * MEDIA_TOKENS, completion_tokens=out).cost_usd
    if kind == "responses":
        return ModelUsage(images=max(1, stats["media"])).cost_usd
    return ModelUsage(audio_ms=stats["bytes"] * 1000 // AUDIO_BYTES_PER_S).cost_usd


def _cached_classification(original: str | None) -> str:
    if original is None:  # the execution record was never saved, so nothing can vouch for how the answer was obtained
        return "CACHED_UNVERIFIED"
    return "CACHED_LIVE" if original == "LIVE_META" else f"CACHED_{original}"


@dataclass
class Ticket:
    """One request's key, worst-case cost and, when the cache already holds the answer, the stored hit."""

    key: str
    model: str
    estimate: float
    hit: dict[str, Any] | None = None
    classification: str = ""


# ---------------------------------------------------------------- passcode attempts


class AttemptLimiter:
    def __init__(self, limit: int = 10, window_s: float = 60.0, clock: Callable[[], float] = time.monotonic):
        self.limit, self.window_s, self._clock = limit, window_s, clock
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def _recent(self, key: str) -> deque[float]:
        q, now = self._hits[key], self._clock()
        while q and now - q[0] >= self.window_s:
            q.popleft()
        if not q:
            self._hits.pop(key, None)
        return q

    def blocked(self, key: str) -> bool:
        return len(self._recent(key)) >= self.limit

    def hit(self, key: str) -> bool:
        """Records an attempt. False, and nothing recorded, when the key is already at its limit."""
        if self.blocked(key):
            return False
        self._hits[key].append(self._clock())
        if len(self._hits) > 1000:  # drop stale keys so a spray of addresses cannot grow the table without bound
            for k in list(self._hits):
                self._recent(k)
        return True


# ---------------------------------------------------------------- the governor


class Governor:
    def __init__(self, repo: Repository, budget_usd: float, passcode: str = "", *, limiter: AttemptLimiter | None = None, backstop: AttemptLimiter | None = None):
        self.repo = repo
        self.budget_usd = budget_usd
        self.__passcode = hashlib.sha256(passcode.encode()).digest() if passcode else b""
        self._reserved = 0.0
        self._saved = dict.fromkeys(SAVED_REASONS, 0)
        self._limiter = limiter or AttemptLimiter()  # failed guesses per client address
        self._backstop = backstop or AttemptLimiter(limit=30)  # failed guesses from anyone: addresses cannot be trusted to be unique

    def __repr__(self) -> str:  # the passcode must never appear in a repr or a traceback
        return f"Governor(budget_usd={self.budget_usd}, lock_enabled={self.lock_enabled})"

    # -- budget, cache, counter

    def begin(self, kind: str, model: str, request: Any) -> Ticket:
        canon, stats = canonical(request)
        t = Ticket(_digest(kind, model, canon), model, _estimate_usd(kind, request, canon, stats))
        t.hit = self.repo.cache_get(t.key)
        if t.hit:
            t.classification = _cached_classification((t.hit["execution"] or {}).get("classification"))
            self.record_saved("cache_hit")
        return t

    @contextmanager
    def reserve(self, ticket: Ticket) -> Iterator[None]:
        """Holds the ticket's worst-case cost against the budget while its request runs, or refuses before it starts."""
        spent = self.repo.spent_usd()
        if spent + self._reserved + ticket.estimate > self.budget_usd:
            self.record_saved("budget")
            raise MetaBudgetExceeded(
                f"Meta credit budget of ${self.budget_usd:.2f} would be exceeded: ${spent:.4f} spent, this request may cost up to ${ticket.estimate:.4f}"
            )
        self._reserved += ticket.estimate
        try:
            yield
        finally:
            self._reserved = max(0.0, self._reserved - ticket.estimate)

    def cache_put(self, ticket: Ticket, execution_id: str, response: Any) -> None:
        self.repo.cache_put(ticket.key, ticket.model, execution_id, response)

    def record_saved(self, reason: str, n: int = 1) -> None:
        self._saved[reason] += n  # KeyError on a misspelt reason is intended: the shape of byReason is fixed

    def credits(self) -> dict[str, Any]:
        spent = self.repo.spent_usd()
        counts = self.repo.execution_counts()
        return {
            "budgetUsd": self.budget_usd,
            "spentUsd": round(spent, 6),
            "remainingUsd": round(max(0.0, self.budget_usd - spent), 6),
            "liveCalls": counts.get("LIVE_META", 0),
            "cachedCalls": sum(n for c, n in counts.items() if c.startswith("CACHED_")),
            "saved": {"total": sum(self._saved.values()), "byReason": dict(self._saved)},
        }

    # -- live lock

    @property
    def lock_enabled(self) -> bool:
        return bool(self.__passcode)

    def _matches(self, candidate: str) -> bool:
        return hmac.compare_digest(hashlib.sha256(candidate.encode()).digest(), self.__passcode)

    def _throttled(self, ip: str) -> bool:
        return self._limiter.blocked(ip) or self._backstop.blocked("*")

    def _failed(self, ip: str) -> None:
        self._limiter.hit(ip)
        self._backstop.hit("*")

    def access(self, candidate: str | None, ip: str) -> bool:
        """May this request use Meta? Always when no lock is set. A wrong passcode counts as a failed attempt; a right one never does."""
        if not self.lock_enabled:
            return True
        if self._throttled(ip):
            return False
        if candidate is None or candidate == "":  # no header is not a guess
            return False
        if self._matches(candidate):
            return True
        self._failed(ip)
        return False

    def unlock(self, candidate: str, ip: str) -> tuple[bool, bool]:
        """POST /api/system/unlock: (unlocked, rate_limited). Same rules as access(): only failures are counted."""
        if not self.lock_enabled:
            return True, False
        if self._throttled(ip):
            return False, True
        if self._matches(candidate):
            return True, False
        self._failed(ip)
        return False, False


def client_ip(request: Request) -> str:
    """Address to rate-limit by: the rightmost X-Forwarded-For entry (appended by the hosting edge), else the socket peer.
    request.client is not used first because uvicorn, trusting every proxy, sets it from the caller-controlled leftmost entry."""
    hops = [h.strip() for h in request.headers.get("x-forwarded-for", "").split(",") if h.strip()]
    return hops[-1] if hops else request.client.host if request.client else "unknown"


async def live_access(request: Request) -> bool:
    """FastAPI dependency: True when this request may call Meta. Async on purpose, so it runs on the event loop and the
    attempt limiter needs no lock."""
    gov: Governor = request.app.state.s.governor
    return gov.access(request.headers.get("x-aqua-passcode"), client_ip(request))
