"""Ground-truth hallucination filtering at the replay extraction boundary."""

from __future__ import annotations

import os
import sys
from types import SimpleNamespace

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from core import event_extractor  # noqa: E402


class _NeverEvent:
    """Placeholder for tracker event types not exercised in this test."""


class _FakeUnitEvent:
    def __init__(self, *, hallucinated: bool, frame: int = 224):
        self.unit_type_name = "Phoenix"
        self.pid = 1
        self.frame = frame
        self.x = 10.0
        self.y = 20.0
        self.unit = SimpleNamespace(hallucinated=hallucinated)


class _FakeBorn(_FakeUnitEvent):
    pass


class _FakeDone(_FakeUnitEvent):
    pass


def test_extract_events_discards_explicitly_flagged_hallucinations(monkeypatch):
    monkeypatch.setattr(event_extractor, "UnitInitEvent", _NeverEvent)
    monkeypatch.setattr(event_extractor, "UnitBornEvent", _FakeBorn)
    monkeypatch.setattr(event_extractor, "UnitTypeChangeEvent", _NeverEvent)
    monkeypatch.setattr(event_extractor, "UnitDoneEvent", _FakeDone)
    monkeypatch.setattr(event_extractor, "UpgradeCompleteEvent", _NeverEvent)

    replay = SimpleNamespace(
        tracker_events=[
            _FakeBorn(hallucinated=True),
            _FakeDone(hallucinated=True, frame=448),
            _FakeBorn(hallucinated=False, frame=672),
        ],
        events=[],
        frames=2240,
        length=SimpleNamespace(seconds=100),
    )

    mine, theirs, stats = event_extractor.extract_events(replay, my_pid=1)

    assert theirs == []
    assert [(row["name"], row["time"]) for row in mine] == [("Phoenix", 30)]
    assert stats["hallucinated_units"] == 2
    assert stats["processed"] == 1


def test_extract_events_accepts_direct_hallucination_signal(monkeypatch):
    monkeypatch.setattr(event_extractor, "UnitInitEvent", _NeverEvent)
    monkeypatch.setattr(event_extractor, "UnitBornEvent", _FakeBorn)
    monkeypatch.setattr(event_extractor, "UnitTypeChangeEvent", _NeverEvent)
    monkeypatch.setattr(event_extractor, "UnitDoneEvent", _FakeDone)
    monkeypatch.setattr(event_extractor, "UpgradeCompleteEvent", _NeverEvent)

    event = _FakeBorn(hallucinated=False)
    event.hallucinated = True
    replay = SimpleNamespace(
        tracker_events=[event],
        events=[],
        frames=2240,
        length=SimpleNamespace(seconds=100),
    )

    mine, theirs, stats = event_extractor.extract_events(replay, my_pid=1)

    assert mine == []
    assert theirs == []
    assert stats["hallucinated_units"] == 1
