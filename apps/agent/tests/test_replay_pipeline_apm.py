"""Regression tests for per-player APM attribution and the slim apm/spq fields.

Two bugs shipped together until agent 0.17.2:

  - ``_compute_apm_curve`` compared sc2reader's game-event ``ev.pid`` (a
    0-indexed *user* id) with ``player.pid`` (a 1-indexed slot). Slot 1
    was credited with slot 2's actions and slot 2 always showed zero.
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


def _curve(pid, apms):
    return {"players": [{"pid": pid, "samples": [{"apm": a, "spm": 0} for a in apms]}]}


def test_my_average_apm_skips_idle_windows():
    from sc2tools_agent.replay_pipeline import _my_average_apm

    assert _my_average_apm(_curve(1, [60, 120, 0]), 1) == 90.0


def test_my_average_apm_is_none_without_data_or_for_other_pid():
    from sc2tools_agent.replay_pipeline import _my_average_apm

    assert _my_average_apm(None, 1) is None
    assert _my_average_apm(_curve(1, [60]), None) is None
    assert _my_average_apm(_curve(2, [60]), 1) is None
    assert _my_average_apm(_curve(1, [0, 0]), 1) is None


def test_my_average_apm_omits_values_the_api_schema_would_reject():
    from sc2tools_agent.replay_pipeline import _my_average_apm

    assert _my_average_apm(_curve(1, [5001.0]), 1) is None


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


def _commands_by_slot(replay):
    from sc2reader.events.game import CommandEvent

    counts = {}
    for ev in replay.events:
        if isinstance(ev, CommandEvent):
            slot = getattr(getattr(ev, "player", None), "pid", None)
            counts[slot] = counts.get(slot, 0) + 1
    return counts


def _curve_commands(curve):
    window = curve["window_sec"]
    return {
        p["pid"]: round(sum(s["apm"] for s in p["samples"]) * window / 60)
        for p in curve["players"]
    }


@pytest.mark.parametrize("perspective", ["ReSpOnSe", "Squirtuoz"])
def test_apm_curve_credits_each_player_with_their_own_commands(perspective):
    _require_real_parser()
    from core.sc2_replay_parser import parse_deep  # type: ignore
    from sc2tools_agent.replay_pipeline import _compute_apm_curve

    ctx = parse_deep(str(FIXTURE_REPLAY), perspective)
    expected = _commands_by_slot(ctx.raw)
    curve = _compute_apm_curve(ctx)

    assert curve is not None and curve["has_data"] is True
    got = _curve_commands(curve)
    assert got[ctx.me.pid] == expected[ctx.me.pid]
    assert got[ctx.opponent.pid] == expected[ctx.opponent.pid]
    # Both players commanded units; neither side may read zero.
    assert all(total > 0 for total in got.values())


def test_uploaded_game_carries_consistent_apm_and_spq():
    _require_real_parser()
    from sc2tools_agent.replay_pipeline import parse_replay_for_cloud_ex

    game, reason = parse_replay_for_cloud_ex(
        FIXTURE_REPLAY, player_handle="ReSpOnSe", resolve_pulse=False,
    )
    assert reason is None and game is not None
    payload = game.to_payload()
    breakdown = payload["macroBreakdown"]

    assert isinstance(payload.get("apm"), float) and payload["apm"] > 0
    assert payload["apm"] == breakdown["player_stats"]["me"]["apm"]
    assert isinstance(payload.get("spq"), float) and payload["spq"] >= 0
    assert payload["spq"] == pytest.approx(breakdown["raw"]["sq"], abs=0.01)
