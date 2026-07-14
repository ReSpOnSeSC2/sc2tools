"""Replay-authored ladder selection carried separately from play race."""
from __future__ import annotations

import os
import sys
from types import SimpleNamespace


_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from core.sc2_replay_parser import _player_to_info


def test_player_to_info_keeps_random_pick_race_and_concrete_play_race():
    raw = SimpleNamespace(
        pid=1,
        name="Me",
        pick_race="Random",
        play_race="Protoss",
        result="Win",
    )

    info = _player_to_info(raw)

    assert info.race == "Protoss"
    assert info.selected_race == "Random"


def test_player_to_info_falls_back_to_play_race_without_pick_race():
    raw = SimpleNamespace(
        pid=1,
        name="Me",
        play_race="Terran",
        result="Win",
    )

    info = _player_to_info(raw)

    assert info.race == "Terran"
    assert info.selected_race == "Terran"
