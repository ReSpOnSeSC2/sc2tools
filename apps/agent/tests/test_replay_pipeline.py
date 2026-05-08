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


def test_to_payload_emits_my_toon_handle_when_set():
    """The cloud session-widget Tier-3 MMR fallback resolves the
    streamer's current 1v1 ladder rating from SC2Pulse using whatever
    toon handle the agent forwarded. If we ever stop emitting
    ``myToonHandle`` on the wire, the fallback can't fire and the
    streamer's overlay shows ``EU —`` again."""
    payload = _bare_cloud_game(my_toon_handle="2-S2-1-99999").to_payload()
    assert payload["myToonHandle"] == "2-S2-1-99999"


def test_to_payload_omits_my_toon_handle_when_unset():
    """Pre-cutover replays (no `me.handle`) must still upload — the
    field is optional both on the agent side and the cloud schema."""
    payload = _bare_cloud_game().to_payload()
    assert "myToonHandle" not in payload


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


def test_load_sc2ra_module_skips_reveal_copy_pre_registered_in_sys_modules(
    monkeypatch,
):
    """v0.5.1 production regression: ``parse_deep`` is imported from
    ``core.sc2_replay_parser`` at the top of every parse. That module's
    own ``from .event_extractor import …`` registers the
    reveal-sc2-opponent-main copy at ``sys.modules['core.event_extractor']``
    BEFORE ``_compute_macro_breakdown`` runs. The reveal copy's
    extractor has signature ``(replay, my_pid)`` (no ``opp_pid``), so
    ``extract_macro_events(replay, me.pid, opp_pid)`` raises TypeError
    and the breakdown silently fails — exactly the "Macro breakdown not
    available for this game yet" empty state the user sees on the SPA.

    The loader must detect when the cached entry is the reveal copy
    (``__file__`` containing ``reveal-sc2-opponent-main``) and skip it,
    falling through to disk load from ``SC2Replay-Analyzer/``.
    """
    import sys
    from types import ModuleType

    # Build a fake "real" reveal module — has __file__ pointing into the
    # reveal directory, just like the one Python's import machinery
    # produces when reveal's relative-import chain runs.
    fake_reveal = ModuleType("core.event_extractor")
    fake_reveal.__file__ = (
        r"C:\repo\reveal-sc2-opponent-main\core\event_extractor.py"
    )
    # Wrong signature on purpose — if the loader returns this, the
    # production code will fail with TypeError later.
    fake_reveal.extract_macro_events = lambda replay, my_pid: {}
    monkeypatch.setitem(sys.modules, "core.event_extractor", fake_reveal)
    # And drop the private cache key so we test the cold-load path.
    monkeypatch.delitem(
        sys.modules, "_sc2ra_core_event_extractor", raising=False,
    )

    from sc2tools_agent.replay_pipeline import _load_sc2ra_module

    mod = _load_sc2ra_module("core.event_extractor")
    # Loader must NOT return the reveal stub.
    assert mod is not fake_reveal, (
        "loader returned the reveal copy that was already in sys.modules — "
        "this is the v0.5.1 regression that broke macro breakdown for "
        "every uploaded replay"
    )
    # And the resolved module must be the SC2Replay-Analyzer copy.
    file_attr = getattr(mod, "__file__", "") or ""
    assert "SC2Replay-Analyzer" in file_attr, (
        f"loader returned an unexpected module: {file_attr!r}"
    )
    # The v0.5+ Analyzer copy has the ``opp_pid`` parameter — without
    # it the agent's three-arg call raises TypeError.
    import inspect
    sig = inspect.signature(mod.extract_macro_events)
    assert "opp_pid" in sig.parameters


def test_load_sc2ra_module_honors_test_stubs_without_file(monkeypatch):
    """Test stubs (SimpleNamespace, MagicMock, ad-hoc classes) don't
    have a ``__file__`` attribute. The loader must honor those so
    existing monkeypatch-based tests keep working — only modules
    pointing at the real reveal directory should be skipped.
    """
    import sys
    from types import SimpleNamespace

    sentinel = SimpleNamespace(extract_macro_events=lambda *a, **kw: "stub")
    monkeypatch.setitem(sys.modules, "core.event_extractor", sentinel)
    monkeypatch.delitem(
        sys.modules, "_sc2ra_core_event_extractor", raising=False,
    )

    from sc2tools_agent.replay_pipeline import _load_sc2ra_module

    mod = _load_sc2ra_module("core.event_extractor")
    assert mod is sentinel


def test_load_sc2ra_module_uses_internal_cache_on_repeat_calls(
    monkeypatch,
):
    """Once the loader has resolved a module from disk, subsequent
    calls must come from the private ``_sc2ra_*`` cache so a later
    ``from core.event_extractor import build_log_lines`` (which
    repopulates ``sys.modules['core.event_extractor']`` with reveal's
    copy) doesn't undo the first resolution.
    """
    import sys
    from types import ModuleType

    monkeypatch.delitem(
        sys.modules, "_sc2ra_core_event_extractor", raising=False,
    )
    monkeypatch.delitem(sys.modules, "core.event_extractor", raising=False)

    from sc2tools_agent.replay_pipeline import _load_sc2ra_module

    first = _load_sc2ra_module("core.event_extractor")
    # Now simulate reveal contaminating sys.modules AFTER our first
    # resolve — exactly what build_log_lines's import does. Use
    # monkeypatch.setitem so the entry is reverted at test teardown
    # and doesn't leak into the next test's sys.modules.
    fake_reveal = ModuleType("core.event_extractor")
    fake_reveal.__file__ = (
        r"C:\repo\reveal-sc2-opponent-main\core\event_extractor.py"
    )
    fake_reveal.extract_macro_events = lambda *a: {}
    monkeypatch.setitem(sys.modules, "core.event_extractor", fake_reveal)

    second = _load_sc2ra_module("core.event_extractor")
    assert second is first, (
        "private _sc2ra_* cache must shield us from later sys.modules "
        "pollution by reveal's relative imports"
    )


# -------------------------------------------------------------------------
# Opponent build-log derivation — _build_log_from_events.
#
# These guard against the v0.4.0 regression where the agent shipped
# empty oppBuildLog arrays even though the strategy detector had clearly
# walked the same opp_events stream. The SPA shows
# "No opponent build extracted yet" whenever the array is empty, so a
# silent failure here is a user-visible bug.
# -------------------------------------------------------------------------


def test_build_log_from_events_formats_buildings_and_units():
    from sc2tools_agent.replay_pipeline import _build_log_from_events

    events = [
        {"type": "building", "name": "Nexus", "time": 0},
        {"type": "building", "name": "Pylon", "time": 17},
        {"type": "building", "name": "Gateway", "time": 49},
        {"type": "unit", "name": "Probe", "time": 12},
        {"type": "unit", "name": "Zealot", "time": 95},
        {"type": "upgrade", "name": "WarpGateResearch", "time": 240},
    ]
    full, early = _build_log_from_events(events)
    # Full log includes everything, sorted by time.
    assert full[0] == "[0:00] Nexus"
    assert "[0:12] Probe" in full
    assert "[1:35] Zealot" in full
    assert "[4:00] WarpGateResearch" in full
    # Early log caps at 5:00 (300s) — same as the user-build cutoff.
    assert all("[5:" not in line and "[6:" not in line for line in early)
    # And shorter than the full log when any events exist past 5:00.
    assert len(early) <= len(full)


def test_build_log_from_events_empty_input_returns_empty_lists():
    from sc2tools_agent.replay_pipeline import _build_log_from_events

    assert _build_log_from_events(None) == ([], [])
    assert _build_log_from_events([]) == ([], [])


def test_build_log_from_events_swallows_formatter_exceptions(monkeypatch):
    """Formatter blowing up on a malformed event must not propagate.

    The watcher uploads each replay independently; one corrupt
    opp_events stream cannot be allowed to fail the rest of the
    upload pipeline. Verify the catcher is in place by stubbing
    ``build_log_lines`` to raise.
    """
    import sys

    class _Boom:
        @staticmethod
        def build_log_lines(*_args, **_kwargs):
            raise RuntimeError("synthetic_failure")

    monkeypatch.setitem(sys.modules, "core.event_extractor", _Boom)
    from sc2tools_agent.replay_pipeline import _build_log_from_events

    full, early = _build_log_from_events(
        [{"type": "building", "name": "Pylon", "time": 17}],
    )
    assert full == []
    assert early == []


# -------------------------------------------------------------------------
# parse_replay_for_cloud end-to-end via mocked parse_deep.
#
# Mock the deep-parse step so the test never touches sc2reader or a real
# .SC2Replay binary. Asserts that the wire payload carries the rich
# structured outputs (macroBreakdown, oppBuildLog, apmCurve) the SPA's
# dual-build timeline + macro drilldown depend on. This is the
# regression test that catches v0.4.0 features silently breaking — if
# any one of the four fail-soft branches (imports / extract / score /
# format) starts swallowing too much, this test fails loudly.
# -------------------------------------------------------------------------


def test_parse_replay_for_cloud_emits_macro_breakdown_and_opp_build_log(
    monkeypatch, tmp_path,
):
    import sys
    from types import SimpleNamespace

    # ---- Mock parse_deep so we don't need a real .SC2Replay file. ----
    me = SimpleNamespace(
        pid=1, name="Me", race="Protoss", result="Win",
        handle="1-S2-1-267727", mmr=4500, apm=180.0, spq=82.0,
    )
    opp = SimpleNamespace(
        pid=2, name="Opp", race="Zerg", result="Loss",
        handle="1-S2-2-690921", mmr=4400, league_id=5,
    )
    # build_log lines for the user's perspective.
    user_lines = [
        "[0:00] Nexus",
        "[0:17] Pylon",
        "[0:49] Gateway",
        "[1:43] CyberneticsCore",
    ]
    # opp_events is what the agent re-formats into oppBuildLog +
    # oppEarlyBuildLog. The strategy detector also reads this list,
    # so both fields must be populated together for a realistic
    # parse.
    opp_events = [
        {"type": "building", "name": "Hatchery", "time": 0},
        {"type": "building", "name": "SpawningPool", "time": 50},
        {"type": "building", "name": "Hatchery", "time": 100},
        {"type": "unit", "name": "Drone", "time": 12},
        {"type": "building", "name": "Lair", "time": 380},
    ]
    fake_ctx = SimpleNamespace(
        game_id="2026-05-06T17:48:32|Opp|Goldenaura|600",
        date_iso="2026-05-06T17:48:32",
        map_name="Goldenaura",
        length_seconds=600,
        is_ai_game=False,
        me=me,
        opponent=opp,
        all_players=[me, opp],
        my_events=[],
        opp_events=opp_events,
        my_build="PvP - 4 Adept/Oracle",
        opp_strategy="Zerg - 3 Base Macro (Hatch First)",
        build_log=user_lines,
        early_build_log=user_lines[:3],
        # Older parsers (v0.3.x) never populated these — agent has to
        # derive them from opp_events. Setting them to empty here
        # exercises the fallback path that was missing in v0.3.11.
        opp_build_log=[],
        opp_early_build_log=[],
        macro_score=None,
        raw=object(),  # any non-None placeholder; the macro / apm
                       # extractors below are stubbed and never read it
        file_path=str(tmp_path / "fake.SC2Replay"),
    )

    def _fake_parse_deep(_path, _handle):
        return fake_ctx

    monkeypatch.setitem(
        sys.modules,
        "core.sc2_replay_parser",
        SimpleNamespace(parse_deep=_fake_parse_deep),
    )

    # ---- Mock extract_macro_events / compute_macro_score. ----
    # Signature mirrors the v0.5+ SC2Replay-Analyzer extractor:
    # ``(replay, my_pid, opp_pid=None)`` returning ``opp_stats_events``
    # and ``unit_timeline`` alongside the my-side samples. The agent's
    # _compute_macro_breakdown now passes both pids in one call so the
    # composition snapshot can render both sides without a second walk.
    def _fake_extract(_replay, _pid, _opp_pid=None):
        return {
            "stats_events": [
                {"time": 0, "food_used": 12, "food_made": 15,
                 "minerals_current": 50, "vespene_current": 0,
                 "food_workers": 12, "minerals_collection_rate": 0,
                 "vespene_collection_rate": 0},
                {"time": 60, "food_used": 22, "food_made": 23,
                 "minerals_current": 250, "vespene_current": 100,
                 "food_workers": 18, "minerals_collection_rate": 800,
                 "vespene_collection_rate": 50},
            ],
            "opp_stats_events": [
                {"time": 0, "food_used": 12, "food_workers": 12},
                {"time": 60, "food_used": 21, "food_workers": 17},
            ],
            "unit_timeline": [
                {"time": 0, "my": {}, "opp": {}},
                {"time": 60, "my": {"Zealot": 1}, "opp": {"Zergling": 6}},
            ],
            "player_stats": {},
            "ability_events": [],
            "production_buildings": [],
            "bases": [],
            "unit_births": [],
            "game_length_sec": 600,
        }

    def _fake_compute(_macro, _race, _length):
        return {
            "macro_score": 78,
            "raw": {"sq": 80.0, "base_score": 75.0,
                     "supply_block_penalty": 1.0, "race_penalty": 2.0,
                     "float_penalty": 0.0,
                     "chronos_actual": 5, "chronos_expected": 8},
            "all_leaks": [
                {"name": "Chrono Efficiency", "detail": "5/8 expected",
                 "penalty": 2.0, "mineral_cost": 200, "quantity": 3},
            ],
            "top_3_leaks": [
                {"name": "Chrono Efficiency", "detail": "5/8 expected",
                 "penalty": 2.0, "mineral_cost": 200, "quantity": 3},
            ],
        }

    monkeypatch.setitem(
        sys.modules,
        "core.event_extractor",
        SimpleNamespace(
            extract_macro_events=_fake_extract,
            build_log_lines=__import__(
                "core.event_extractor", fromlist=["build_log_lines"],
            ).build_log_lines,
        ),
    )
    monkeypatch.setitem(
        sys.modules,
        "analytics.macro_score",
        SimpleNamespace(compute_macro_score=_fake_compute),
    )

    # ---- Drive the pipeline. ----
    from pathlib import Path
    from sc2tools_agent.replay_pipeline import parse_replay_for_cloud
    fake_path = tmp_path / "fake.SC2Replay"
    fake_path.write_bytes(b"")  # parse_deep is mocked, so binary content unused
    result = parse_replay_for_cloud(fake_path, player_handle="Me")

    assert result is not None, "parse_replay_for_cloud must succeed for a happy-path replay"
    payload = result.to_payload()

    # ---- The two regressions we're locking down. ----
    assert "macroBreakdown" in payload, (
        "macroBreakdown missing from upload — SPA renders empty "
        "'Macro breakdown not available' state when this happens. "
        "Check _compute_macro_breakdown's fail-soft branches in "
        "replay_pipeline.py (look for WARNING-level logs)."
    )
    mb = payload["macroBreakdown"]
    assert isinstance(mb.get("top_3_leaks"), list)
    assert len(mb["top_3_leaks"]) >= 1
    assert isinstance(mb.get("all_leaks"), list)
    assert isinstance(mb.get("stats_events"), list)
    assert len(mb["stats_events"]) >= 1
    assert "raw" in mb

    assert payload["oppBuildLog"], (
        "oppBuildLog empty — SPA's dual build timeline shows "
        "'No opponent build extracted yet' when this happens. "
        "Check _build_log_from_events / opp_events derivation in "
        "replay_pipeline.py (look for WARNING-level logs)."
    )
    # The first opponent event was a Hatchery at t=0 — must surface
    # in the formatted build log so the dual-build timeline can
    # render the opponent's opening.
    assert any("Hatchery" in line for line in payload["oppBuildLog"])
    # earlyBuildLog / oppEarlyBuildLog were intentionally removed
    # from the wire shape in v0.4.3 — they are derived server-side
    # from the full logs at read time. The payload MUST NOT carry
    # them; the API ingest path also $unsets any legacy stored copy.
    assert "earlyBuildLog" not in payload
    assert "oppEarlyBuildLog" not in payload

    # macroScore from the stub bubbles up as the headline number even
    # though ctx.macro_score was None.
    assert payload["macroScore"] == 78


def _minutes_in(line: str) -> int:
    """Pull the [m:ss] minute prefix out of a build-log line."""
    import re
    m = re.match(r"^\[(\d+):", line)
    return int(m.group(1)) if m else 0


# -------------------------------------------------------------------------
# Build-log truncation — caps both buildLog/oppBuildLog at 5000 entries
# and earlyBuildLog/oppEarlyBuildLog at 1000 to match the API's AJV
# schema (apps/api/src/validation/gameRecord.js). Without this, long
# Zerg replays produce 8k–14k opp_build_log lines and the upload is
# silently rejected with "/oppBuildLog must NOT have more than 5000
# items"; the queue then re-tries the same payload forever, fills up,
# and drops every subsequent replay. This test locks the cap down on
# both code paths (ctx.build_log direct + opp_events derivation).
# -------------------------------------------------------------------------


def test_parse_replay_for_cloud_caps_build_logs_to_schema_limits(
    monkeypatch, tmp_path,
):
    import sys
    from types import SimpleNamespace

    from sc2tools_agent.replay_pipeline import (
        _BUILD_LOG_CAP, _EARLY_BUILD_LOG_CAP,
    )

    me = SimpleNamespace(
        pid=1, name="Me", race="Zerg", result="Win",
        handle="1-S2-1-267727", mmr=4500, apm=180.0, spq=82.0,
    )
    opp = SimpleNamespace(
        pid=2, name="Opp", race="Zerg", result="Loss",
        handle="1-S2-2-690921", mmr=4400, league_id=5,
    )
    # Simulate a long ZvZ where ctx.build_log is huge (would normally
    # come from build_log_lines(my_events) — we hand it directly so
    # the test doesn't depend on sc2reader event types).
    huge_my_lines = [f"[0:{i:02d}] Zergling" for i in range(60)] + [
        f"[1:{i:02d}] Zergling" for i in range(60)
    ]
    # Pad way past the cap so [:_BUILD_LOG_CAP] actually truncates.
    huge_my_lines = (
        huge_my_lines * (max(1, (_BUILD_LOG_CAP * 2) // len(huge_my_lines)) + 1)
    )
    assert len(huge_my_lines) > _BUILD_LOG_CAP, (
        "test fixture must exceed cap to exercise truncation"
    )
    huge_my_early = huge_my_lines[:1500]  # exceeds 1000 cap

    # opp_events at >5000 entries forces the derived opp_build_log
    # path through the cap too. Mix in some event times beyond 5:00
    # so the early-log truncation has events to drop.
    opp_events = [
        {"type": "unit", "name": "Zergling", "time": min(t, 1799)}
        for t in range(_BUILD_LOG_CAP + 500)
    ]

    fake_ctx = SimpleNamespace(
        game_id="2026-05-06T17:48:32|Opp|Goldenaura|1800",
        date_iso="2026-05-06T17:48:32",
        map_name="Goldenaura",
        length_seconds=1800,
        is_ai_game=False,
        me=me,
        opponent=opp,
        all_players=[me, opp],
        my_events=[],
        opp_events=opp_events,
        my_build="ZvZ - Macro",
        opp_strategy="ZvZ - Macro",
        build_log=huge_my_lines,
        early_build_log=huge_my_early,
        opp_build_log=[],
        opp_early_build_log=[],
        macro_score=None,
        raw=None,  # disables _compute_macro_breakdown / _compute_apm_curve
                   # — we only care about build-log truncation here
        file_path=str(tmp_path / "fake.SC2Replay"),
    )

    monkeypatch.setitem(
        sys.modules,
        "core.sc2_replay_parser",
        SimpleNamespace(parse_deep=lambda _p, _h: fake_ctx),
    )

    from pathlib import Path
    from sc2tools_agent.replay_pipeline import parse_replay_for_cloud
    fake_path = tmp_path / "fake.SC2Replay"
    fake_path.write_bytes(b"")
    result = parse_replay_for_cloud(fake_path, player_handle="Me")
    assert result is not None
    payload = result.to_payload()

    # Server's AJV schema rejects anything past these caps; assert each
    # field is at or under its limit.
    assert len(payload["buildLog"]) <= _BUILD_LOG_CAP
    assert len(payload["oppBuildLog"]) <= _BUILD_LOG_CAP
    # And specifically — the buildLog must be truncated (not just
    # silently shrunk) when the input exceeds the cap. Truncation
    # keeps the EARLIEST entries because build_log_lines emits them
    # sorted ascending by time.
    assert len(payload["buildLog"]) == _BUILD_LOG_CAP
    assert len(payload["oppBuildLog"]) == _BUILD_LOG_CAP
    # earlyBuildLog / oppEarlyBuildLog were dropped from the wire in
    # v0.4.3 — they're derived server-side from the full logs.
    assert "earlyBuildLog" not in payload
    assert "oppEarlyBuildLog" not in payload


# -------------------------------------------------------------------------
# stats_events downsampling — v0.4.3 storage trim. sc2reader emits
# PlayerStatsEvent every ~10 s, but the SPA's resource/army charts
# render at 30 s resolution at most. Keeping all 10 s samples doubles
# per-doc storage on the 30k-game-and-up scale we're targeting, so the
# agent now keeps only the FIRST event in each 30 s game-time bucket
# before shipping the macroBreakdown payload. macro_score is computed
# on the FULL stream first so leak detection / SQ / penalties are
# unaffected.
# -------------------------------------------------------------------------


def test_downsample_stats_events_keeps_first_per_30s_bucket():
    from sc2tools_agent.replay_pipeline import (
        _downsample_stats_events,
        _STATS_EVENTS_BUCKET_SEC,
    )
    assert _STATS_EVENTS_BUCKET_SEC == 30  # locked to chart resolution
    # 10 s cadence input, 0..120 s — buckets are [0,30), [30,60),
    # [60,90), [90,120), [120,150) so we expect t=0, 30, 60, 90, 120.
    events = [{"time": t, "food_used": t} for t in range(0, 130, 10)]
    out = _downsample_stats_events(events)
    assert [e["time"] for e in out] == [0, 30, 60, 90, 120]


def test_downsample_stats_events_handles_empty_and_none():
    from sc2tools_agent.replay_pipeline import _downsample_stats_events
    assert _downsample_stats_events([]) == []
    assert _downsample_stats_events(None) == []


def test_downsample_stats_events_skips_malformed_time():
    from sc2tools_agent.replay_pipeline import _downsample_stats_events
    # A row with no time (or a non-numeric one) shouldn't crash —
    # sc2reader has been seen emitting malformed PlayerStatsEvents on
    # broken replays. We skip those rows rather than fail the upload.
    events = [
        {"time": 0, "food_used": 1},
        {"food_used": 2},                    # missing time
        {"time": "garbage", "food_used": 3},  # unparseable time
        {"time": 35, "food_used": 4},        # bucket 1
    ]
    out = _downsample_stats_events(events)
    assert [e["food_used"] for e in out] == [1, 4]
