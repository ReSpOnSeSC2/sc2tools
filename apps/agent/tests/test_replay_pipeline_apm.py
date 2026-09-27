"""Regression tests for per-player APM attribution and the slim apm/spq fields.

Fixed in agent 0.17.2:

  - ``_compute_apm_curve`` compared sc2reader's game-event ``ev.pid`` (a
    0-indexed *user* id) with ``player.pid`` (a 1-indexed slot). Slot 1
    was credited with slot 2's actions and slot 2 always showed zero.
  - It counted commands only; APM now counts every command, selection and
    control-group action, as StarCraft II's own counter does (curve v2).
  - The slim ``apm`` / ``spq`` fields were read off ``PlayerInfo``, which
    has neither attribute, so every uploaded game carried ``null``.

The unit tests lock the helpers down without sc2reader. The fixture test
parses a real ladder replay from both players' perspectives.
"""

from __future__ import annotations

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
# Real replay, both perspectives
# ---------------------------------------------------------------------------


def _require_real_parser():
    pytest.importorskip("sc2reader")
    if not FIXTURE_REPLAY.is_file():
        pytest.skip("fixture replay not available")
    from sc2tools_agent.replay_pipeline import probe_analyzer

    ok, diag = probe_analyzer()
    if not ok:
        pytest.skip(f"replay engine unavailable: {diag}")


def _actions_by_slot(replay):
    """Every command, selection and control-group event, per player slot."""
    from sc2reader.events.game import CommandEvent, ControlGroupEvent, SelectionEvent

    counts = {}
    for ev in replay.events:
        if isinstance(ev, (CommandEvent, SelectionEvent, ControlGroupEvent)):
            slot = getattr(getattr(ev, "player", None), "pid", None)
            counts[slot] = counts.get(slot, 0) + 1
    return counts


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
def test_apm_curve_credits_each_player_with_their_own_actions(perspective):
    _require_real_parser()
    from core.sc2_replay_parser import parse_deep  # type: ignore
    from sc2tools_agent.replay_pipeline import APM_CURVE_VERSION, _compute_apm_curve

    ctx = parse_deep(str(FIXTURE_REPLAY), perspective)
    expected = _actions_by_slot(ctx.raw)
    curve = _compute_apm_curve(ctx)

    assert curve is not None and curve["has_data"] is True
    assert curve["v"] == APM_CURVE_VERSION == 2
    got = _curve_actions(curve, ctx.length_seconds)
    for pid in (ctx.me.pid, ctx.opponent.pid):
        # Per-window rates are rounded to 0.1 APM.
        assert abs(got[pid] - expected[pid]) <= len(curve["players"][0]["samples"])
    by_pid = {p["pid"]: p for p in curve["players"]}
    played = _seconds_in_game(ctx.raw, ctx.length_seconds)
    for pid in (ctx.me.pid, ctx.opponent.pid):
        want = round(expected[pid] * 60 / played.get(pid, ctx.length_seconds), 1)
        assert by_pid[pid]["avg_apm"] == want
    assert by_pid[ctx.me.pid]["is_me"] is True


LADDER_TVZ_REPLAY = FIXTURE_REPLAY.with_name("ladder_tvz_ever_dream_18min.SC2Replay")


def test_apm_matches_sc2reader_except_its_double_counted_control_groups():
    """On a real 18-minute ladder game where JiaanN leaves before the
    replay ends and uses control-group steal/clear, every action counts
    once and each player is averaged over their own time in the game."""
    _require_real_parser()
    if not LADDER_TVZ_REPLAY.is_file():
        pytest.skip("ladder fixture replay not available")
    import sc2reader
    from sc2reader.engine import GameEngine
    from sc2reader.engine.plugins import APMTracker, ContextLoader, GameHeartNormalizer
    from sc2reader.events.game import ControlGroupEvent
    from core.sc2_replay_parser import parse_deep  # type: ignore
    from sc2tools_agent.replay_pipeline import _compute_apm_curve

    ctx = parse_deep(str(LADDER_TVZ_REPLAY), "JiaanN")
    curve = _compute_apm_curve(ctx)
    avg = {p["pid"]: p["avg_apm"] for p in curve["players"]}
    actions = _actions_by_slot(ctx.raw)
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
        # sc2reader handles each plain ControlGroupEvent (clear / steal) twice.
        twice = sum(
            1 for ev in ref.events
            if type(ev) is ControlGroupEvent and getattr(ev.player, "pid", None) == player.pid
        )
        assert avg[player.pid] == round(actions[player.pid] * 60 / played[player.pid], 1)
        corrected = player.avg_apm * actions[player.pid] / (actions[player.pid] + twice)
        assert avg[player.pid] == pytest.approx(corrected, abs=0.2)
    # The final window runs to the end instead of reading one empty second.
    for p in curve["players"]:
        assert ctx.length_seconds - p["samples"][-1]["t"] >= curve["window_sec"] / 2
        assert p["samples"][-1]["apm"] > 0


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
    assert isinstance(payload.get("apm"), float) and payload["apm"] > 0
    assert payload["apm"] == breakdown["player_stats"]["me"]["apm"] == me_curve["avg_apm"]
    opp_curve = next(p for p in payload["apmCurve"]["players"] if not p["is_me"])
    assert breakdown["player_stats"]["opponent"]["apm"] == opp_curve["avg_apm"]
    assert isinstance(payload.get("spq"), float) and payload["spq"] >= 0
    assert payload["spq"] == pytest.approx(breakdown["raw"]["sq"], abs=0.01)
