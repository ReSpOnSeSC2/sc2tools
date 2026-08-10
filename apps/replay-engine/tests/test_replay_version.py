"""Replay header version/build propagation.

The ladder-meta service needs exact replay provenance; a replay date is
only a fallback because games created around a patch rollout can be on
either client build. These tests lock the sc2reader header values onto
``ReplayContext`` before the desktop agent serialises them.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from core import sc2_replay_parser as parser


def _raw_replay(**overrides):
    values = {
        "map_name": "Goldenaura",
        "date": datetime(2026, 7, 1, tzinfo=timezone.utc),
        "start_time": datetime(2026, 7, 1, 11, 50, tzinfo=timezone.utc),
        "game_length": timedelta(minutes=10),
        "players": [],
        "release_string": "5.0.16.97425",
        "build": 97425,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_parse_replay_carries_exact_normalized_version_and_build(monkeypatch):
    raw = _raw_replay(release_string=" 05.0.016.097425 ")
    monkeypatch.setattr(parser, "_load_replay", lambda _path, _level: raw)

    ctx = parser.parse_replay("example.SC2Replay", "Me", depth="live")

    assert ctx.game_version == "5.0.16.97425"
    assert ctx.game_build == 97425


def test_parse_replay_carries_exact_start_time(monkeypatch):
    raw = _raw_replay(
        start_time=datetime(2026, 7, 1, 11, 49, 58, tzinfo=timezone.utc),
    )
    monkeypatch.setattr(parser, "_load_replay", lambda _path, _level: raw)

    ctx = parser.parse_replay("example.SC2Replay", "Me", depth="live")

    assert ctx.started_at_iso == "2026-07-01T11:49:58+00:00"


def test_parse_replay_leaves_start_time_optional(monkeypatch):
    raw = _raw_replay(start_time=None)
    monkeypatch.setattr(parser, "_load_replay", lambda _path, _level: raw)

    ctx = parser.parse_replay("legacy.SC2Replay", "Me", depth="live")

    assert ctx.started_at_iso is None


def test_parse_replay_exposes_resumed_replay_marker(monkeypatch):
    raw = _raw_replay(resume_from_replay=True)
    monkeypatch.setattr(parser, "_load_replay", lambda _path, _level: raw)

    # The marker is a game event, so production discovers it on the deep
    # (load-level 4) import path rather than the metadata-only live path.
    ctx = parser.parse_replay("resumed.SC2Replay", "Me", depth="deep")

    assert ctx.is_resumed_from_replay is True


def test_old_resumed_replay_retries_without_tracker_events(monkeypatch):
    calls = []
    recovered = object()

    def fake_load(_path, *, load_level, **options):
        calls.append((load_level, options))
        if options.get("do_tracker_events") is False:
            return recovered
        raise parser.CorruptTrackerFileError("old resumed replay")

    monkeypatch.setattr(parser.sc2reader, "load_replay", fake_load)

    assert parser._load_replay("old-resumed.SC2Replay", 4) is recovered
    assert calls == [
        (4, {}),
        (4, {"do_tracker_events": False}),
    ]


def test_old_resumed_replay_never_falls_back_without_resume_marker(monkeypatch):
    calls = []

    def fake_load(_path, *, load_level, **options):
        calls.append((load_level, options))
        if options.get("do_tracker_events") is False:
            raise RuntimeError("compatibility retry failed")
        raise parser.CorruptTrackerFileError("old resumed replay")

    monkeypatch.setattr(parser.sc2reader, "load_replay", fake_load)

    with pytest.raises(RuntimeError, match="compatibility retry failed"):
        parser._load_replay("old-resumed.SC2Replay", 4)

    assert calls == [
        (4, {}),
        (4, {"do_tracker_events": False}),
    ]


@pytest.mark.parametrize(
    ("release_string", "build"),
    [
        ("5.0.16", 0),
        ("5.0.16-beta.97425", -1),
        (None, None),
        (97425, True),
    ],
)
def test_parse_replay_omits_malformed_version_and_build(
    monkeypatch, release_string, build,
):
    raw = _raw_replay(release_string=release_string, build=build)
    monkeypatch.setattr(parser, "_load_replay", lambda _path, _level: raw)

    ctx = parser.parse_replay("example.SC2Replay", "Me", depth="live")

    assert ctx.game_version is None
    assert ctx.game_build is None
