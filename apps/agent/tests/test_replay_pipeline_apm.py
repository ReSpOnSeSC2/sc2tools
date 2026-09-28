"""Regression tests for per-player APM attribution and the slim apm/spq fields.

Fixed in agent 0.17.2:

  - ``_compute_apm_curve`` compared sc2reader's game-event ``ev.pid`` (a
    0-indexed *user* id) with ``player.pid`` (a 1-indexed slot). Slot 1
    was credited with slot 2's actions and slot 2 always showed zero.
  - It counted commands only; APM now counts every command, selection and
    control-group action, as StarCraft II's own counter does (curve v2).
  - The slim ``apm`` / ``spq`` fields were read off ``PlayerInfo``, which
    has neither attribute, so every uploaded game carried ``null``.

Fixed in agent 0.17.3 (curve v3):

  - ``avg_apm`` is the APM StarCraft II wrote into the replay
    (``replay.gamemetadata.json``), so the website shows SC2's own figure
    (221 for a game the v2 curve read as 196). The windows are scaled to
    it, and replays without that metadata fall back to counting events.
  - A command repeated with its hotkey (a ``CommandManagerStateEvent`` on
    its own, e.g. queueing more Probes) counts as an action; the repeat
    written with a right-click update is part of that click.

The unit tests lock the helpers down without parsing a replay. The fixture
tests parse real ladder replays from both players' perspectives.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

FIXTURE_REPLAY = (
    HERE.parent
    / "replay-engine"
    / "tests"
    / "fixtures"
    / "replays"
    / "warpgate_adept_tracking.SC2Replay"
)


@pytest.fixture(autouse=True)
def _no_pulse_network(monkeypatch):
    """Keep every parse hermetic: the Pulse resolver must never be called."""

    class _StubModule:
        @staticmethod
        def resolve_pulse_id_by_toon(handle, name):
            raise AssertionError("pulse lookup must be disabled in these tests")

    monkeypatch.setitem(sys.modules, "core.pulse_resolver", _StubModule)


# ---------------------------------------------------------------------------
# _game_event_player_slot
# ---------------------------------------------------------------------------


def test_player_slot_prefers_resolved_player_over_raw_user_id():
    from sc2tools_agent.replay_pipeline import _game_event_player_slot

    ev = SimpleNamespace(pid=0, player=SimpleNamespace(pid=1))
    assert _game_event_player_slot(ev) == 1


def test_player_slot_never_returns_the_raw_user_id():
    from sc2tools_agent.replay_pipeline import _game_event_player_slot

    # user 1 is normally slot 2 — the old code returned 1 here.
    ev = SimpleNamespace(pid=1, player=SimpleNamespace(pid=2))
    assert _game_event_player_slot(ev) == 2
    assert _game_event_player_slot(SimpleNamespace(pid=1)) is None


def test_player_slot_falls_back_to_commanded_unit_owner():
    from sc2tools_agent.replay_pipeline import _game_event_player_slot

    ev = SimpleNamespace(pid=0, player=None, control_player_id=2)
    assert _game_event_player_slot(ev) == 2
    ev = SimpleNamespace(pid=0, player=None, control_player_id=0, upkeep_player_id=1)
    assert _game_event_player_slot(ev) == 1


def test_player_slot_ignores_observers():
    from sc2tools_agent.replay_pipeline import _game_event_player_slot

    observer = SimpleNamespace(name="caster")  # observers carry no slot pid
    assert _game_event_player_slot(SimpleNamespace(pid=2, player=observer)) is None


# ---------------------------------------------------------------------------
# Slim apm / spq helpers
# ---------------------------------------------------------------------------


def _curve(pid, avg_apm):
    return {"players": [{"pid": pid, "avg_apm": avg_apm, "samples": []}]}


def test_my_average_apm_is_the_curves_whole_game_average():
    from sc2tools_agent.replay_pipeline import _my_average_apm

    assert _my_average_apm(_curve(1, 212.4), 1) == 212.4


def test_my_average_apm_is_none_without_data_or_for_other_pid():
    from sc2tools_agent.replay_pipeline import _my_average_apm

    assert _my_average_apm(None, 1) is None
    assert _my_average_apm(_curve(1, 150.0), None) is None
    assert _my_average_apm(_curve(2, 150.0), 1) is None
    assert _my_average_apm(_curve(1, None), 1) is None
    assert _my_average_apm(_curve(1, True), 1) is None


def test_my_average_apm_omits_values_the_api_schema_would_reject():
    from sc2tools_agent.replay_pipeline import _my_average_apm

    assert _my_average_apm(_curve(1, 5001.0), 1) is None
    assert _my_average_apm(_curve(1, 0.0), 1) is None


def test_rate_samples_divide_the_last_window_by_its_real_length():
    from sc2tools_agent.replay_pipeline import _rate_samples

    side = {"actions": {0: 60, 1: 10}, "selections": {0: 15}, "total": 70}
    samples = _rate_samples(side, game_length=50, window_sec=30)
    assert samples == [
        {"t": 0, "apm": 120.0, "spm": 30.0},
        {"t": 30, "apm": 30.0, "spm": 0.0},  # 10 actions in the final 20 s
    ]


def test_rate_samples_fold_a_short_final_window_into_the_one_before():
    from sc2tools_agent.replay_pipeline import _rate_samples

    # A 1-second final window would read 0 (or a spike) at game end.
    side = {"actions": {0: 60, 1: 2}, "selections": {0: 15, 1: 1}, "total": 62}
    samples = _rate_samples(side, game_length=31, window_sec=30)
    assert samples == [{"t": 0, "apm": 120.0, "spm": 31.0}]  # 62 actions in 31 s


def test_rate_samples_keep_a_game_shorter_than_one_window():
    from sc2tools_agent.replay_pipeline import _rate_samples

    side = {"actions": {0: 10}, "selections": {}, "total": 10}
    assert _rate_samples(side, game_length=12, window_sec=30) == [
        {"t": 0, "apm": 50.0, "spm": 0.0},
    ]


def test_rate_samples_scale_apm_but_not_spm():
    from sc2tools_agent.replay_pipeline import _rate_samples

    side = {"actions": {0: 60, 1: 30}, "selections": {0: 15, 1: 5}, "total": 90}
    assert _rate_samples(side, game_length=60, window_sec=30, apm_scale=1.1) == [
        {"t": 0, "apm": 132.0, "spm": 30.0},
        {"t": 30, "apm": 66.0, "spm": 10.0},
    ]


# ---------------------------------------------------------------------------
# StarCraft II's own APM (replay.gamemetadata.json)
# ---------------------------------------------------------------------------


def _replay_with_metadata(payload):
    """A stand-in replay whose archive serves ``payload`` as the metadata
    file (``None`` = the file is missing, bytes = served as-is)."""

    class _Archive:
        def read_file(self, name):
            assert name == "replay.gamemetadata.json"
            if payload is None or isinstance(payload, bytes):
                return payload
            return json.dumps(payload).encode("utf-8")

    return SimpleNamespace(archive=_Archive())


def test_sc2_reported_apm_reads_each_players_apm_by_slot():
    from sc2tools_agent.replay_pipeline import _sc2_reported_apm

    replay = _replay_with_metadata({
        "Duration": 640,
        "Players": [
            {"PlayerID": 1, "MMR": 5063, "APM": 319.0, "Result": "Loss"},
            {"PlayerID": 2, "MMR": 5316, "APM": 221.0, "Result": "Win"},
        ],
    })
    assert _sc2_reported_apm(replay) == {1: 319.0, 2: 221.0}


@pytest.mark.parametrize("apm", [0, 0.0, -5, 5001, True, "221", None, float("nan")])
def test_sc2_reported_apm_drops_unusable_values(apm):
    from sc2tools_agent.replay_pipeline import _sc2_reported_apm

    replay = _replay_with_metadata(
        {"Players": [{"PlayerID": 1, "APM": apm}, {"PlayerID": 2, "APM": 150}]},
    )
    assert _sc2_reported_apm(replay) == {2: 150.0}


@pytest.mark.parametrize(
    "replay",
    [
        SimpleNamespace(),  # no archive (a stub or a non-replay context)
        _replay_with_metadata(None),  # older builds have no metadata file
        _replay_with_metadata(b"{not json"),
        _replay_with_metadata({"Players": "nope"}),
        _replay_with_metadata([1, 2, 3]),
        _replay_with_metadata({"Players": [{"PlayerID": True, "APM": 200}, "x"]}),
    ],
)
def test_sc2_reported_apm_is_empty_without_usable_metadata(replay):
    from sc2tools_agent.replay_pipeline import _sc2_reported_apm

    assert _sc2_reported_apm(replay) == {}


# ---------------------------------------------------------------------------
# _count_player_actions
# ---------------------------------------------------------------------------


def _event(cls_name, frame, slot):
    """A real sc2reader event instance (so ``isinstance`` holds) carrying
    only what the counter reads: its game loop and issuing player."""
    game_events = pytest.importorskip("sc2reader.events.game")
    cls = getattr(game_events, cls_name)
    ev = cls.__new__(cls)
    ev.frame = frame
    ev.player = SimpleNamespace(pid=slot)
    return ev


def test_count_player_actions_counts_hotkey_repeats_once_each():
    from sc2tools_agent.replay_pipeline import _count_player_actions

    events = [
        _event("BasicCommandEvent", 20, 1),  # Train Probe
        _event("CommandManagerStateEvent", 22, 1),  # a second Probe
        _event("CommandManagerStateEvent", 22, 1),  # and a third
        _event("SelectionEvent", 30, 1),
        _event("GetControlGroupEvent", 31, 1),
        _event("CameraEvent", 32, 1),  # camera moves are not actions
    ]
    counts = _count_player_actions(events, (1, 2), fps=1.0, window_sec=30)
    assert counts[1]["total"] == 5
    assert counts[1]["actions"] == {0: 3, 1: 2}
    assert counts[1]["selections"] == {1: 1}
    assert counts[2]["total"] == 0


def test_count_player_actions_counts_a_right_click_update_once():
    from sc2tools_agent.replay_pipeline import _count_player_actions

    # Right-click spam writes a target update and a repeat in the same
    # game loop for every click.
    events = []
    for frame in (10, 14, 18):
        events.append(_event("UpdateTargetPointCommandEvent", frame, 1))
        events.append(_event("CommandManagerStateEvent", frame, 1))
    events.append(_event("CommandManagerStateEvent", 19, 1))  # a later, separate repeat
    counts = _count_player_actions(events, (1,), fps=1.0, window_sec=30)
    assert counts[1]["total"] == 4


def test_count_player_actions_keeps_each_players_update_separate():
    from sc2tools_agent.replay_pipeline import _count_player_actions

    events = [
        _event("UpdateTargetUnitCommandEvent", 40, 1),
        _event("CommandManagerStateEvent", 40, 2),  # the opponent's own repeat
        _event("CommandManagerStateEvent", 40, 1),  # player 1's click
        _event("UpdateTargetPointCommandEvent", 50, 1),
        _event("SelectionEvent", 50, 1),
        _event("CommandManagerStateEvent", 50, 1),  # no longer the update's click
    ]
    counts = _count_player_actions(events, (1, 2), fps=1.0, window_sec=30)
    assert counts[1]["total"] == 4
    assert counts[2]["total"] == 1


@pytest.mark.parametrize("sq", [81.4, 0.0, 142])
def test_my_spending_quotient_mirrors_raw_sq(sq):
    from sc2tools_agent.replay_pipeline import _my_spending_quotient

    assert _my_spending_quotient({"raw": {"sq": sq}}) == float(sq)


@pytest.mark.parametrize(
    "breakdown",
    [
        None,
        {},
        {"raw": None},
        {"raw": {}},
        {"raw": {"sq": -12.5}},  # schema requires spq >= 0
        {"raw": {"sq": math.nan}},
        {"raw": {"sq": math.inf}},
        {"raw": {"sq": True}},
        {"raw": {"sq": "81"}},
    ],
)
def test_my_spending_quotient_omits_unusable_values(breakdown):
    from sc2tools_agent.replay_pipeline import _my_spending_quotient

    assert _my_spending_quotient(breakdown) is None


# ---------------------------------------------------------------------------
# Real replays, both perspectives
# ---------------------------------------------------------------------------


def _require_real_parser():
    pytest.importorskip("sc2reader")
    if not FIXTURE_REPLAY.is_file():
        pytest.skip("fixture replay not available")
    from sc2tools_agent.replay_pipeline import probe_analyzer

    ok, diag = probe_analyzer()
    if not ok:
        pytest.skip(f"replay engine unavailable: {diag}")


def _metadata_apm(path):
    """Each slot's APM straight from the replay's metadata file, read
    independently of the pipeline."""
    import mpyq

    raw = mpyq.MPQArchive(str(path)).read_file("replay.gamemetadata.json")
    return {p["PlayerID"]: float(p["APM"]) for p in json.loads(raw)["Players"]}


def _actions_by_slot(replay):
    """Every command, selection and control-group event, per player slot."""
    from sc2reader.events.game import CommandEvent, ControlGroupEvent, SelectionEvent

    counts = {}
    for ev in replay.events:
        if isinstance(ev, (CommandEvent, SelectionEvent, ControlGroupEvent)):
            slot = getattr(getattr(ev, "player", None), "pid", None)
            counts[slot] = counts.get(slot, 0) + 1
    return counts


def _hotkey_repeats_by_slot(replay):
    """Command repeats that are not the second half of a target update's
    click (same player, same game loop, nothing in between)."""
    from sc2reader.events.game import (
        CommandEvent,
        CommandManagerStateEvent,
        ControlGroupEvent,
        SelectionEvent,
        UpdateTargetPointCommandEvent,
        UpdateTargetUnitCommandEvent,
    )

    actions = (CommandEvent, SelectionEvent, ControlGroupEvent, CommandManagerStateEvent)
    updates = (UpdateTargetPointCommandEvent, UpdateTargetUnitCommandEvent)
    last = {}
    repeats = {}
    for ev in replay.events:
        if not isinstance(ev, actions):
            continue
        slot = getattr(getattr(ev, "player", None), "pid", None)
        before = last.get(slot)
        last[slot] = ev
        if not isinstance(ev, CommandManagerStateEvent):
            continue
        if isinstance(before, updates) and before.frame == ev.frame:
            last[slot] = None  # the click is complete
            continue
        repeats[slot] = repeats.get(slot, 0) + 1
    return repeats


def _curve_actions(curve, game_length):
    """Undo each window's per-minute rate back into an action count."""
    counts = {}
    for p in curve["players"]:
        ends = [s["t"] for s in p["samples"][1:]] + [game_length]
        counts[p["pid"]] = round(sum(
            s["apm"] * (end - s["t"]) / 60 for s, end in zip(p["samples"], ends)
        ))
    return counts


def _seconds_in_game(replay, game_length):
    """Real seconds each player slot stayed in the game (sc2reader's own
    leave attribution, independent of the pipeline's slot resolver)."""
    from sc2reader.events.game import PlayerLeaveEvent
    from core.timebase import infer_fps  # type: ignore

    fps = infer_fps(replay)
    played = {}
    for ev in replay.events:
        slot = getattr(getattr(ev, "player", None), "pid", None)
        if isinstance(ev, PlayerLeaveEvent) and slot not in played:
            played[slot] = min(ev.frame / fps, game_length)
    return played


@pytest.mark.parametrize("perspective", ["ReSpOnSe", "Squirtuoz"])
def test_avg_apm_is_the_apm_sc2_wrote_into_the_replay(perspective):
    _require_real_parser()
    from core.sc2_replay_parser import parse_deep  # type: ignore
    from sc2tools_agent.replay_pipeline import APM_CURVE_VERSION, _compute_apm_curve

    ctx = parse_deep(str(FIXTURE_REPLAY), perspective)
    curve = _compute_apm_curve(ctx)

    assert curve is not None and curve["has_data"] is True
    assert curve["v"] == APM_CURVE_VERSION == 3
    sc2 = _metadata_apm(FIXTURE_REPLAY)
    assert sc2 == {1: 228.0, 2: 362.0}  # ReSpOnSe, Squirtuoz
    by_pid = {p["pid"]: p for p in curve["players"]}
    assert by_pid[ctx.me.pid]["is_me"] is True
    assert by_pid[ctx.opponent.pid]["is_me"] is False
    played = _seconds_in_game(ctx.raw, ctx.length_seconds)
    windows = _curve_actions(curve, ctx.length_seconds)
    for pid in (ctx.me.pid, ctx.opponent.pid):
        assert by_pid[pid]["avg_apm"] == sc2[pid]
        assert by_pid[pid]["avg_apm_source"] == "sc2"
        # The windows are scaled to SC2's figure over the player's time in
        # the game (per-window rates are rounded to 0.1 APM).
        seconds = played.get(pid, ctx.length_seconds)
        assert windows[pid] == pytest.approx(sc2[pid] * seconds / 60, abs=2)


@pytest.mark.parametrize("perspective", ["ReSpOnSe", "Squirtuoz"])
def test_event_count_credits_each_player_with_their_own_actions(perspective, monkeypatch):
    """Without SC2's figure the curve counts events: commands, selections,
    control groups and hotkey repeats, each credited to its own player."""
    _require_real_parser()
    from core.sc2_replay_parser import parse_deep  # type: ignore
    from sc2tools_agent import replay_pipeline

    monkeypatch.setattr(replay_pipeline, "_sc2_reported_apm", lambda _replay: {})
    ctx = parse_deep(str(FIXTURE_REPLAY), perspective)
    curve = replay_pipeline._compute_apm_curve(ctx)
    actions = _actions_by_slot(ctx.raw)
    repeats = _hotkey_repeats_by_slot(ctx.raw)
    expected = {pid: actions[pid] + repeats.get(pid, 0) for pid in (1, 2)}
    assert all(repeats.get(pid, 0) > 0 for pid in (1, 2))

    got = _curve_actions(curve, ctx.length_seconds)
    by_pid = {p["pid"]: p for p in curve["players"]}
    played = _seconds_in_game(ctx.raw, ctx.length_seconds)
    for pid in (ctx.me.pid, ctx.opponent.pid):
        # Per-window rates are rounded to 0.1 APM.
        assert abs(got[pid] - expected[pid]) <= len(by_pid[pid]["samples"])
        want = round(expected[pid] * 60 / played.get(pid, ctx.length_seconds), 1)
        assert by_pid[pid]["avg_apm"] == want
        assert by_pid[pid]["avg_apm_source"] == "events"


LADDER_TVZ_REPLAY = FIXTURE_REPLAY.with_name("ladder_tvz_ever_dream_18min.SC2Replay")


def test_event_count_matches_sc2reader_plus_repeats_minus_its_double_counts(monkeypatch):
    """On a real 18-minute ladder game where JiaanN leaves before the
    replay ends and uses control-group steal/clear, the event count is
    sc2reader's APMTracker without its double-counted control groups, plus
    the hotkey repeats it ignores, each over the player's own time."""
    _require_real_parser()
    if not LADDER_TVZ_REPLAY.is_file():
        pytest.skip("ladder fixture replay not available")
    import sc2reader
    from sc2reader.engine import GameEngine
    from sc2reader.engine.plugins import APMTracker, ContextLoader, GameHeartNormalizer
    from sc2reader.events.game import ControlGroupEvent
    from core.sc2_replay_parser import parse_deep  # type: ignore
    from sc2tools_agent import replay_pipeline

    monkeypatch.setattr(replay_pipeline, "_sc2_reported_apm", lambda _replay: {})
    ctx = parse_deep(str(LADDER_TVZ_REPLAY), "JiaanN")
    curve = replay_pipeline._compute_apm_curve(ctx)
    avg = {p["pid"]: p["avg_apm"] for p in curve["players"]}
    actions = _actions_by_slot(ctx.raw)
    repeats = _hotkey_repeats_by_slot(ctx.raw)
    played = _seconds_in_game(ctx.raw, ctx.length_seconds)
    assert played[ctx.me.pid] < ctx.length_seconds  # JiaanN left first

    # A private engine (the default one's plugins plus APMTracker), so the
    # global sc2reader engine the pipeline uses is left untouched.
    engine = GameEngine()
    engine.register_plugins(
        GameHeartNormalizer(), ContextLoader(), APMTracker(),
    )
    ref = sc2reader.load_replay(str(LADDER_TVZ_REPLAY), load_level=4, engine=engine)
    for player in ref.players:
        pid = player.pid
        counted = actions[pid] + repeats.get(pid, 0)
        assert avg[pid] == round(counted * 60 / played[pid], 1)
        # sc2reader handles each plain ControlGroupEvent (clear / steal) twice.
        twice = sum(
            1 for ev in ref.events
            if type(ev) is ControlGroupEvent and getattr(ev.player, "pid", None) == pid
        )
        corrected = player.avg_apm * actions[pid] / (actions[pid] + twice)
        assert avg[pid] == pytest.approx(corrected * counted / actions[pid], abs=0.2)
    # The final window runs to the end instead of reading one empty second.
    for p in curve["players"]:
        assert ctx.length_seconds - p["samples"][-1]["t"] >= curve["window_sec"] / 2
        assert p["samples"][-1]["apm"] > 0


def test_ladder_game_shows_sc2s_apm_for_both_players():
    _require_real_parser()
    if not LADDER_TVZ_REPLAY.is_file():
        pytest.skip("ladder fixture replay not available")
    from core.sc2_replay_parser import parse_deep  # type: ignore
    from sc2tools_agent.replay_pipeline import _compute_apm_curve

    ctx = parse_deep(str(LADDER_TVZ_REPLAY), "JiaanN")
    curve = _compute_apm_curve(ctx)
    avg = {p["pid"]: p["avg_apm"] for p in curve["players"]}
    assert avg == _metadata_apm(LADDER_TVZ_REPLAY) == {1: 162.0, 2: 221.0}


def test_uploaded_game_carries_consistent_apm_and_spq():
    _require_real_parser()
    from sc2tools_agent.replay_pipeline import parse_replay_for_cloud_ex

    game, reason = parse_replay_for_cloud_ex(
        FIXTURE_REPLAY, player_handle="ReSpOnSe", resolve_pulse=False,
    )
    assert reason is None and game is not None
    payload = game.to_payload()
    breakdown = payload["macroBreakdown"]

    me_curve = next(p for p in payload["apmCurve"]["players"] if p["is_me"])
    assert payload["apm"] == 228.0  # what StarCraft II recorded for ReSpOnSe
    assert payload["apm"] == breakdown["player_stats"]["me"]["apm"] == me_curve["avg_apm"]
    opp_curve = next(p for p in payload["apmCurve"]["players"] if not p["is_me"])
    assert breakdown["player_stats"]["opponent"]["apm"] == opp_curve["avg_apm"] == 362.0
    assert isinstance(payload.get("spq"), float) and payload["spq"] >= 0
    assert payload["spq"] == pytest.approx(breakdown["raw"]["sq"], abs=0.01)
