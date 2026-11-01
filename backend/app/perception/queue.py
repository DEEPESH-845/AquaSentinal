"""Bounded inference queue for remote model calls: concurrency limit, per-request timeout, request deduplication,
per-mission budgets and cancellation when a mission stops."""

from __future__ import annotations

import asyncio
from collections import defaultdict
from collections.abc import Awaitable, Callable
from typing import Any


class BudgetExhausted(Exception):
    pass


class InferenceQueue:
    def __init__(self, concurrency: int, timeout_s: float):
        self._sem = asyncio.Semaphore(max(1, concurrency))
        self.timeout_s = timeout_s
        self._inflight: dict[str, asyncio.Task[Any]] = {}
        self._by_mission: dict[str, set[asyncio.Task[Any]]] = defaultdict(set)
        self._spent: dict[tuple[str, str], int] = defaultdict(int)
        self.active = 0

    def charge(self, mission_id: str, kind: str, limit: int) -> None:
        """Counts one request against a mission budget, or raises before any money is spent."""
        if self._spent[(mission_id, kind)] >= limit:
            raise BudgetExhausted(f"{kind} budget of {limit} requests for mission {mission_id} is spent")
        self._spent[(mission_id, kind)] += 1

    def spent(self, mission_id: str, kind: str) -> int:
        return self._spent[(mission_id, kind)]

    async def run(self, mission_id: str, key: str, factory: Callable[[], Awaitable[Any]]) -> Any:
        """Runs factory() under the limits. A second request with the same key while the first is in flight shares its result."""
        existing = self._inflight.get(key)
        if existing is not None:
            return await asyncio.shield(existing)
        task = asyncio.create_task(self._guarded(factory))
        self._inflight[key] = task
        self._by_mission[mission_id].add(task)
        try:
            return await task
        finally:
            self._inflight.pop(key, None)
            self._by_mission[mission_id].discard(task)

    async def _guarded(self, factory: Callable[[], Awaitable[Any]]) -> Any:
        async with self._sem:
            self.active += 1
            try:
                return await asyncio.wait_for(factory(), self.timeout_s)
            finally:
                self.active -= 1

    def cancel_mission(self, mission_id: str) -> int:
        tasks = self._by_mission.pop(mission_id, set())
        for t in tasks:
            t.cancel()
        return len(tasks)
