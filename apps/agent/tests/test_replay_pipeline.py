"""Tests for replay_pipeline._resolve_pulse_character_id.

The full ``parse_replay_for_cloud`` happy path needs sc2reader and a
real .SC2Replay fixture; that integration coverage lives in the agent's
end-to-end harness. Here we lock down the small deterministic helpers
that decide what the cloud receives in the opponent block:

  - ``_resolve_pulse_character_id`` — returns ``None`` for unresolvable
    inputs (no handle, malformed handle, resolver returning None) and
    forwards the resolved id when the resolver returns one.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest


# Make the agent package importable without an installed wheel.
HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))


@pytest.fixture(autouse=True)
def _stub_pulse_resolver(monkeypatch):
    """Inject a fake ``core.pulse_resolver`` so we never hit the network.

    The real resolver lives in ``reveal-sc2-opponent-main/core/`` and is
    added to sys.path by ``replay_pipeline._ensure_analyzer_on_path``.
    Replacing it with a stub keeps these tests hermetic and fast.
    """
    calls: list[tuple[str | None, str]] = []

    class _StubModule:
        @staticmethod
        def resolve_pulse_id_by_toon(handle, name):
            calls.append((handle, name))
            if handle == "1-S2-1-267727":
                return "994428"
            if handle == "1-S2-1-RAISES":
                raise RuntimeError("simulated network blip")
            return None

    monkeypatch.setitem(sys.modules, "core.pulse_resolver", _StubModule)
    yield calls


def _make_opp(handle: str | None, name: str = "ReSpOnSe") -> SimpleNamespace:
    return SimpleNamespace(handle=handle, name=name)


def test_resolves_real_toon_handle_to_sc2pulse_character_id(_stub_pulse_resolver):
    from sc2tools_agent.replay_pipeline import _resolve_pulse_character_id

    out = _resolve_pulse_character_id(_make_opp("1-S2-1-267727"))
    assert out == "994428"


def test_strips_clan_tag_prefix_before_lookup(_stub_pulse_resolver):
    from sc2tools_agent.replay_pipeline import _resolve_pulse_character_id

    _resolve_pulse_character_id(_make_opp("1-S2-1-267727", name="[CLAN]ReSpOnSe"))
    # The stub records the cleaned name, not the prefixed one.
    assert _stub_pulse_resolver[-1][1] == "ReSpOnSe"


def test_returns_none_when_handle_is_missing(_stub_pulse_resolver):
    from sc2tools_agent.replay_pipeline import _resolve_pulse_character_id

    assert _resolve_pulse_character_id(_make_opp(None)) is None
    assert _resolve_pulse_character_id(_make_opp("")) is None
    # No resolver call should have been made for an empty handle.
    assert _stub_pulse_resolver == []


def test_returns_none_when_resolver_misses(_stub_pulse_resolver):
    from sc2tools_agent.replay_pipeline import _resolve_pulse_character_id

    out = _resolve_pulse_character_id(_make_opp("2-S2-1-9999999", name="Anon"))
    assert out is None


def test_swallows_resolver_exceptions(_stub_pulse_resolver):
    from sc2tools_agent.replay_pipeline import _resolve_pulse_character_id

    # The resolver stub raises for this handle. The pipeline must
    # log and return None — never propagate, since a transient outage
    # cannot be allowed to break the upload path.
    assert _resolve_pulse_character_id(_make_opp("1-S2-1-RAISES")) is None




# -------------------------------------------------------------------------
# Toon-handle path extraction & by-toon player resolution.
#
# These exist to lock down the v0.3.5 fallback that fires when the
# user-supplied ``my_handle`` substring match fails. Without them, an
# unset/stale battleTag silently turns every upload into a no-op
# (the failure mode that left ``state.uploaded`` empty in v0.3.4).
# -------------------------------------------------------------------------


def test_toon_handle_from_path_finds_token_in_sc2_layout():
    from sc2tools_agent.replay_pipeline import _toon_handle_from_path

    p = Path(
        "C:/Users/x/OneDrive/Pictures/Documents/StarCraft II/Accounts/"
        "50983875/1-S2-1-267727/Replays/Multiplayer/foo.SC2Replay"
    )
    assert _toon_handle_from_path(p) == "1-S2-1-267727"


def test_toon_handle_from_path_returns_none_when_not_in_sc2_layout():
    from sc2tools_agent.replay_pipeline import _toon_handle_from_path

    assert _toon_handle_from_path(Path("C:/random/dir/file.SC2Replay")) is None
    # An account-level path (no toon segment) must also miss — the
    # fallback can't disambiguate "us" without the toon component.
    assert (
        _toon_handle_from_path(
            Path("C:/x/StarCraft II/Accounts/50983875/Replays/foo.SC2Replay"),
        )
        is None
    )


def test_resolve_by_toon_picks_matching_player_and_other_as_opponent():
    from sc2tools_agent.replay_pipeline import _resolve_by_toon

    players = [
        SimpleNamespace(name="OtherGuy", handle="1-S2-1-9999", is_observer=False),
        SimpleNamespace(name="Me", handle="1-S2-1-267727", is_observer=False),
    ]
    me, opp = _resolve_by_toon(players, "1-S2-1-267727")
    assert me is not None and me.name == "Me"
    assert opp is not None and opp.name == "OtherGuy"


def test_resolve_by_toon_skips_observers():
    from sc2tools_agent.replay_pipeline import _resolve_by_toon

    players = [
        SimpleNamespace(
            name="Caster", handle="1-S2-1-267727", is_observer=True,
        ),
        SimpleNamespace(name="Me", handle="1-S2-1-267727", is_observer=False),
        SimpleNamespace(name="Opp", handle="1-S2-1-1234", is_observer=False),
    ]
    me, opp = _resolve_by_toon(players, "1-S2-1-267727")
    assert me is not None and me.name == "Me"
    assert opp is not None and opp.name == "Opp"


def test_resolve_by_toon_returns_none_when_no_match():
    from sc2tools_agent.replay_pipeline import _resolve_by_toon

    players = [
        SimpleNamespace(name="A", handle="1-S2-1-1", is_observer=False),
        SimpleNamespace(name="B", handle="1-S2-1-2", is_observer=False),
    ]
    me, opp = _resolve_by_toon(players, "1-S2-1-267727")
    assert me is None
    # opp can be set or not — only ``me is None`` fails the upload
    # path; the surrounding caller bails before using opp.


def test_pulse_timeout_does_not_block_caller(monkeypatch, _stub_pulse_resolver):
    """v0.3.10 regression: the timeout fired but the caller still
    blocked because ``concurrent.futures.ThreadPoolExecutor`` inside
    a ``with`` block calls ``shutdown(wait=True)`` on exit. v0.3.11
    rewrote the wrapper to use a daemon thread that gets abandoned
    on timeout, so the parse pipeline never waits for a stuck
    sc2pulse call to actually finish.
    """
    import sys
    import time
    from types import SimpleNamespace

    class _SlowModule:
        @staticmethod
        def resolve_pulse_id_by_toon(handle, name):
            time.sleep(3)  # well above the 0.2 s cap below
            return "should_never_reach_caller"

    monkeypatch.setitem(sys.modules, "core.pulse_resolver", _SlowModule)
    monkeypatch.setenv("SC2TOOLS_PULSE_TIMEOUT_SEC", "0.2")

    from sc2tools_agent.replay_pipeline import _resolve_pulse_character_id

    started = time.monotonic()
    out = _resolve_pulse_character_id(
        SimpleNamespace(handle="1-S2-1-267727", name="ReSpOnSe"),
    )
    elapsed = time.monotonic() - started
    assert out is None
    # Caller must return well under 1 s even though the stub sleeps 3 s.
    assert elapsed < 1.0, (
        f"timeout did not unblock the caller (elapsed {elapsed:.2f}s)"
    )


# -------------------------------------------------------------------------
# CloudGame.to_payload — locks down the wire shape for /v1/games. The web
# app's Activity tab and macro-breakdown drilldown both depend on the new
# macroBreakdown / apmCurve fields being passed through verbatim.
# -------------------------------------------------------------------------


def _bare_cloud_game(**overrides):
    from sc2tools_agent.replay_pipeline import CloudGame

    base = dict(
        game_id="g1",
        date_iso="2026-05-04T12:00:00+00:00",
        result="Victory",
        my_race="Protoss",
        my_build=None,
        map_name="Goldenaura",
        duration_sec=600,
        macro_score=None,
        apm=None,
        spq=None,
        opponent=None,
        build_log=[],
        early_build_log=[],
        opp_early_build_log=[],
        opp_build_log=[],
    )
    base.update(overrides)
    return CloudGame(**base)


def test_to_payload_omits_macro_breakdown_when_unset():
    payload = _bare_cloud_game().to_payload()
    assert "macroBreakdown" not in payload
    assert "apmCurve" not in payload


def test_to_payload_includes_macro_breakdown_and_apm_curve_when_set():
    breakdown = {
        "raw": {"sq": 75},
        "all_leaks": [],
        "top_3_leaks": [],
        "stats_events": [{"time": 60, "minerals_current": 50}],
        "opp_stats_events": [],
    }
    curve = {
        "window_sec": 30,
        "has_data": True,
        "players": [{"pid": 1, "name": "me", "race": "Protoss", "samples": []}],
    }
    payload = _bare_cloud_game(
        macro_breakdown=breakdown,
        apm_curve=curve,
    ).to_payload()
    assert payload["macroBreakdown"] is breakdown
    assert payload["apmCurve"] is curve


def test_probe_analyzer_succeeds_in_source_layout():
    """In the canonical source layout the bundled analyzer is on disk
    next to apps/agent/, so probe_analyzer must succeed. If this
    starts failing, either the worktree is missing
    ``reveal-sc2-opponent-main/`` or ``_ensure_analyzer_on_path``
    regressed — both block every replay upload, so we want CI to
    catch it loudly."""
    from sc2tools_agent.replay_pipeline import probe_analyzer

    ok, diag = probe_analyzer()
    assert ok, f"probe_analyzer failed in source layout: {diag}"
    assert diag is None
