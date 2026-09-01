"""Compact opponent behavior signature extraction."""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace


HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))


class ControlGroupEvent:
    def __init__(self, slot, frame, *, player_pid=2, protocol_pid=1):
        self.control_group = slot
        self.frame = frame
        # Canonical player pid must beat this deliberately misleading protocol
        # user id (which can be zero-based in real sc2reader payloads).
        self.pid = protocol_pid
        self.player = SimpleNamespace(pid=player_pid)


class SetControlGroupEvent(ControlGroupEvent):
    pass


class AddToControlGroupEvent(ControlGroupEvent):
    pass


class GetControlGroupEvent(ControlGroupEvent):
    pass


class ControlGroupUpdateEvent(ControlGroupEvent):
    def __init__(self, slot, frame, update_type, **kwargs):
        super().__init__(slot, frame, **kwargs)
        self.update_type = update_type


def _replay(events):
    return SimpleNamespace(
        events=events,
        frames=13_440,
        length=SimpleNamespace(seconds=600),
    )


def test_control_group_signature_uses_canonical_pid_and_tracks_habits():
    from sc2tools_agent.replay_pipeline import _control_group_signature

    events = [
        SetControlGroupEvent(1, 22),       # ~0.98 s
        GetControlGroupEvent(1, 45),       # ~2.01 s
        GetControlGroupEvent(1, 54),       # ~2.41 s, a double-tap
        GetControlGroupEvent(2, 67),       # transition 1 -> 2
        ControlGroupUpdateEvent(2, 80, 1),  # generic update_type=add
        # Correct protocol pid but wrong canonical player: must be ignored.
        SetControlGroupEvent(9, 90, player_pid=1, protocol_pid=2),
    ]
    signature = _control_group_signature(
        _replay(events),
        opponent_pid=2,
        game_length_sec=600,
    )

    assert signature is not None
    assert signature["events"] == 5
    slots = {row["slot"]: row for row in signature["slots"]}
    assert slots[1] == {
        "slot": 1,
        "set": 1,
        "add": 0,
        "recall": 2,
        "doubleTap": 1,
    }
    assert slots[2]["recall"] == 1
    assert slots[2]["add"] == 1
    assert signature["transitions"] == [{"from": 1, "to": 2, "count": 1}]
    assert 9 not in slots


def test_control_group_activity_uses_real_replay_length():
    from sc2tools_agent.replay_pipeline import _control_group_signature

    # sc2reader's game_length uses the legacy 16-fps clock and would report
    # 420 seconds for this five-minute LotV replay. The signature's event rate
    # must use the same real-time clock as its frame timestamps instead.
    replay = SimpleNamespace(
        events=[GetControlGroupEvent(1, 6_000)],
        frames=6_720,
        length=SimpleNamespace(seconds=300),
    )
    signature = _control_group_signature(
        replay,
        opponent_pid=2,
        game_length_sec=420,
    )

    assert signature is not None
    assert signature["activeSeconds"] == 300


def test_build_signature_keeps_discriminative_bounded_milestones():
    from sc2tools_agent.replay_pipeline import _build_milestone_signature

    lines = [
        "[0:00] Hatchery",
        "[0:12] Drone",
        "[0:50] SpawningPool",
        "[1:40] Hatchery",
        "[2:00] Zergling",
        "[2:04] Zergling",
        "[2:08] Zergling",  # third duplicate is dropped
        "[6:21] Lair",
        "[10:01] Spire",  # outside the ten-minute signature window
        "malformed",
    ]
    signature = _build_milestone_signature(lines)

    assert signature is not None
    assert signature["milestones"] == [
        {"atSec": 50, "name": "SpawningPool"},
        {"atSec": 100, "name": "Hatchery"},
        {"atSec": 120, "name": "Zergling"},
        {"atSec": 125, "name": "Zergling"},
        {"atSec": 380, "name": "Lair"},
    ]

    dense = [f"[{index // 60}:{index % 60:02d}] Tech{index}" for index in range(30)]
    assert len(_build_milestone_signature(dense)["milestones"]) == 18


def test_signature_degrades_to_whichever_evidence_family_exists():
    from sc2tools_agent.replay_pipeline import _compute_opponent_play_signature

    build_only = _compute_opponent_play_signature(
        SimpleNamespace(raw=None, length_seconds=600),
        opponent_pid=2,
        opp_build_log=["[0:49] Gateway"],
    )
    assert build_only["version"] == 1
    assert "build" in build_only
    assert "controlGroups" not in build_only

    control_only = _compute_opponent_play_signature(
        SimpleNamespace(
            raw=_replay([SetControlGroupEvent(3, 22)]),
            length_seconds=600,
        ),
        opponent_pid=2,
        opp_build_log=[],
    )
    assert "controlGroups" in control_only
    assert "build" not in control_only

    empty = _compute_opponent_play_signature(
        SimpleNamespace(raw=None, length_seconds=600),
        opponent_pid=2,
        opp_build_log=[],
    )
    assert empty is None
