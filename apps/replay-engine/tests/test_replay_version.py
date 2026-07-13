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
