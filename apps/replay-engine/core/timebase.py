"""Real-game-time conversion helpers.

sc2reader 1.8.0 hard-codes ``Event.second = frame // 16``. That's the
HotS / WoL frame rate; LotV runs at 22.4 fps. ``replay.length`` itself
is computed correctly (``frames / 22.4``), but ``event.second`` ends up
1.4× too high on every LotV replay. The downstream effect: every
buildLog timestamp, macro-breakdown ``time`` / ``born_time`` /
``died_time``, APM-curve sample, and rule threshold the cloud reads
back off a stored game is living on the broken scale.

This module exposes one function — ``event_seconds(event, replay)`` —
which converts an event's frame to real game-time seconds. It infers
the true fps from ``replay.frames / replay.length.seconds`` (so HotS /
WoL replays at the genuine 16 fps still resolve correctly) and falls
back to LotV's 22.4 fps when the header is incomplete or implausible.
``infer_fps(replay)`` is exported separately so other call sites (the
agent's APM-curve fallback, migration scripts) can convert raw frames
without a synthetic event wrapper.
"""

from __future__ import annotations

LOTV_FPS = 22.4


def infer_fps(replay) -> float:
    """Return the replay's real frame-rate, in fps.

    Computed from ``replay.frames / replay.length.seconds`` when both
    are populated and the ratio sits inside a sane window
    (``14.0 ≤ fps ≤ 24.0``). Outside that window — or when either
    field is missing / zero — we fall back to LotV's 22.4 fps, which
    is correct for every post-2015 replay the agent ingests.

    The sane-window cap exists because a corrupt header can make the
    ratio collapse to a one-frame replay (effectively ``+∞``) or
    explode to thousands of frames per "second"; either would poison
    the conversion. 14 fps is below sc2reader's hard-coded 16 fps
    floor (so legitimate HotS replays still pass); 24 fps is above
    LotV's 22.4 fps ceiling with a small margin for rounding.
    """
    length = getattr(getattr(replay, "length", None), "seconds", 0)
    frames = getattr(replay, "frames", 0)
    if length and frames and length > 0:
        fps = frames / length
        if 14.0 <= fps <= 24.0:
            return fps
    return LOTV_FPS


def event_seconds(event, replay) -> int:
    """Convert an sc2reader event's frame to real game-time seconds.

    Returns ``int(round(event.frame / infer_fps(replay)))``. When the
    event has no ``frame`` attribute we fall back to ``event.second``
    (which sc2reader hard-codes to ``frame // 16``) and rescale it to
    real time via the same fps.
    """
    frame = getattr(event, "frame", None)
    if frame is None:
        sec = getattr(event, "second", None)
        if sec is None:
            return 0
        return int(round(sec * 16.0 / infer_fps(replay)))
    return int(round(frame / infer_fps(replay)))


def event_seconds_precise(event, replay) -> float:
    """Playback timestamp without rounding away subsecond event ordering.

    Analytics intentionally uses integer seconds. Playback must preserve
    frame ordering: rounding an init, morph and death to the same second
    can show a unit before it exists or discard its final observation.
    """
    frame = getattr(event, "frame", None)
    if frame is None:
        frame = float(getattr(event, "second", 0) or 0) * 16.0
    # SC2's length field is truncated to whole seconds. Inferring a frame
    # rate from that rounded duration drifts by almost a second by game end.
    # Modern Faster replays and the SC2 API use exactly 22.4 loops/second.
    fps = (LOTV_FPS if getattr(replay, "speed", None) == "Faster"
           and getattr(replay, "expansion", None) == "LotV" else infer_fps(replay))
    return float(frame) / fps


def real_game_length(replay) -> float:
    """The game's length in REAL seconds — the same timebase
    ``event_seconds`` puts on every event.

    ``replay.game_length`` is Blizzard "game time" (frames / 16),
    which runs 1.4x real time on Faster — mixing it with
    ``event_seconds`` timestamps stretched the playback timeline 40%
    past the actual game (a 16:04 game scrubbed to 22:29).
    """
    frames = getattr(replay, "frames", None)
    if isinstance(frames, (int, float)) and frames > 0:
        return float(frames) / infer_fps(replay)
    gl = getattr(replay, "game_length", None)
    seconds = getattr(gl, "seconds", None) if gl is not None else None
    return float(seconds) if seconds else 0.0
