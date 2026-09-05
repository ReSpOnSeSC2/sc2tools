"""Membership correctness; production examples are checked against a real replay."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from sc2reader.events.game import SelectionEvent, create_control_group_event

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from sc2tools_agent.group_signature import extract_group_membership_signature


def _unit(unit_id, name, *, history=None, died_at=None):
    return SimpleNamespace(id=unit_id, name="NeverUseFinalType", died_at=died_at,
                           type_history=history if history is not None else {0: SimpleNamespace(name=name)})


def _selection(frame, units, *, slot=10, mode="ZeroIndices", mask=None, pid=2):
    event = SelectionEvent(frame, 1, {"control_group_index": slot, "subgroup_index": 0,
                                    "remove_mask": (mode, mask if mask is not None else []),
                                    "add_subgroups": [], "add_unit_tags": [unit.id for unit in units]})
    event.new_units = event.objects = units
    event.player = SimpleNamespace(pid=pid)
    return event


def _group(frame, slot, action=0, *, mode="None", mask=None, pid=2):
    event = create_control_group_event(frame, 1, {"control_group_update": action, "control_group_index": slot,
                                                 "remove_mask": (mode, mask)})
    event.player = SimpleNamespace(pid=pid)
    return event


def _extract(events, *, objects=None, datapack=None):
    replay = SimpleNamespace(events=events, frames=13440, length=SimpleNamespace(seconds=600),
                             objects=objects or {}, datapack=datapack)
    return extract_group_membership_signature(replay, opponent_pid=2, game_length_sec=600)


def _slots(result):
    return {row["slot"]: row for row in result.get("unitAssignments", [])}


def test_all_ten_logical_slots_and_same_nexus_pair_retain_assignment_timing():
    nexus = _unit(987654321, "Nexus")
    events = [_selection(0, [nexus])]
    events.extend(_group(20 + index, slot) for index, slot in enumerate([3, 0, 1, 2, 4, 5, 6, 7, 8, 9]))
    result = _extract(events)
    assert set(_slots(result)) == set(range(10))
    assert result["membershipCoverage"] == {"assignments": 10, "decodedAssignments": 10, "selectionErrors": 0}
    assert _slots(result)[3]["firstAssignment"] == {"atSec": .893, "action": "set", "units": [{"name": "Nexus", "count": 1}]}
    pair = next(pair for pair in result["sharedAssignments"] if pair["slots"] == [0, 3])
    assert pair == {"slots": [0, 3], "firstAtSec": .938, "unitTypes": [{"name": "Nexus", "count": 1}]}
    assert len(result["sharedAssignments"]) == 45
    assert [row["slot"] for row in result["openingSequence"][:2]] == [3, 0]
    assert "987654321" not in json.dumps(result)


def test_same_type_on_different_units_never_fabricates_a_shared_unit():
    first, second = _unit(1, "Nexus"), _unit(2, "Nexus")
    result = _extract([_selection(0, [first]), _group(1, 3), _selection(2, [second]), _group(3, 0)])
    assert set(_slots(result)) == {0, 3}
    assert "sharedAssignments" not in result


@pytest.mark.parametrize("mode,mask,expected", [("Mask", [False, True], ["Marine", "SCV"]),
                                                ("OneIndices", [1], ["Marine", "SCV"]),
                                                ("ZeroIndices", [1], ["Nexus"])])
def test_masks_apply_to_sorted_unit_ids_with_correct_retain_and_remove_semantics(mode, mask, expected):
    units = [_unit(30, "SCV"), _unit(10, "Marine"), _unit(20, "Nexus")]
    result = _extract([_selection(0, units), _selection(1, [], mode=mode, mask=mask), _group(2, 4)])
    assert [row["name"] for row in _slots(result)[4]["firstAssignment"]["units"]] == expected
    assert result["membershipCoverage"]["selectionErrors"] == 0


def test_invalid_masks_taint_buffer_until_full_reset_and_do_not_invent_overlap():
    nexus, probe = _unit(1, "Nexus"), _unit(2, "Probe")
    events = [_selection(0, [nexus]), _group(1, 3),
              _selection(2, [], mode="OneIndices", mask=[99]), _group(3, 0),
              _selection(4, [probe], mode="None"), _group(5, 1),
              _selection(6, [probe]), _group(7, 2)]
    result = _extract(events)
    assert set(_slots(result)) == {2, 3}
    assert result["membershipCoverage"] == {"assignments": 4, "decodedAssignments": 2, "selectionErrors": 1}
    assert "sharedAssignments" not in result


def test_recall_mask_does_not_destroy_group_and_add_applies_destination_mask():
    marine, medivac, scv = _unit(1, "Marine"), _unit(2, "Medivac"), _unit(3, "SCV")
    result = _extract([_selection(0, [marine, medivac]), _group(1, 1),
                       _group(2, 1, 2, mode="OneIndices", mask=[0]), _group(3, 2),
                       _group(4, 1, 2), _group(5, 3),
                       _selection(6, [scv]), _group(7, 1, 1, mode="OneIndices", mask=[0])])
    slots = _slots(result)
    assert slots[2]["firstAssignment"]["units"] == [{"name": "Medivac", "count": 1}]
    assert slots[3]["firstAssignment"]["units"] == [{"name": "Marine", "count": 1}, {"name": "Medivac", "count": 1}]
    assert slots[1]["unitTypes"] == [{"name": "Medivac", "count": 2}, {"name": "Marine", "count": 1}, {"name": "SCV", "count": 1}]


@pytest.mark.parametrize("steal", [4, 5])
def test_steals_remove_only_selected_units_from_other_groups_before_observation(steal):
    nexus, probe = _unit(1, "Nexus"), _unit(2, "Probe")
    events = [_selection(0, [nexus, probe]), _group(1, 1),
              _selection(2, [nexus]), _group(3, 0, steal),
              _group(4, 1, 2), _group(5, 3)]
    result = _extract(events)
    assert _slots(result)[3]["firstAssignment"]["units"] == [{"name": "Probe", "count": 1}]
    assert all(row["slots"] != [0, 1] for row in result.get("sharedAssignments", []))
    assert _slots(result)[0]["assignments"] == 1
    assert _slots(result)[0]["firstAssignment"]["action"] == ("stealSet" if steal == 4 else "stealAdd")


def test_steal_add_does_not_steal_preexisting_destination_members():
    nexus, probe = _unit(1, "Nexus"), _unit(2, "Probe")
    result = _extract([_selection(0, [nexus]), _group(1, 0), _group(2, 3),
                       _selection(3, [probe]), _group(4, 2), _group(5, 0, 5),
                       _group(6, 3, 2), _group(7, 4),
                       _group(8, 2, 2), _group(9, 5)])
    assert _slots(result)[4]["firstAssignment"]["units"] == [{"name": "Nexus", "count": 1}]
    assert 5 not in _slots(result)  # group 2 was emptied by the steal
    assert not any(row["slots"] == [0, 2] for row in result["sharedAssignments"])


def test_automatic_steal_transactions_do_not_remove_units_twice_or_become_player_habits():
    from sc2tools_agent.group_signature import steal_housekeeping_event_ids

    nexus, probe, marine = _unit(1, "Nexus"), _unit(2, "Probe"), _unit(3, "Marine")
    events = [_selection(0, [nexus, probe]), _group(1, 1),
              _selection(2, [marine]), _group(3, 2),
              _selection(4, [nexus]), _group(5, 0, 4)]
    helpers = [_group(5, 1, 2), _selection(5, [], mode="OneIndices", mask=[0]),
               _group(5, 1), _selection(5, [nexus]),
               _group(5, 2, 2), _group(5, 2), _selection(5, [nexus])]
    events.extend(helpers)
    # A separate genuine recall in the same frame is still counted.
    events.extend([_group(5, 1, 2), _group(6, 3)])
    assert steal_housekeeping_event_ids(events, opponent_pid=2) == {id(event) for event in helpers}
    result = _extract(events)
    assert result["membershipCoverage"] == {"assignments": 4, "decodedAssignments": 4, "selectionErrors": 0}
    assert _slots(result)[3]["firstAssignment"]["units"] == [{"name": "Probe", "count": 1}]
    assert _slots(result)[1]["assignments"] == 1
    assert _slots(result)[2]["assignments"] == 1
    assert not any(row["action"] == "recall" and row["slot"] == 2 for row in result["openingSequence"])
    from sc2tools_agent.play_signature import extract_behavior_signature
    behavior = extract_behavior_signature(SimpleNamespace(events=events, frames=13440,
                                                          length=SimpleNamespace(seconds=600)),
                                          opponent_pid=2, game_length_sec=600)
    assert behavior["controlGroups"]["events"] == 5
    assert sum(row["recall"] for row in behavior["controlGroups"]["slots"]) == 1
    assert behavior["actions"]["selectionChanges"] == 3
    assert behavior["actions"]["events"] == 8
    assert sum(behavior["actions"]["actionIntervals"]) == 4


def test_housekeeping_recognition_requires_complete_same_frame_restore():
    from sc2tools_agent.group_signature import steal_housekeeping_event_ids

    nexus = _unit(1, "Nexus")
    events = [_group(1, 0, 4), _group(1, 1, 2), _group(1, 1), _selection(2, [nexus])]
    assert steal_housekeeping_event_ids(events, opponent_pid=2) == set()


def test_housekeeping_can_interleave_camera_observations_and_automatic_empty_group_clear():
    from sc2tools_agent.group_signature import steal_housekeeping_event_ids

    nexus = _unit(1, "Nexus")
    camera = type("CameraEvent", (), {})()
    camera.player, camera.frame = SimpleNamespace(pid=2), 2
    steal = _group(2, 0, 4)
    helpers = [_group(2, 2, 3), _group(2, 1, 2), _selection(2, [], mode="Mask", mask=[True]),
               _group(2, 1), _selection(2, [nexus])]
    events = [steal, *helpers[:4], camera, helpers[-1]]
    assert steal_housekeeping_event_ids(events, opponent_pid=2) == {id(event) for event in helpers}
    assert id(camera) not in steal_housekeeping_event_ids(events, opponent_pid=2)


def test_clear_and_automatic_group_deltas_are_applied_without_new_assignments():
    nexus, probe = _unit(1, "Nexus"), _unit(2, "Probe")
    result = _extract([_selection(0, [nexus, probe]), _group(1, 1),
                       _selection(2, [], slot=1, mode="OneIndices", mask=[0]),
                       _group(3, 1, 2), _group(4, 2),
                       _group(5, 1, 3), _group(6, 1, 2), _group(7, 3)])
    assert _slots(result)[2]["firstAssignment"]["units"] == [{"name": "Probe", "count": 1}]
    assert 3 not in _slots(result)
    assert result["membershipCoverage"]["assignments"] == 3


def test_morph_names_are_evaluated_at_assignment_frame_not_replay_end():
    building = _unit(1, "unused", history={0: SimpleNamespace(name="CommandCenter"),
                                           100: SimpleNamespace(name="OrbitalCommand")})
    result = _extract([_selection(0, [building]), _group(20, 3), _group(100, 0)])
    assert _slots(result)[3]["firstAssignment"]["units"] == [{"name": "CommandCenter", "count": 1}]
    assert _slots(result)[0]["firstAssignment"]["units"] == [{"name": "OrbitalCommand", "count": 1}]
    assert "NeverUseFinalType" not in json.dumps(result)


def test_deaths_are_filtered_from_observations_without_changing_mask_indices():
    marine, nexus = _unit(1, "Marine", died_at=5), _unit(2, "Nexus")
    result = _extract([_selection(0, [marine, nexus]), _group(1, 1), _group(6, 2),
                       _selection(7, [], mode="OneIndices", mask=[0]), _group(8, 3)])
    assert _slots(result)[2]["firstAssignment"]["units"] == [{"name": "Nexus", "count": 1}]
    assert _slots(result)[3]["firstAssignment"]["units"] == [{"name": "Nexus", "count": 1}]
    assert result["membershipCoverage"]["selectionErrors"] == 0
    assert next(row for row in result["sharedAssignments"] if row["slots"] == [1, 2])["unitTypes"] == [{"name": "Nexus", "count": 1}]


def test_unresolved_types_remain_unavailable_and_selection_metadata_can_resolve_them():
    unit = _unit(1, "unused", history={})
    selection = _selection(0, [unit])
    result = _extract([selection, _group(1, 3)])
    assert result == {"membershipCoverage": {"assignments": 1, "decodedAssignments": 0, "selectionErrors": 0}}
    selection.new_unit_info = [(1, 82, 0, 0)]
    result = _extract([selection, _group(1, 3)], datapack=SimpleNamespace(units={82: SimpleNamespace(name="Nexus")}))
    assert _slots(result)[3]["firstAssignment"]["units"] == [{"name": "Nexus", "count": 1}]


def test_unknown_control_update_invalidates_buffers_and_other_player_events_are_ignored():
    nexus, probe = _unit(1, "Nexus"), _unit(2, "Probe")
    result = _extract([_selection(0, [nexus]), _group(1, 3), _group(2, 3, 99),
                       _group(3, 0), _selection(4, [probe], pid=1), _group(5, 1),
                       _selection(6, [probe]), _group(7, 2)])
    assert set(_slots(result)) == {2, 3}
    assert result["membershipCoverage"] == {"assignments": 4, "decodedAssignments": 2, "selectionErrors": 1}


def test_opening_sequence_is_bounded_deduplicated_and_excludes_late_use():
    nexus = _unit(1, "Nexus")
    events = [_selection(0, [nexus])] + [_group(index, 3) for index in range(1, 200)]
    events += [_group(1400, 0)]  # 62.5 seconds
    result = _extract(events)
    assert len(result["openingSequence"]) == 1
    assert _slots(result)[3]["assignments"] == 199
    assert _slots(result)[0]["firstAssignment"]["atSec"] == 62.5
    assert _slots(result)[3]["unitTypes"] == [{"name": "Nexus", "count": 199}]


def test_real_replay_records_response_nexus_on_three_and_zero_and_uses_no_unit_ids():
    import sc2reader

    fixture = HERE.parent / "replay-engine/tests/fixtures/replays/warpgate_adept_tracking.SC2Replay"
    replay = sc2reader.load_replay(str(fixture), load_level=4)
    player = next(player for player in replay.players if player.name == "ReSpOnSe")
    result = extract_group_membership_signature(replay, opponent_pid=player.pid, game_length_sec=999)
    slots = _slots(result)
    for slot in (0, 3):
        assert slots[slot]["firstAssignment"]["units"] == [{"name": "Nexus", "count": 1}]
    assert slots[3]["firstAssignment"]["atSec"] < slots[0]["firstAssignment"]["atSec"] < 4
    assert next(row for row in result["sharedAssignments"] if row["slots"] == [0, 3])["unitTypes"] == [{"name": "Nexus", "count": 1}]
    assert result["membershipCoverage"] == {"assignments": 40, "decodedAssignments": 40, "selectionErrors": 0}
    serialized = json.dumps(result)
    assert all(str(unit_id) not in serialized for unit_id in replay.objects if unit_id > 100000)
    assert len(serialized) < 12000
