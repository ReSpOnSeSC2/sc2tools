"""League extraction for the cloud's ``opponent.leagueId`` banding.

``core.sc2_replay_parser`` reads sc2reader's ``highest_league`` (the
replay initData enum: 1=Bronze .. 7=Grandmaster, 0/8 = no current
1v1 ranking) and normalizes it onto the ladder enum the rest of the
system uses (0=Bronze .. 6=Grandmaster, matching SC2Pulse and the
cloud's LEAGUE_NAMES tables).

This is the field the Ladder Meta Radar and the league-percentile
benchmarks band the whole games corpus on. Before it existed, uploads
never carried a league, every (league, matchup) bucket stayed below
its k-anonymity floor, and the /meta page showed "Not enough games
yet" no matter how many replays users synced — that regression is what
this file locks down.

Module: tests
"""
from __future__ import annotations

import os
import sys
from types import SimpleNamespace

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from core.sc2_replay_parser import _get_player_league_id, _player_to_info


@pytest.mark.parametrize(
    ("highest_league", "expected"),
    [
        (1, 0),  # Bronze
        (2, 1),  # Silver
        (3, 2),  # Gold
        (4, 3),  # Platinum
        (5, 4),  # Diamond
        (6, 5),  # Master
        (7, 6),  # Grandmaster
    ],
)
def test_maps_replay_enum_to_ladder_enum(highest_league, expected):
    p = SimpleNamespace(highest_league=highest_league)
    assert _get_player_league_id(p) == expected


@pytest.mark.parametrize(
    "highest_league",
    [
        0,      # replay says "no ranking"
        8,      # replay says "no current-season 1v1 ranking"
        -1,     # corrupt
        99,     # corrupt
        None,   # sc2reader parsed no initData league for this slot
        "7",    # wrong type — never coerce strings
        True,   # bool is an int subclass; must not band as Silver
    ],
)
def test_rejects_unranked_and_garbage(highest_league):
    p = SimpleNamespace(highest_league=highest_league)
    assert _get_player_league_id(p) is None


def test_returns_none_when_attribute_absent():
    # AI players / observers have no init_data-backed league at all.
    assert _get_player_league_id(SimpleNamespace()) is None


def test_player_to_info_carries_league_id():
    """The PlayerInfo wrapper must surface the league.

    The agent's upload path reads ``opp.league_id`` off this wrapper
    (apps/agent replay_pipeline.py). It used to read a field that was
    never populated — the getattr silently returned None for every
    replay and no upload ever carried ``opponent.leagueId``.
    """
    raw = SimpleNamespace(
        pid=2,
        name="Opp",
        play_race="Zerg",
        result="Loss",
        toon_handle="1-S2-2-690921",
        scaled_rating=5187,
        highest_league=7,  # Grandmaster in the replay's enum
        is_human=True,
        is_observer=False,
    )
    info = _player_to_info(raw)
    assert info.league_id == 6  # Grandmaster on the ladder enum
    assert info.mmr == 5187


def test_player_to_info_reads_sc2reader_1_8_init_data_mmr():
    """Pinned sc2reader keeps scaled_rating inside ``init_data``.

    Its Participant does not expose a top-level ``scaled_rating``
    attribute, so a top-level-only fixture gives false confidence while
    every real replay upload loses both players' MMR.
    """
    raw = SimpleNamespace(
        pid=1,
        name="Me",
        play_race="Protoss",
        result="Win",
        toon_handle="1-S2-1-267727",
        init_data={"scaled_rating": 5326},
        highest_league=6,
        is_human=True,
        is_observer=False,
    )

    assert _player_to_info(raw).mmr == 5326


@pytest.mark.parametrize("scaled_rating", [True, 499, 10000, "5326"])
def test_player_to_info_rejects_invalid_nested_mmr(scaled_rating):
    raw = SimpleNamespace(
        pid=1,
        name="Me",
        play_race="Protoss",
        result="Win",
        toon_handle="1-S2-1-267727",
        init_data={"scaled_rating": scaled_rating},
        is_human=True,
        is_observer=False,
    )

    assert _player_to_info(raw).mmr is None


def test_player_to_info_league_id_defaults_to_none():
    raw = SimpleNamespace(
        pid=1,
        name="Me",
        play_race="Protoss",
        result="Win",
        toon_handle="1-S2-1-267727",
        is_human=True,
        is_observer=False,
    )
    assert _player_to_info(raw).league_id is None
