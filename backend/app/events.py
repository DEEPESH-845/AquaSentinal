"""Versioned event fan-out for /ws/events. Every envelope is {v, seq, type, ts, data}; a slow subscriber drops its oldest
events rather than stalling the publisher."""

from __future__ import annotations

import asyncio
import time
from typing import Any

EVENT_VERSION = 1


class EventBus:
    def __init__(self, history: int = 200, queue_size: int = 256):
        self._subs: set[asyncio.Queue[dict[str, Any]]] = set()
        self._seq = 0
        self._history: list[dict[str, Any]] = []
        self._history_len = history
        self._queue_size = queue_size

    def envelope(self, type_: str, data: Any) -> dict[str, Any]:
        self._seq += 1
        return {"v": EVENT_VERSION, "seq": self._seq, "type": type_, "ts": time.time(), "data": data}

    async def publish(self, type_: str, data: Any) -> dict[str, Any]:
        env = self.envelope(type_, data)
        self._history = [*self._history[-(self._history_len - 1) :], env]
        for q in list(self._subs):
            if q.full():
                q.get_nowait()
            q.put_nowait(env)
        return env

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(self._queue_size)
        self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        self._subs.discard(q)

    def since(self, seq: int) -> list[dict[str, Any]]:
        """Replay for a reconnecting client that remembers the last seq it saw."""
        return [e for e in self._history if e["seq"] > seq]

    @property
    def subscribers(self) -> int:
        return len(self._subs)
