"""Tiny in-process pub/sub used by the Live Game Bridge.

Why custom (vs. e.g. ``asyncio.Queue`` or ``blinker``):

* The agent is threaded, not asyncio. The watcher / uploader /
  heartbeat / poller / bridge all run on dedicated daemon threads —
  we don't want to introduce an event loop and force every callsite
  into ``asyncio.run_coroutine_threadsafe`` shenanigans.
* ``blinker`` would work but adds a new dependency for ~30 lines of
  code we can write ourselves with stdlib threading primitives.
* ``queue.Queue`` doesn't fan-out — every subscriber needs its own
  queue. The poller emits one event; the bridge AND the metrics
  collector both want it. A simple subscriber-list pattern is the
  minimum viable shape.

Subscribers are called inline on the publisher's thread. Each callback
is wrapped in a try/except so a misbehaving subscriber can't kill the
poller. Subscribers that need to do real work (e.g. an HTTP POST)
should hand the event off to their own queue/thread; the bus is for
fan-out, not work.
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Callable, Generic, List, TypeVar

T = TypeVar("T")

_log = logging.getLogger("sc2tools_agent.live.event_bus")


class EventBus(Generic[T]):
    """Multi-subscriber, single-publisher fan-out.

    Type-parameterised so callers can declare ``EventBus[LiveLifecycleEvent]``
    and get autocomplete on ``publish`` / subscriber callbacks.
    """

    def __init__(self) -> None:
        self._subs: List[Callable[[T], Any]] = []
        self._lock = threading.RLock()

    def subscribe(self, callback: Callable[[T], Any]) -> Callable[[], None]:
        """Register a subscriber. Returns an ``unsubscribe`` fn."""
        with self._lock:
            self._subs.append(callback)

        def _unsubscribe() -> None:
            with self._lock:
                try:
                    self._subs.remove(callback)
                except ValueError:
                    pass

        return _unsubscribe

    def publish(self, event: T) -> None:
        """Fan out ``event`` to every subscriber.

        Callbacks fire on the publisher's thread. Each is isolated by
        try/except so one slow/crashing subscriber can't take down the
        publisher's loop. Failures are logged at DEBUG to avoid
        spamming agent.log when an unrelated subsystem (e.g. metrics
        with a transient counter init) is in a bad state.
        """
        # Snapshot subscribers under the lock so a concurrent
        # subscribe/unsubscribe during fan-out doesn't mutate the list
        # we're iterating.
        with self._lock:
            subs = list(self._subs)
        for cb in subs:
            try:
                cb(event)
            except Exception:  # noqa: BLE001
                _log.debug(
                    "event_bus_subscriber_failed callback=%s",
                    getattr(cb, "__qualname__", repr(cb)),
                    exc_info=True,
                )

    def clear(self) -> None:
        """Drop every subscriber. Used by tests."""
        with self._lock:
            self._subs.clear()

    @property
    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._subs)


__all__ = ["EventBus"]
