"""Camera bookmark decoding and conservative return-observation regressions."""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from sc2tools_agent.camera_signature import (  # noqa: E402
    _CameraRecord,
    _decode_camera_records,
    _summarize_camera_records,
    extract_camera_signature,
)


def _save(frame, slot, point, user_id=0):
    return _CameraRecord("save", frame, user_id, slot, point)


def _move(frame, point, user_id=0):
    return _CameraRecord("update", frame, user_id, None, point)


def _summarize(records, active_seconds=600):
    return _summarize_camera_records(tuple(records), user_id=0, fps=20, active_seconds=active_seconds)


def test_tracks_every_protocol_camera_slot_and_preserves_first_save_order():
    order = [7, 0, 6, 1, 5, 2, 4, 3]
    records = [_save(index * 20, slot, (slot + 20, 200)) for index, slot in enumerate(order)]
    signature = _summarize(records)
    assert [row["slot"] for row in signature["slots"]] == list(range(8))
    assert signature["saveOrder"] == order
    assert signature["saves"] == 8
    assert signature["slots"][0]["firstSaveSec"] == 1
    assert signature["returns"] == 0


def test_counts_unique_exact_returns_and_their_slot_rhythm():
    records = [
        _save(10, 0, (100, 200)), _save(20, 7, (300, 400)),
        _move(30, (100, 200)), _move(34, (300, 400)),
        _move(40, (100, 200)), _move(80, (99, 200)),
        _move(120, (100, 200)),
    ]
    signature = _summarize(records)
    assert signature["events"] == 7
    assert signature["positionUpdates"] == 5
    assert signature["returns"] == 4
    assert signature["slots"][0]["returns"] == 3
    assert signature["slots"][0]["firstReturnSec"] == 1.5
    assert signature["slots"][0]["returnIntervals"] == [0, 0, 1, 0, 1, 0]
    assert signature["returnIntervals"] == [0, 2, 0, 0, 1, 0]
    assert signature["transitions"] == [{"from": 0, "to": 7, "count": 1}, {"from": 7, "to": 0, "count": 1}]
    assert "target" not in str(signature)


def test_unchanged_missing_nearby_and_ambiguous_targets_are_not_returns():
    records = [
        _save(1, 0, (100, 200)), _move(1, (100, 200)),
        _move(2, None), _move(3, (101, 200)),
        _save(4, 7, (100, 200)), _move(5, (300, 400)),
        _move(6, (100, 200)), _move(7, (100, 200)),
    ]
    signature = _summarize(records)
    # The missing-target update is still an observed camera event, but it
    # supplies no position. API validation must preserve this strict inequality.
    assert signature["events"] == 8
    assert signature["saves"] == 2
    assert signature["returns"] == 0
    assert signature["positionUpdates"] == 5
    assert signature["events"] > signature["saves"] + signature["positionUpdates"]
    assert "returnIntervals" not in signature
    assert "transitions" not in signature


def test_resaving_a_slot_replaces_location_without_changing_first_save_time():
    records = [
        _save(1, 0, (100, 200)), _save(2, 0, (300, 400)),
        _move(3, (100, 200)), _move(4, (300, 400)),
    ]
    signature = _summarize(records)
    assert signature["slots"] == [{"slot": 0, "saves": 2, "firstSaveSec": .05, "returns": 1, "firstReturnSec": .2}]
    assert signature["saveOrder"] == [0]


def test_window_phase_boundaries_and_user_attribution():
    records = [
        _save(0, 0, (100, 200)), _save(20, 1, (100, 200), user_id=1),
        _save(2400, 0, (200, 300)), _save(6000, 0, (300, 400)),
        _save(12000, 0, (400, 500)), _save(12001, 0, (500, 600)),
    ]
    signature = _summarize(records)
    assert signature["saves"] == 4
    assert [phase["saves"] for phase in signature["phases"]] == [1, 1, 2]
    short = _summarize(records, active_seconds=100)
    assert short["saves"] == 1
    assert short["phases"] == [{"startSec": 0, "endSec": 100, "saves": 1, "returns": 0}]


def test_empty_observed_stream_differs_from_unavailable_stream():
    signature = _summarize([])
    assert signature["saves"] == 0
    assert signature["slots"] == []
    assert _decode_camera_records(SimpleNamespace(), 22.4) is None
    assert extract_camera_signature(SimpleNamespace(players=[]), opponent_pid=1, fps=22.4, active_seconds=600) is None


@pytest.mark.parametrize("fps", [0, -1, float("nan"), float("inf")])
def test_invalid_clocks_do_not_create_evidence(fps):
    assert _decode_camera_records(SimpleNamespace(), fps) is None


def test_decode_failure_never_publishes_a_partial_window_and_is_cached():
    calls = []

    class BrokenReader:
        def camera_save_event(self, _):
            pass

        def camera_update_event(self, _):
            pass

        def __init__(self):
            self.EVENT_DISPATCH = {14: (None, self.camera_save_event), 49: (None, self.camera_update_event)}

        def __call__(self, raw, context):
            calls.append(raw)
            self.EVENT_DISPATCH[14][0](1, 0, {"which": 0, "target": {"x": 1, "y": 2}})
            raise ValueError("corrupt stream")

    replay = SimpleNamespace(archive=SimpleNamespace(read_file=lambda _: b"bad"),
                             _get_reader=lambda _: BrokenReader(), opt={"debug": False})
    assert _decode_camera_records(replay, 22.4) is None
    assert _decode_camera_records(replay, 22.4) is None
    assert len(calls) == 1


def test_real_replay_retains_all_saves_without_mutating_reader_or_main_events():
    sc2reader = pytest.importorskip("sc2reader")
    fixture = HERE.parent / "replay-engine" / "tests" / "fixtures" / "replays" / "warpgate_adept_tracking.SC2Replay"
    replay = sc2reader.load_replay(str(fixture), load_level=4, debug=True)
    event_ids = [id(event) for event in replay.events]
    reader = replay._get_reader("replay.game.events")
    dispatch = dict(reader.EVENT_DISPATCH)
    records = _decode_camera_records(replay, 22.4)
    assert records is not None
    assert _decode_camera_records(replay, 22.4) is records
    assert reader.EVENT_DISPATCH == dispatch
    assert [id(event) for event in replay.events] == event_ids
    assert replay.opt["debug"] is True
    saves = [record for record in records if record.kind == "save"]
    # Exact SCameraSaveEvent observations in this committed real replay.
    assert [(record.frame, record.user_id, record.slot) for record in saves] == [
        (123, 0, 1), (144, 0, 2), (148, 0, 2), (152, 0, 2), (2018, 0, 2),
        (6045, 0, 3), (6050, 0, 3), (6053, 0, 3), (7803, 0, 3), (9779, 0, 3),
    ]
    target = extract_camera_signature(replay, opponent_pid=1, fps=22.4, active_seconds=600)
    other = extract_camera_signature(replay, opponent_pid=2, fps=22.4, active_seconds=600)
    assert target["saves"] == 10
    assert target["saveOrder"] == [1, 2, 3]
    assert target["returns"] > 0
    assert other["saves"] == 0
    assert other["slots"] == []
    assert other["returns"] == 0
