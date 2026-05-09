"""Unit tests for ``sc2tools_agent.live.event_bus``."""

from __future__ import annotations

import threading

from sc2tools_agent.live.event_bus import EventBus


def test_publish_fans_out_to_every_subscriber() -> None:
    bus: EventBus[str] = EventBus()
    a, b = [], []
    bus.subscribe(a.append)
    bus.subscribe(b.append)
    bus.publish("hello")
    assert a == ["hello"]
    assert b == ["hello"]


def test_unsubscribe_removes_callback() -> None:
    bus: EventBus[str] = EventBus()
    seen: list[str] = []
    unsub = bus.subscribe(seen.append)
    bus.publish("first")
    unsub()
    bus.publish("second")
    assert seen == ["first"]


def test_failing_subscriber_does_not_block_others() -> None:
    bus: EventBus[int] = EventBus()
    seen: list[int] = []

    def broken(_: int) -> None:
        raise RuntimeError("boom")

    bus.subscribe(broken)
    bus.subscribe(seen.append)
    bus.publish(42)
    assert seen == [42]


def test_subscriber_count_tracks_registrations() -> None:
    bus: EventBus[int] = EventBus()
    assert bus.subscriber_count == 0
    unsub_a = bus.subscribe(lambda _: None)
    unsub_b = bus.subscribe(lambda _: None)
    assert bus.subscriber_count == 2
    unsub_a()
    assert bus.subscriber_count == 1
    bus.clear()
    assert bus.subscriber_count == 0
    # idempotent unsub.
    unsub_b()


def test_concurrent_subscribe_during_publish_does_not_crash() -> None:
    """The bus snapshots subscribers under its lock before fan-out, so
    a subscriber adding another subscriber mid-publish must NOT mutate
    the iteration in flight."""
    bus: EventBus[int] = EventBus()
    seen: list[int] = []

    def first(value: int) -> None:
        seen.append(value)
        # Subscribing during publish was the historical bug — assert
        # the new subscriber is added without a ConcurrentMutation
        # raising back into ``publish``.
        bus.subscribe(seen.append)

    bus.subscribe(first)
    bus.publish(1)
    # The newly-added subscriber missed event 1 (snapshot semantics)
    # but receives event 2.
    bus.publish(2)
    assert 1 in seen
    assert seen.count(2) >= 2


def test_thread_safety_smoke() -> None:
    """Many concurrent publishers + subscribers — no exceptions, no
    lost events. We're not asserting specific orderings (that would
    be racy); just that the bus survives the load."""
    bus: EventBus[int] = EventBus()
    received: list[int] = []
    lock = threading.Lock()

    def collect(value: int) -> None:
        with lock:
            received.append(value)

    for _ in range(5):
        bus.subscribe(collect)

    def publish_many(start: int) -> None:
        for i in range(50):
            bus.publish(start * 100 + i)

    threads = [
        threading.Thread(target=publish_many, args=(i,))
        for i in range(4)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    # 4 publishers × 50 events × 5 subscribers = 1000 deliveries.
    assert len(received) == 1000
