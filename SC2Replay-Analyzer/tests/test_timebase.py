"""Calibration anchors for ``core.timebase.event_seconds``.

sc2reader 1.8.0 hard-codes ``Event.second = frame // 16``, but real
LotV game-time runs at 22.4 fps. ``timebase.event_seconds`` infers the
true fps from ``replay.frames / replay.length.seconds`` and converts
each event's frame into wall-clock seconds. This test pins the four
calibration corners with a fixture-replay stub so the math itself can
be exercised even on CI hosts that lack the sc2reader wheel.

Module: tests
"""
from __future__ import annotations

import os
import sys
from types import SimpleNamespace

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from core.timebase import LOTV_FPS, event_seconds, infer_fps


def _stub_replay(*, frames: int, length_seconds: int):
    """Build the minimal ``replay`` shape ``infer_fps`` reads.

    ``frames`` and ``length.seconds`` are the only attributes touched
    on the replay object — keeping the stub this thin lets the test
    document exactly what the conversion depends on.
    """
    return SimpleNamespace(
        frames=frames,
        length=SimpleNamespace(seconds=length_seconds),
    )


def _stub_event(*, frame=None, second=None):
    """An event-shaped object with whatever attrs the test provides.

    ``getattr(ev, "frame", None)`` and ``getattr(ev, "second", None)``
    are the only two attributes ``event_seconds`` ever reads.
    """
    attrs = {}
    if frame is not None:
        attrs["frame"] = frame
    if second is not None:
        attrs["second"] = second
    return SimpleNamespace(**attrs)


# ---------- infer_fps ----------

def test_infer_fps_lotv_replay_resolves_to_22_4():
    """A canonical LotV replay (10 535 frames, 470 s game length) must
    land at sc2reader's true 22.4 fps — within float precision. This
    matches the actual ``warpgate_adept_tracking.SC2Replay`` fixture
    that anchors the rest of the suite.
    """
    fps = infer_fps(_stub_replay(frames=10535, length_seconds=470))
    assert abs(fps - 22.4) < 0.05, fps


def test_infer_fps_hots_replay_keeps_16fps():
    """HotS / WoL replays really do run at 16 fps. When the ratio
    lands inside the sane window we MUST trust it rather than
    forcing 22.4 — otherwise legacy replays would be down-shifted
    1.4× too low.
    """
    # 9600 frames / 600s = 16.0 fps exactly.
    fps = infer_fps(_stub_replay(frames=9600, length_seconds=600))
    assert abs(fps - 16.0) < 0.05, fps


def test_infer_fps_falls_back_to_lotv_when_header_missing():
    """``replay.length`` may be absent on partially-parsed replays.
    The fallback is LotV's 22.4 fps — the dominant case for every
    post-2015 replay the agent ingests.
    """
    bare = SimpleNamespace()
    assert infer_fps(bare) == LOTV_FPS


def test_infer_fps_rejects_corrupt_header_ratio():
    """Implausible ratios (single-frame replay, header zero) collapse
    to ``+∞`` or ``0`` and would poison every downstream timestamp.
    Outside the 14–24 fps window we fall back to 22.4.
    """
    insane = _stub_replay(frames=1, length_seconds=1)  # 1.0 fps
    assert infer_fps(insane) == LOTV_FPS
    silly = _stub_replay(frames=100000, length_seconds=10)  # 10000 fps
    assert infer_fps(silly) == LOTV_FPS


# ---------- event_seconds ----------

def test_event_seconds_converts_frame_at_lotv_22_4():
    """Calibration anchor: ``Frame 3163 → real 141s`` (the 2nd Nexus
    placement on a stub-LotV replay). The broken scale would have
    emitted ``3163 // 16 = 197 s`` — confirming the 1.4× drift the
    pipeline used to ship.
    """
    replay = _stub_replay(frames=10535, length_seconds=470)
    ev = _stub_event(frame=3163)
    assert event_seconds(ev, replay) == 141


def test_event_seconds_uses_frame_in_preference_to_second():
    """When BOTH ``frame`` and ``second`` are present we use
    ``frame`` — ``second`` is the broken-scale value and would shift
    the timestamp by ~1.4×.
    """
    replay = _stub_replay(frames=10535, length_seconds=470)
    # sc2reader would emit (frame=2240, second=140) at exactly 100s.
    ev = _stub_event(frame=2240, second=140)
    assert event_seconds(ev, replay) == 100


def test_event_seconds_falls_back_to_second_when_frame_missing():
    """Very old sc2reader paths only expose ``.second`` on certain
    event types. In that case we rescale the broken-16fps value to
    real time so the call site doesn't have to special-case it.
    """
    replay = _stub_replay(frames=10535, length_seconds=470)
    # broken sec=140 → frame≈2240 → real≈100
    ev = _stub_event(second=140)
    real = event_seconds(ev, replay)
    assert 99 <= real <= 101, real


def test_event_seconds_zero_when_no_time_info():
    """Defensive default: an event with neither ``frame`` nor
    ``second`` is treated as t=0 so iteration doesn't crash.
    """
    replay = _stub_replay(frames=10535, length_seconds=470)
    assert event_seconds(_stub_event(), replay) == 0
