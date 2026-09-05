"""Camera bookmarks observed in replay data, without guessing physical keys.

The pinned sc2reader parser decodes camera saves but discards their events,
and drops optional camera-update metadata. A private copy of its versioned
dispatch recovers only those records. No global reader or replay events change.

A save exposes an exact logical slot (0..7). Camera updates do not expose a
recall slot: a return below only means the camera moved to one uniquely saved
coordinate. A group double-tap, minimap click, or other action can also do that.
Positions stay local and are never included in the uploaded signature.
"""

from __future__ import annotations

import copy
import logging
import math
from collections import Counter
from dataclasses import dataclass
from typing import Any

from .play_signature import PHASES, WINDOW_SEC, _histogram_add

log = logging.getLogger(__name__)
_CACHE_ATTRIBUTE = "_sc2tools_camera_signature_events"


@dataclass(frozen=True, slots=True)
class _CameraRecord:
    kind: str
    frame: int
    user_id: int
    slot: int | None
    target: tuple[int, int] | None


class _WindowComplete(Exception):
    """Stop the private decoder after the observation window."""


def _integer(value: Any, lower: int, upper: int) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and lower <= value <= upper else None


def _target(data: Any) -> tuple[int, int] | None:
    if not isinstance(data, dict):
        return None
    x, y = _integer(data.get("x"), 0, 65535), _integer(data.get("y"), 0, 65535)
    return (x, y) if x is not None and y is not None else None


def _decode_camera_records(replay: Any, fps: float) -> tuple[_CameraRecord, ...] | None:
    """Decode once per replay object; None means unavailable, () means empty.

    The game parser still consumes preceding non-camera event payloads to
    preserve bit alignment, but never constructs their event objects. Replay
    engine processing and the existing event list remain untouched. Only a
    successfully parsed window is cached as evidence. Decode failures cache
    an unavailable marker instead, never a partial history.
    """
    if not math.isfinite(fps) or fps <= 0:
        return None
    max_frame = math.floor(WINDOW_SEC * fps)
    cached = getattr(replay, _CACHE_ATTRIBUTE, None)
    if isinstance(cached, tuple) and len(cached) == 2 and cached[0] == max_frame:
        return cached[1]
    if getattr(replay, "archive", None) is None or not callable(getattr(replay, "_get_reader", None)):
        return None
    records: list[_CameraRecord] = []
    try:
        reader = copy.copy(replay._get_reader("replay.game.events"))
        original = reader.EVENT_DISPATCH
        if 14 not in original or getattr(original[14][1], "__name__", "") != "camera_save_event":
            return None
        if 49 not in original or getattr(original[49][1], "__name__", "") != "camera_update_event":
            return None
        reader.EVENT_DISPATCH = {code: (None, parser) for code, (_, parser) in original.items()}

        def collect(kind: str):
            def event_factory(frame: int, user_id: int, data: dict) -> _CameraRecord:
                if frame > max_frame:
                    raise _WindowComplete()
                slot = _integer(data.get("which"), 0, 7) if kind == "save" else None
                record = _CameraRecord(kind, frame, user_id, slot, _target(data.get("target")))
                records.append(record)
                return record
            return event_factory

        reader.EVENT_DISPATCH[14] = (collect("save"), original[14][1])
        reader.EVENT_DISPATCH[49] = (collect("update"), original[49][1])
        raw = replay.archive.read_file("replay.game.events")
        if raw is None:
            return None
        # Debug mode attaches byte slices to each event. These records are
        # immutable and need no slices; use a local options copy, not a global
        # setting or mutation of the caller's replay options.
        context = copy.copy(replay)
        context.opt = {**replay.opt, "debug": False}
        try:
            reader(raw, context)
        except _WindowComplete:
            pass
        result = tuple(records)
    except Exception as exc:
        log.warning("play_signature_camera_decode_failed: %s", exc)
        result = None
    try:
        setattr(replay, _CACHE_ATTRIBUTE, (max_frame, result))
    except (AttributeError, TypeError):
        pass
    return result


def _summarize_camera_records(
    records: tuple[_CameraRecord, ...], *, user_id: int, fps: float, active_seconds: int
) -> dict | None:
    slots: dict[int, dict] = {}
    positions: dict[int, tuple[int, int]] = {}
    phases = [{"startSec": start, "endSec": min(end, active_seconds), "saves": 0, "returns": 0}
              for start, end in PHASES if start < active_seconds]
    result: dict = {"activeSeconds": active_seconds, "events": 0, "saves": 0, "positionUpdates": 0,
                   "returns": 0, "slots": [], "saveOrder": [], "phases": phases}
    last_position = None
    last_return: tuple[int, float] | None = None
    last_slot_return: dict[int, float] = {}
    return_intervals = [0] * 6
    transitions: Counter = Counter()
    for record in records:
        if record.user_id != user_id:
            continue
        seconds = record.frame / fps
        if seconds < 0 or seconds > active_seconds:
            continue
        phase_index = min(0 if seconds < 120 else 1 if seconds < 300 else 2, len(phases) - 1)
        phase = phases[phase_index]
        result["events"] += 1
        if record.kind == "save":
            if record.slot is None or record.target is None:
                # A malformed save cannot establish either a new location or
                # meaningful absence. Omit this independently observed family.
                return None
            if record.slot not in slots:
                slots[record.slot] = {"slot": record.slot, "saves": 0, "firstSaveSec": round(seconds, 3),
                                      "returns": 0, "returnIntervals": [0] * 6}
                result["saveOrder"].append(record.slot)
            slots[record.slot]["saves"] += 1
            positions[record.slot] = record.target
            phase["saves"] += 1
            result["saves"] += 1
            # Saving captures the current camera. Do not count the next equal
            # update (even within the same frame) as a recall of the new save.
            last_position = record.target
            continue
        if record.target is None:
            # A zoom/rotation update without target says nothing about a return.
            continue
        result["positionUpdates"] += 1
        if record.target == last_position:
            continue
        last_position = record.target
        matched = [slot for slot, point in positions.items() if point == record.target]
        if len(matched) != 1:
            # Two slots at the same point cannot establish which was recalled.
            continue
        slot = matched[0]
        row = slots[slot]
        row.setdefault("firstReturnSec", round(seconds, 3))
        row["returns"] += 1
        result["returns"] += 1
        phase["returns"] += 1
        if slot in last_slot_return:
            _histogram_add(row["returnIntervals"], seconds - last_slot_return[slot])
        if last_return is not None:
            gap = seconds - last_return[1]
            _histogram_add(return_intervals, gap)
            if last_return[0] != slot and 0 <= gap <= 4:
                transitions[(last_return[0], slot)] += 1
        last_slot_return[slot], last_return = seconds, (slot, seconds)
    if result["events"] > 99999 or any(row[name] > 9999 for row in slots.values() for name in ("saves", "returns")):
        return None
    for row in slots.values():
        if not any(row["returnIntervals"]):
            del row["returnIntervals"]
    result["slots"] = [slots[slot] for slot in sorted(slots)]
    if any(return_intervals):
        result["returnIntervals"] = return_intervals
    if transitions:
        result["transitions"] = [{"from": pair[0], "to": pair[1], "count": count}
                                 for pair, count in sorted(transitions.items(), key=lambda item: (-item[1], item[0]))[:12]]
    return result


def extract_camera_signature(replay: Any, *, opponent_pid: int, fps: float, active_seconds: int) -> dict | None:
    """Return bounded camera evidence with canonical-player attribution."""
    if _integer(opponent_pid, 1, 16) is None or _integer(active_seconds, 1, WINDOW_SEC) is None:
        return None
    players = [player for player in getattr(replay, "players", ()) if getattr(player, "pid", None) == opponent_pid]
    if len(players) != 1:
        return None
    user_id = _integer(getattr(players[0], "uid", None), 0, 15)
    if user_id is None or sum(getattr(player, "uid", None) == user_id for player in getattr(replay, "players", ())) != 1:
        return None
    records = _decode_camera_records(replay, fps)
    if records is None:
        return None
    return _summarize_camera_records(records, user_id=user_id, fps=fps, active_seconds=active_seconds)
