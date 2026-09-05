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
        "stealSet": 0,
        "stealAdd": 0,
        "clear": 0,
        "firstUseSec": 1,
        "recallIntervals": [0, 0, 1, 0, 0, 0],
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
    assert build_only["version"] == 3
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


def test_corrupt_behavior_stream_does_not_lose_valid_build_evidence(caplog):
    from sc2tools_agent.replay_pipeline import _compute_opponent_play_signature

    signature = _compute_opponent_play_signature(
        SimpleNamespace(raw=SimpleNamespace(events=42), length_seconds=600),
        opponent_pid=2, opp_build_log=["[0:50] Gateway"],
    )
    assert signature == {"version": 3, "windowSec": 600,
                         "build": {"milestones": [{"atSec": 50, "name": "Gateway"}]}}
    assert "play_signature_behavior_failed" in caplog.text


def _event(name, second, **values):
    event = type(name, (), {})()
    event.player = SimpleNamespace(pid=2)
    event.pid = 1
    event.frame = second * 22.4
    for key, value in values.items():
        setattr(event, key, value)
    return event


def _command(second, *, ability="TrainMarine", ability_id=100, queued=False):
    return _event("BasicCommandEvent", second, ability_name=ability,
                  ability_id=ability_id, ability_type="None", flag={"queued": queued})


def test_steal_semantics_take_precedence_over_subclass_and_clear_is_not_a_keypress():
    from sc2reader.events.game import create_control_group_event
    from sc2tools_agent.play_signature import extract_behavior_signature

    events = []
    for update, second in [(4, 1), (5, 2), (3, 3), (2, 4)]:
        event = create_control_group_event(round(second * 22.4), 1, {
            "control_group_update": update, "control_group_index": 3,
            "remove_mask": ("None", None),
        })
        event.player = SimpleNamespace(pid=2)
        events.append(event)
    # 1.9 puts a steal in a Set subclass while 1.8 uses a generic event.
    class ModernSetControlGroupEvent(SetControlGroupEvent):
        update_type = 4
    events.append(ModernSetControlGroupEvent(3, 112))
    events.append(_command(5.1))
    result = extract_behavior_signature(_replay(events), opponent_pid=2, game_length_sec=600)
    group = result["controlGroups"]["slots"][0]
    assert (group["set"], group["stealSet"], group["add"], group["stealAdd"], group["clear"], group["recall"]) == (2, 2, 1, 1, 1, 1)
    assert result["controlGroups"]["events"] == 5
    assert result["actions"]["events"] == 5  # four intentional group events + command
    assert sum(result["actions"]["actionIntervals"]) == 4
    assert "commandFollowup" not in result["controlGroups"]  # set invalidated recall


def test_observed_phases_clip_to_real_coverage_and_timing_histograms_have_fixed_bins():
    from sc2tools_agent.play_signature import extract_behavior_signature

    times = [1, 1.15, 1.50, 2.15, 3.65, 7.65, 12.65, 120, 299, 300, 308]
    events = [_event("GetControlGroupEvent", second, control_group=4) for second in times]
    replay = SimpleNamespace(events=events, frames=22.4 * 310, length=SimpleNamespace(seconds=310))
    group = extract_behavior_signature(replay, opponent_pid=2, game_length_sec=434)["controlGroups"]
    assert group["activeSeconds"] == 310
    assert [(row["startSec"], row["endSec"], row["events"]) for row in group["phases"]] == [(0, 120, 7), (120, 300, 2), (300, 310, 2)]
    assert group["recallIntervals"] == [1, 1, 1, 2, 1, 4]
    assert group["slots"][0]["recallIntervals"] == group["recallIntervals"]


def test_group_purpose_uses_only_next_uninterrupted_decoded_command():
    from sc2tools_agent.play_signature import extract_behavior_signature

    events = [
        _event("GetControlGroupEvent", 1, control_group=4),
        _command(1.1, queued=True), _command(1.2),  # only first is attributed
        _event("GetControlGroupEvent", 2, control_group=4),
        _event("SelectionEvent", 2.1, control_group=10), _command(2.2),
        _event("GetControlGroupEvent", 3, control_group=4),
        _event("UpdateTargetPointCommandEvent", 3.1), _command(3.2),
        _event("GetControlGroupEvent", 4, control_group=4),
        _command(6.1),  # outside two-second association window
        _event("GetControlGroupEvent", 7, control_group=7),
        _event("CameraEvent", 7.05), _command(7.1, ability="TrainQueen"),
        _event("CommandManagerStateEvent", 7.2),
        _event("CameraEvent", 8),
        _event("SelectionEvent", 9, control_group=3),  # automatic group-buffer delta
    ]
    result = extract_behavior_signature(_replay(events), opponent_pid=2, game_length_sec=600)
    assert result["controlGroups"]["commandFollowup"] == [
        {"slot": 4, "commands": 1, "queued": 1, "rapidRepeat": 0, "abilities": [{"name": "TrainMarine", "count": 1}]},
        {"slot": 7, "commands": 1, "queued": 0, "rapidRepeat": 0, "abilities": [{"name": "TrainQueen", "count": 1}]},
    ]
    actions = result["actions"]
    assert (actions["commands"], actions["repeatCommands"], actions["queuedCommands"], actions["selectionChanges"], actions["cameraMoves"]) == (7, 1, 1, 1, 2)
    assert actions["targetCommands"] == {"none": 6, "point": 0, "unit": 0, "data": 0}
    assert actions["abilityUsage"] == [{"name": "TrainMarine", "count": 5}, {"name": "TrainQueen", "count": 1}]
    assert sum(actions["cameraIntervals"]) == 1


def test_unknown_or_corrupt_data_does_not_invent_zero_evidence_or_player_ownership():
    from sc2reader.events.game import GetControlGroupEvent as RealRecall
    from sc2tools_agent.play_signature import extract_behavior_signature

    unowned = RealRecall(22, 2, {"control_group_update": 2, "control_group_index": 4, "remove_mask": ("None", None)})
    events = [unowned, ControlGroupUpdateEvent(3, 22, 9),
              GetControlGroupEvent(4, float("nan")), GetControlGroupEvent(4, float("inf")),
              GetControlGroupEvent(10, 100), GetControlGroupEvent(1, -22),
              GetControlGroupEvent(3, 15000)]
    assert extract_behavior_signature(_replay(events), opponent_pid=2, game_length_sec=600) == {}
    result = extract_behavior_signature(_replay([GetControlGroupEvent(4, 22)]), opponent_pid=2, game_length_sec=600)
    assert "actions" not in result
    assert "recallIntervals" not in result["controlGroups"]
    assert "commandFollowup" not in result["controlGroups"]


def test_double_tap_requires_uninterrupted_recalls_and_transitions_do_not_bridge_idle_gaps():
    from sc2tools_agent.play_signature import extract_behavior_signature

    events = [
        _event("GetControlGroupEvent", 1, control_group=1),
        _command(1.1),
        _event("GetControlGroupEvent", 1.2, control_group=1),
        _event("SelectionEvent", 1.3, control_group=10),
        _event("GetControlGroupEvent", 1.4, control_group=1),
        _event("CameraEvent", 1.5),
        _event("GetControlGroupEvent", 1.6, control_group=1),
        _event("GetControlGroupEvent", 30, control_group=2),
    ]
    group = extract_behavior_signature(_replay(events), opponent_pid=2, game_length_sec=600)["controlGroups"]
    assert group["slots"][0]["doubleTap"] == 1
    assert "transitions" not in group


def test_dense_signatures_remain_bounded_and_deterministic():
    import json
    from sc2tools_agent.play_signature import extract_behavior_signature

    events = []
    for index in range(1200):
        sec = index * .2
        events.extend([_event("GetControlGroupEvent", sec, control_group=index % 10),
                       _command(sec + .1, ability=f"Ability{index % 80}", ability_id=index % 80)])
    result = extract_behavior_signature(_replay(events), opponent_pid=2, game_length_sec=600)
    assert result == extract_behavior_signature(_replay(events), opponent_pid=2, game_length_sec=600)
    control = result["controlGroups"]
    assert len(control["slots"]) == 10
    assert len(control["transitions"]) <= 12
    assert len(control["commandFollowup"]) == 10
    assert all(len(row["abilities"]) <= 6 for row in control["commandFollowup"])
    assert len(result["actions"]["abilityUsage"]) == 12
    assert len(json.dumps(result)) < 18000


def test_saturated_count_family_is_omitted_instead_of_fabricating_clipped_totals():
    from sc2tools_agent.play_signature import extract_behavior_signature

    events = [_event("GetControlGroupEvent", 1, control_group=4)] * 10000 + [_command(2)]
    result = extract_behavior_signature(_replay(events), opponent_pid=2, game_length_sec=600)
    assert "controlGroups" not in result
    assert result["actions"]["events"] == 10001
    assert result["actions"]["commands"] == 1

    events = [_event("GetControlGroupEvent", 1, control_group=4)] + [_command(2)] * 100000
    result = extract_behavior_signature(_replay(events), opponent_pid=2, game_length_sec=600)
    assert "actions" not in result
    assert result["controlGroups"]["events"] == 1


def test_real_replay_signature_agrees_with_decoded_event_counts():
    from collections import Counter
    import sc2reader
    from sc2tools_agent.play_signature import extract_behavior_signature

    fixture = HERE.parent / "replay-engine/tests/fixtures/replays/warpgate_adept_tracking.SC2Replay"
    replay = sc2reader.load_replay(str(fixture), load_level=4)
    for player in replay.players:
        signature = extract_behavior_signature(replay, opponent_pid=player.pid, game_length_sec=999)
        observed = [event for event in replay.events if getattr(event, "player", None) is player]
        counts = Counter(type(event).__name__ for event in observed)
        assert signature["controlGroups"]["events"] == sum(counts[name] for name in ("SetControlGroupEvent", "AddToControlGroupEvent", "GetControlGroupEvent", "ControlGroupEvent"))
        assert signature["actions"]["commands"] == sum(counts[name] for name in ("BasicCommandEvent", "TargetPointCommandEvent", "TargetUnitCommandEvent", "DataCommandEvent", "CommandManagerStateEvent"))
        assert signature["actions"]["cameraMoves"] == counts["CameraEvent"]
        assert signature["actions"]["repeatCommands"] == counts["CommandManagerStateEvent"]
        assert signature["controlGroups"]["activeSeconds"] == 470
        assert signature["controlGroups"]["phases"][-1]["endSec"] == 470
        assert signature["controlGroups"]["commandFollowup"]
        assert signature["actions"]["abilityUsage"]
