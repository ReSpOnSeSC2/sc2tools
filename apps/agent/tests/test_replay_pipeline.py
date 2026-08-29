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


def test_spatial_proxy_extract_uses_two_arg_perspective_and_shared_playback(
    monkeypatch,
):
    """Proxy evidence comes from build-log events and reuses one replay walk."""
    import sc2tools_agent.replay_pipeline as pipeline

    calls: list[tuple[str, str]] = []
    playback = {
        "map_name": "Boundary Test",
        "game_length": 300.0,
        "bounds": {"x_min": 0, "x_max": 200, "y_min": 0, "y_max": 200},
        "spawn_locations": [],
        "extract_stats": {
            "errors": 0, "pid_failed": 147, "proxy_errors": 0,
            "processed": 10,
        },
        "my_events": [
            {"type": "building", "name": "CommandCenter", "time": 0, "x": 10, "y": 10},
            {"type": "building", "name": "Barracks", "time": 60, "x": 40, "y": 10},
            # Exactly 50 is not a proxy; the canonical predicate is strict >.
            {"type": "building", "name": "Factory", "time": 90, "x": 60, "y": 10},
            {"type": "building", "name": "Starport", "time": 120, "x": 61, "y": 10},
            # Spatial playback may retain structures intentionally omitted
            # from buildLog. They stay in the heatmap but cannot become proxy
            # rule evidence because no local/cloud evaluator can match them.
            {"type": "building", "name": "SupplyDepot", "time": 130, "x": 70, "y": 10},
            {"type": "unit", "name": "Marine", "time": 80, "x": 100, "y": 10},
        ],
        "opp_events": [
            {"type": "building", "name": "CommandCenter", "time": 0, "x": 150, "y": 150},
            {"type": "building", "name": "Barracks", "time": 70, "x": 99, "y": 150},
        ],
        # Deliberately conflicting lifecycle names prove proxy evidence uses
        # the canonical event/buildLog source instead of morph-renamed rows.
        "my_buildings": [
            {"name": "OrbitalCommand", "born": 0, "x": 10, "y": 10},
        ],
        "opp_buildings": [],
        "my_stats": [],
        "opp_stats": [],
        "my_units": [],
        "opp_units": [],
        "resources": [],
        "ability_casts": [],
    }

    class PlaybackModule:
        DEFAULT_BOUNDS = playback["bounds"]

        @staticmethod
        def build_playback_data(file_path: str, player_name: str):
            calls.append((file_path, player_name))
            return playback

        @staticmethod
        def detect_battle_markers(*_args):
            return []

    # Use the real replay-engine BaseStrategyDetector implementation so this
    # locks the same >50 geometry as live classification.
    real_detector_mod = pipeline._load_sc2ra_package_module(
        "strategy_detector_base",
    )

    def load_module(name):
        if name == "map_playback_data":
            return PlaybackModule
        if name == "strategy_detector_base":
            return real_detector_mod
        raise AssertionError(name)

    monkeypatch.setattr(pipeline, "_load_sc2ra_package_module", load_module)
    ctx = SimpleNamespace(
        file_path=Path("C:/replays/p2.SC2Replay"),
        me=SimpleNamespace(name="SelectedPlayerTwo", pid=2),
        opponent=SimpleNamespace(name="PlayerOne", pid=1),
    )

    spatial = pipeline._compute_spatial_extract(ctx)
    assert spatial is not None
    assert calls == [(str(ctx.file_path), "SelectedPlayerTwo")]
    assert spatial["map_bounds"] == {
        "minX": 0.0, "minY": 0.0, "maxX": 200.0, "maxY": 200.0,
    }
    assert spatial["my_proxy_classification_v"] == 1
    assert spatial["opp_proxy_classification_v"] == 1
    assert [row["name"] for row in spatial["my_proxies"]] == ["Starport"]
    assert [row["name"] for row in spatial["opp_proxies"]] == ["Barracks"]
    assert [row["name"] for row in spatial["buildings"]] == [
        "CommandCenter", "Barracks", "Factory", "Starport", "SupplyDepot",
    ]

    # The map payload consumes the same cached raw playback; enabling spatial
    # must not double the replay parse cost on a full resync.
    pipeline._compute_map_playback(ctx)
    assert calls == [(str(ctx.file_path), "SelectedPlayerTwo")]

    # A single malformed tracked building makes this side incomplete. It may
    # still render in other playback surfaces, but no v1 coverage stamp can be
    # emitted because negative/count-zero rules must fail closed.
    playback["my_events"].append({
        "type": "building", "name": "Gateway", "time": 140, "x": 80,
    })
    malformed_ctx = SimpleNamespace(
        file_path=Path("C:/replays/malformed.SC2Replay"),
        me=SimpleNamespace(name="SelectedPlayerTwo", pid=2),
        opponent=SimpleNamespace(name="PlayerOne", pid=1),
    )
    malformed = pipeline._compute_spatial_extract(malformed_ctx)
    assert malformed is not None
    assert "my_proxy_classification_v" not in malformed
    assert "my_proxies" not in malformed
    assert malformed["opp_proxy_classification_v"] == 1

    # Partial tracker extraction can hide an unseen proxy. Iterator errors or
    # owner/name resolution failures therefore invalidate both v1 stamps even
    # when the partial lists still contain otherwise valid buildings.
    playback["my_events"].pop()
    playback["my_events"].append({
        "type": "building", "name": "Gateway", "time": 140,
        "x": 0, "y": 80,
    })
    zero_ctx = SimpleNamespace(
        file_path=Path("C:/replays/zero-coordinate.SC2Replay"),
        me=SimpleNamespace(name="SelectedPlayerTwo", pid=2),
        opponent=SimpleNamespace(name="PlayerOne", pid=1),
    )
    zero_geometry = pipeline._compute_spatial_extract(zero_ctx)
    assert zero_geometry is not None
    assert "my_proxy_classification_v" not in zero_geometry
    playback["my_events"].pop()
    for stats in (
        {"errors": 1, "pid_failed": 0, "proxy_errors": 1},
        {"errors": 0, "pid_failed": 1, "proxy_errors": 1},
    ):
        playback["extract_stats"] = stats
        unhealthy_ctx = SimpleNamespace(
            file_path=Path(
                f"C:/replays/unhealthy-{stats['errors']}-"
                f"{stats['proxy_errors']}.SC2Replay",
            ),
            me=SimpleNamespace(name="SelectedPlayerTwo", pid=2),
            opponent=SimpleNamespace(name="PlayerOne", pid=1),
        )
        unhealthy = pipeline._compute_spatial_extract(unhealthy_ctx)
        assert unhealthy is not None
        assert "my_proxy_classification_v" not in unhealthy
        assert "opp_proxy_classification_v" not in unhealthy


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


def test_to_payload_marks_replay_authored_mmr():
    payload = _bare_cloud_game(my_mmr=5378).to_payload()
    assert payload["myMmr"] == 5378
    assert payload["myMmrSource"] == "replay"


def test_to_payload_marks_mmr_as_explicitly_unavailable():
    payload = _bare_cloud_game(my_mmr=None).to_payload()
    assert "myMmr" not in payload
    assert payload["myMmrSource"] == "unavailable"


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


def test_to_payload_keeps_random_ladder_race_separate_from_play_race():
    payload = _bare_cloud_game(my_ladder_race="Random").to_payload()

    assert payload["myRace"] == "Protoss"
    assert payload["myLadderRace"] == "Random"


def test_to_payload_omits_my_ladder_race_when_unset():
    assert "myLadderRace" not in _bare_cloud_game().to_payload()


def test_to_payload_emits_player_count_when_set():
    """Player count remains useful metadata and a safe legacy 1v1
    fallback; normalized matchFormat owns team-vs-FFA classification."""
    payload = _bare_cloud_game(player_count=4).to_payload()
    assert payload["playerCount"] == 4


def test_to_payload_omits_player_count_when_unset():
    """Optional both on the agent and the cloud schema; absent count
    means the cloud records the game as size-unknown."""
    payload = _bare_cloud_game().to_payload()
    assert "playerCount" not in payload


def test_to_payload_emits_match_format_when_set():
    payload = _bare_cloud_game(match_format="ffa").to_payload()
    assert payload["matchFormat"] == "ffa"


def test_to_payload_omits_match_format_when_unset():
    assert "matchFormat" not in _bare_cloud_game().to_payload()


def test_to_payload_emits_is_ladder_game_both_values():
    """Authoritative ladder/custom signal — the cloud prefers it over
    the map-name proxy. Both True and False must survive to the wire
    (a literal ``False`` is meaningful: 'this was a custom game')."""
    assert _bare_cloud_game(is_ladder_game=True).to_payload()["isLadderGame"] is True
    assert _bare_cloud_game(is_ladder_game=False).to_payload()["isLadderGame"] is False


def test_to_payload_omits_is_ladder_game_when_unset():
    """Absent when the replay didn't expose a matchmaking category — the
    cloud falls back to the map-name proxy."""
    assert "isLadderGame" not in _bare_cloud_game().to_payload()


def test_to_payload_emits_exact_game_version_and_build():
    """The cloud must receive replay-header provenance verbatim enough
    to classify patch eras without guessing from the replay date."""
    payload = _bare_cloud_game(
        game_version="5.0.16.97425",
        game_build=97425,
    ).to_payload()
    assert payload["gameVersion"] == "5.0.16.97425"
    assert payload["gameBuild"] == 97425


def test_to_payload_omits_game_version_and_build_when_unset():
    payload = _bare_cloud_game().to_payload()
    assert "gameVersion" not in payload
    assert "gameBuild" not in payload


def test_to_payload_emits_exact_replay_start_time_when_set():
    payload = _bare_cloud_game(
        started_at="2026-05-04T11:50:00Z",
    ).to_payload()

    assert payload["startedAt"] == "2026-05-04T11:50:00Z"


def test_to_payload_omits_replay_start_time_when_unset():
    assert "startedAt" not in _bare_cloud_game().to_payload()


def test_to_payload_emits_resumed_marker_and_sanitized_legacy_ids():
    payload = _bare_cloud_game(
        is_resumed_from_replay=True,
        my_mmr=5378,
        resumed_replay_game_ids=[
            "legacy-one",
            "g1",
            " legacy-two ",
            "legacy-one",
            "",
            123,
        ],
    ).to_payload()

    assert payload["isResumedFromReplay"] is True
    assert payload["resumedReplayGameIds"] == ["legacy-one", "legacy-two"]
    assert "myMmr" not in payload
    assert "myMmrSource" not in payload


@pytest.mark.parametrize(
    ("real_type", "expected"),
    [
        ("1v1", "1v1"),
        ("FFA", "ffa"),
        ("1v1v1", "ffa"),
        ("2v2", "team"),
        ("1v3", "team"),
        ("1v1v2", "team"),
        ("Archon", "other"),
    ],
)
def test_match_format_prefers_observed_real_type(real_type, expected):
    from sc2tools_agent.replay_pipeline import _match_format

    ctx = SimpleNamespace(
        raw=SimpleNamespace(real_type=real_type, game_type="1v1"),
        all_players=[object(), object()],
    )
    assert _match_format(ctx) == expected


def test_match_format_uses_game_type_when_real_type_is_absent():
    from sc2tools_agent.replay_pipeline import _match_format

    ctx = SimpleNamespace(
        raw=SimpleNamespace(real_type="", game_type="2v2"),
        all_players=[object()] * 4,
    )
    assert _match_format(ctx) == "team"


def test_match_format_count_fallback_is_observer_safe_and_conservative():
    from sc2tools_agent.replay_pipeline import _match_format

    # sc2reader keeps observers outside ctx.all_players. Even with an
    # observer on the raw replay, two actual participants remain 1v1.
    observed = SimpleNamespace(
        raw=SimpleNamespace(real_type="", game_type="", observers=[object()]),
        all_players=[object(), object()],
    )
    assert _match_format(observed) == "1v1"

    # A count above two could be either teams or FFA; do not guess.
    unknown_multi = SimpleNamespace(raw=None, all_players=[object()] * 8)
    assert _match_format(unknown_multi) is None


def test_is_ladder_game_prefers_ranked_flags_and_accepts_numeric_values():
    from sc2tools_agent.replay_pipeline import _is_ladder_game

    # Real sc2reader replays expose BitPackedDecoder flags as integer 0/1.
    unranked = SimpleNamespace(
        raw=SimpleNamespace(competitive=0, category="Ladder", amm=1),
    )
    assert _is_ladder_game(unranked) is False

    ranked = SimpleNamespace(
        raw=SimpleNamespace(ranked=1, competitive=0, category="Private", amm=0),
    )
    assert _is_ladder_game(ranked) is True


def test_is_ladder_game_uses_known_category_then_numeric_amm_fallback():
    from sc2tools_agent.replay_pipeline import _is_ladder_game

    assert _is_ladder_game(
        SimpleNamespace(raw=SimpleNamespace(category="Ladder")),
    ) is True
    assert _is_ladder_game(
        SimpleNamespace(raw=SimpleNamespace(category="Private")),
    ) is False
    assert _is_ladder_game(
        SimpleNamespace(raw=SimpleNamespace(category="Unknown", amm=1)),
    ) is True
    assert _is_ladder_game(
        SimpleNamespace(raw=SimpleNamespace(category="", amm=0)),
    ) is False
    assert _is_ladder_game(SimpleNamespace(raw=SimpleNamespace())) is None
    assert _is_ladder_game(SimpleNamespace(raw=None)) is None


# -------------------------------------------------------------------------
# _resolve_my_mmr — streamer's MMR comes through Layer 1 (PlayerInfo.mmr)
# OR Layer 2 (raw sc2reader player). v0.5.5 shipped a no-op fix that read
# ``scaled_rating`` off the PlayerInfo dataclass (which doesn't carry it),
# so the streamer's MMR stayed None whenever the analyzer fell back from
# load_level=4 to 3 — the session widget then painted ``— MMR`` on the
# overlay. Lock down both layers + the unresolved path so we don't
# regress to that failure mode silently.
# -------------------------------------------------------------------------


def _make_pi(handle: str | None = "1-S2-1-267727", *, mmr=None, pid=1):
    """PlayerInfo-shaped duck for these tests."""
    return SimpleNamespace(handle=handle, pid=pid, mmr=mmr)


def test_resolve_my_mmr_layer_1_uses_playerinfo_mmr_when_populated(tmp_path):
    from sc2tools_agent.replay_pipeline import _resolve_my_mmr

    # PlayerInfo.mmr already came from _get_player_mmr (which prefers
    # scaled_rating then mmr from the raw player). When that's set, the
    # raw replay never has to be touched.
    me = _make_pi(mmr=4500)
    ctx = SimpleNamespace(raw=None)
    out = _resolve_my_mmr(ctx, me, file_path=tmp_path / "x.SC2Replay")
    assert out == 4500


def test_resolve_my_mmr_layer_2_reads_raw_player_scaled_rating(tmp_path):
    from sc2tools_agent.replay_pipeline import _resolve_my_mmr

    # PlayerInfo.mmr is None (the legacy v0.5.5 failure mode). The raw
    # sc2reader player still carries scaled_rating from a partial load,
    # and we must surface it so the session widget gets a number.
    me = _make_pi(mmr=None)
    raw_match = SimpleNamespace(
        toon_handle="1-S2-1-267727", pid=1, scaled_rating=4321, mmr=None,
    )
    ctx = SimpleNamespace(raw=SimpleNamespace(players=[raw_match]))
    out = _resolve_my_mmr(ctx, me, file_path=tmp_path / "x.SC2Replay")
    assert out == 4321


def test_resolve_my_mmr_layer_2_reads_sc2reader_1_8_init_data(tmp_path):
    """Match the real pinned sc2reader Participant shape.

    v1.8.0 decodes the rating but leaves it under ``init_data`` instead
    of creating a top-level ``scaled_rating`` attribute.
    """
    from sc2tools_agent.replay_pipeline import _resolve_my_mmr

    me = _make_pi(mmr=None)
    raw_match = SimpleNamespace(
        toon_handle="1-S2-1-267727",
        pid=1,
        init_data={"scaled_rating": 5326},
    )
    ctx = SimpleNamespace(raw=SimpleNamespace(players=[raw_match]))

    out = _resolve_my_mmr(ctx, me, file_path=tmp_path / "x.SC2Replay")

    assert out == 5326


def test_resolve_my_mmr_layer_2_falls_back_to_raw_player_mmr(tmp_path):
    from sc2tools_agent.replay_pipeline import _resolve_my_mmr

    me = _make_pi(mmr=None)
    raw_match = SimpleNamespace(
        toon_handle="1-S2-1-267727", pid=1, scaled_rating=None, mmr=4100,
    )
    ctx = SimpleNamespace(raw=SimpleNamespace(players=[raw_match]))
    out = _resolve_my_mmr(ctx, me, file_path=tmp_path / "x.SC2Replay")
    assert out == 4100


def test_resolve_my_mmr_matches_raw_player_by_pid_when_handle_missing(tmp_path):
    from sc2tools_agent.replay_pipeline import _resolve_my_mmr

    # If the PlayerInfo lost its handle (corrupt cache, observer-only
    # frame), pid is still a unique key within a single replay. We must
    # still find the right raw player.
    me = _make_pi(handle=None, mmr=None, pid=1)
    raw_match = SimpleNamespace(
        toon_handle="1-S2-1-267727", pid=1, scaled_rating=4900, mmr=None,
    )
    other = SimpleNamespace(
        toon_handle="1-S2-1-9999", pid=2, scaled_rating=3500, mmr=None,
    )
    ctx = SimpleNamespace(raw=SimpleNamespace(players=[other, raw_match]))
    out = _resolve_my_mmr(ctx, me, file_path=tmp_path / "x.SC2Replay")
    assert out == 4900


def test_resolve_my_mmr_returns_none_when_nothing_usable(tmp_path):
    from sc2tools_agent.replay_pipeline import _resolve_my_mmr

    me = _make_pi(mmr=None)
    raw_match = SimpleNamespace(
        toon_handle="1-S2-1-267727", pid=1, scaled_rating=None, mmr=None,
    )
    ctx = SimpleNamespace(raw=SimpleNamespace(players=[raw_match]))
    out = _resolve_my_mmr(ctx, me, file_path=tmp_path / "x.SC2Replay")
    assert out is None


def test_resolve_my_mmr_rejects_implausibly_low_values(tmp_path):
    from sc2tools_agent.replay_pipeline import _resolve_my_mmr

    # league enums (Bronze=0..Grandmaster=7) leak into ``mmr``/``scaled_rating``
    # on some sc2reader builds; reject anything below the 500 floor so
    # the overlay never paints "5" as a rating.
    me = _make_pi(mmr=7)  # Grandmaster enum, not a real MMR
    raw_match = SimpleNamespace(
        toon_handle="1-S2-1-267727", pid=1, scaled_rating=3, mmr=7,
    )
    ctx = SimpleNamespace(raw=SimpleNamespace(players=[raw_match]))
    out = _resolve_my_mmr(ctx, me, file_path=tmp_path / "x.SC2Replay")
    assert out is None


def test_resolve_my_mmr_rejects_value_above_api_schema_ceiling(tmp_path):
    from sc2tools_agent.replay_pipeline import _resolve_my_mmr

    me = _make_pi(mmr=None)
    raw_match = SimpleNamespace(
        toon_handle="1-S2-1-267727",
        pid=1,
        init_data={"scaled_rating": 10000},
    )
    ctx = SimpleNamespace(raw=SimpleNamespace(players=[raw_match]))

    assert _resolve_my_mmr(
        ctx, me, file_path=tmp_path / "x.SC2Replay",
    ) is None


def test_resolve_my_mmr_returns_none_when_raw_replay_missing(tmp_path):
    from sc2tools_agent.replay_pipeline import _resolve_my_mmr

    # parse_deep occasionally leaves ctx.raw=None on a level-2 fallback —
    # we still must return cleanly rather than throw.
    me = _make_pi(mmr=None)
    ctx = SimpleNamespace(raw=None)
    out = _resolve_my_mmr(ctx, me, file_path=tmp_path / "x.SC2Replay")
    assert out is None


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
    falling through to disk load from ``apps/replay-engine/``.
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
    # And the resolved module must be the apps/replay-engine copy.
    file_attr = getattr(mod, "__file__", "") or ""
    assert "replay-engine" in file_attr, (
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


def test_parse_replay_for_cloud_uploads_resumed_replay_quarantine_marker(
    monkeypatch, tmp_path, _stub_pulse_resolver,
):
    """A take-control artifact must reconcile old false cloud results."""
    me = SimpleNamespace(
        result="Win",
        name="Me",
        race="Protoss",
        selected_race="Protoss",
        handle="1-S2-1-100",
    )
    opp = SimpleNamespace(
        name="Zulrah",
        race="Zerg",
        handle="1-S2-1-200",
    )
    fake_ctx = SimpleNamespace(
        is_resumed_from_replay=True,
        is_ai_game=False,
        me=me,
        opponent=opp,
        all_players=[me, opp],
        game_id="2026-08-09T23:57:19|Zulrah|Old Sun Temple LE|460",
        date_iso="2026-08-09T23:57:19+00:00",
        started_at_iso="2026-08-09T23:49:39+00:00",
        map_name="Old Sun Temple LE",
        length_seconds=460,
        game_version="5.0.16.97425",
        game_build=97425,
        raw=SimpleNamespace(
            resume_from_replay=True,
            category="Ladder",
            real_type="1v1",
        ),
    )
    monkeypatch.setitem(
        sys.modules,
        "core.sc2_replay_parser",
        SimpleNamespace(parse_deep=lambda _path, _handle: fake_ctx),
    )

    from sc2tools_agent.replay_pipeline import parse_replay_for_cloud_ex

    game, reason = parse_replay_for_cloud_ex(
        tmp_path / "resumed.SC2Replay",
        player_handle="Me",
    )

    assert game is not None
    assert reason is None
    payload = game.to_payload()
    assert payload == {
        "gameId": "2026-08-09T23:57:19|Zulrah|Old Sun Temple LE|460",
        "date": "2026-08-09T23:57:19Z",
        "startedAt": "2026-08-09T23:49:39Z",
        "result": "Victory",
        "myRace": "Protoss",
        "myLadderRace": "Protoss",
        "map": "Old Sun Temple LE",
        "durationSec": 460,
        "buildLog": [],
        "oppBuildLog": [],
        "myToonHandle": "1-S2-1-100",
        "playerCount": 2,
        "matchFormat": "1v1",
        "isLadderGame": True,
        "gameVersion": "5.0.16.97425",
        "gameBuild": 97425,
        "opponent": {
            "displayName": "Zulrah",
            "race": "Zerg",
            "toonHandle": "1-S2-1-200",
            "pulseId": "1-S2-1-200",
            "pulseLookupAttempted": False,
        },
        "isResumedFromReplay": True,
    }
    # Synthetic branches must not trigger a Pulse lookup or carry MMR/macro
    # evidence that competitive consumers could accidentally trust.
    assert _stub_pulse_resolver == []
    assert "myMmr" not in payload
    assert "myMmrSource" not in payload
    assert "macroBreakdown" not in payload


def test_parse_replay_for_cloud_emits_macro_breakdown_and_opp_build_log(
    monkeypatch, tmp_path, _stub_pulse_resolver,
):
    import sys
    from types import SimpleNamespace

    # ---- Mock parse_deep so we don't need a real .SC2Replay file. ----
    me = SimpleNamespace(
        pid=1, name="Me", race="Protoss", result="Win",
        selected_race="Random",
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
        started_at_iso="2026-05-06T17:38:32",
        game_version="5.0.16.97425",
        game_build=97425,
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
    # Signature mirrors the v0.5+ apps/replay-engine extractor:
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
            # Structure lifetimes for both sides — the SPA's
            # death-aware Buildings roster subtracts destroyed
            # structures from these, so they must survive the trip
            # onto the macroBreakdown payload verbatim.
            "production_buildings": [
                {"unit_id": 7, "name": "Gateway",
                 "born_time": 95, "died_time": 600, "destroyed": False},
                {"unit_id": 9, "name": "PhotonCannon",
                 "born_time": 200, "died_time": 220, "destroyed": True},
            ],
            "bases": [
                {"unit_id": 1, "name": "Nexus",
                 "born_time": 0, "died_time": 600, "destroyed": False},
            ],
            "opp_production_buildings": [
                {"unit_id": 30, "name": "SpineCrawler",
                 "born_time": 125, "died_time": 300, "destroyed": True},
                {"unit_id": 50, "name": "Hatchery",
                 "born_time": 0, "died_time": 600, "destroyed": False},
            ],
            "opp_bases": [
                {"unit_id": 50, "name": "Hatchery",
                 "born_time": 0, "died_time": 600, "destroyed": False},
            ],
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
    # Structure lifetimes pass through for BOTH sides. Without these
    # the SPA's Buildings roster falls back to cumulative build-order
    # counts and destroyed spines / cannons never leave the roster.
    assert [r["name"] for r in mb["production_buildings"]] == [
        "Gateway", "PhotonCannon",
    ]
    assert [r["name"] for r in mb["opp_production_buildings"]] == [
        "SpineCrawler", "Hatchery",
    ]
    assert [r["destroyed"] for r in mb["production_buildings"]] == [
        False, True,
    ]
    assert [r["destroyed"] for r in mb["opp_production_buildings"]] == [
        True, False,
    ]
    assert [r["name"] for r in mb["bases"]] == ["Nexus"]
    assert [r["name"] for r in mb["opp_bases"]] == ["Hatchery"]

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

    # all_players had two entries (me + opp), producing both the raw
    # count and the normalized 1v1 format.
    assert payload["playerCount"] == 2
    assert payload["matchFormat"] == "1v1"

    # Random queue keeps its selected ladder pool even though this
    # particular replay spawned Protoss for build/matchup analysis.
    assert payload["myRace"] == "Protoss"
    assert payload["myLadderRace"] == "Random"

    # The opponent's league reaches the wire. The cloud's Ladder Meta
    # Radar and league-percentile benchmarks band the whole corpus on
    # ``opponent.leagueId`` — if this field silently drops off the
    # payload again, every (league, matchup) stays below its
    # k-anonymity floor and the /meta page shows "Not enough games"
    # forever. ``raw`` here is a bare object() → ladder-ness unknown →
    # the field is trusted and shipped.
    assert payload["opponent"]["leagueId"] == 5
    assert payload["gameVersion"] == "5.0.16.97425"
    assert payload["gameBuild"] == 97425
    assert payload["startedAt"] == "2026-05-06T17:38:32Z"

    # Full-history workers defer SC2Pulse resolution to the cloud backfill.
    # Every analytical field is still computed; only the external lookup is
    # removed from the critical path.
    _stub_pulse_resolver.clear()
    deferred = parse_replay_for_cloud(
        fake_path,
        player_handle="Me",
        resolve_pulse=False,
    )
    assert deferred is not None
    deferred_payload = deferred.to_payload()
    assert _stub_pulse_resolver == []
    assert deferred_payload["opponent"]["toonHandle"] == "1-S2-2-690921"
    assert deferred_payload["opponent"]["pulseId"] == "1-S2-2-690921"
    assert deferred_payload["opponent"]["pulseLookupAttempted"] is False
    assert "pulseCharacterId" not in deferred_payload["opponent"]
    assert deferred_payload["macroBreakdown"] == payload["macroBreakdown"]


def test_parse_replay_for_cloud_ships_partial_macro_breakdown_on_score_failure(
    monkeypatch, tmp_path,
):
    """compute_macro_score raises → macroBreakdown still ships.

    Pre-fix behaviour: any exception inside compute_macro_score (a new
    race-specific leak rule, a divide-by-zero on a 30 s sub-game, an
    edge case the engine hasn't seen yet) bailed the entire breakdown
    and the SPA showed "Macro breakdown not available". The chart half
    of the breakdown only needs stats_events + unit_timeline — both of
    which were already extracted successfully at that point — so the
    fail-soft now ships a partial payload (no score, no leaks list,
    full chart) rather than nothing.
    """
    import sys
    from types import SimpleNamespace

    me = SimpleNamespace(
        pid=1, name="Me", race="Protoss", result="Win",
        handle="1-S2-1-267727", mmr=4500, apm=180.0, spq=82.0,
    )
    opp = SimpleNamespace(
        pid=2, name="Opp", race="Terran", result="Loss",
        handle="1-S2-2-690921", mmr=4400, league_id=5,
    )
    fake_ctx = SimpleNamespace(
        game_id="2026-05-07T21:24:29|Opp|Celestial Enclave LE|892",
        date_iso="2026-05-07T21:24:29",
        map_name="Celestial Enclave LE",
        length_seconds=892,
        is_ai_game=False,
        me=me,
        opponent=opp,
        all_players=[me, opp],
        my_events=[],
        opp_events=[],
        my_build="PvT - Phoenix into Robo",
        opp_strategy="Terran - Widow Mine Drop",
        build_log=["[0:00] Nexus", "[0:17] Pylon"],
        early_build_log=["[0:00] Nexus"],
        opp_build_log=[],
        opp_early_build_log=[],
        macro_score=None,
        raw=object(),
        file_path=str(tmp_path / "celestial.SC2Replay"),
    )

    monkeypatch.setitem(
        sys.modules,
        "core.sc2_replay_parser",
        SimpleNamespace(parse_deep=lambda _p, _h: fake_ctx),
    )

    def _fake_extract(_replay, _pid, _opp_pid=None):
        return {
            "stats_events": [
                {"time": 0, "food_used": 12, "food_workers": 12,
                 "food_made": 15, "minerals_current": 50,
                 "vespene_current": 0, "minerals_collection_rate": 0,
                 "vespene_collection_rate": 0},
                {"time": 60, "food_used": 22, "food_workers": 18,
                 "food_made": 23, "minerals_current": 250,
                 "vespene_current": 100, "minerals_collection_rate": 800,
                 "vespene_collection_rate": 50},
            ],
            "opp_stats_events": [
                {"time": 0, "food_used": 12, "food_workers": 12},
                {"time": 60, "food_used": 21, "food_workers": 17},
            ],
            "unit_timeline": [
                {"time": 0, "my": {}, "opp": {}},
                {"time": 60, "my": {"Phoenix": 2}, "opp": {"Marine": 6}},
            ],
            "player_stats": {},
            "ability_events": [],
            "production_buildings": [],
            "bases": [],
            "unit_births": [],
            "game_length_sec": 892,
        }

    def _fake_compute_raises(_macro, _race, _length):
        raise RuntimeError(
            "imagine the race-specific leak engine hit a divide-by-zero",
        )

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
        SimpleNamespace(compute_macro_score=_fake_compute_raises),
    )

    from sc2tools_agent.replay_pipeline import parse_replay_for_cloud
    fake_path = tmp_path / "celestial.SC2Replay"
    fake_path.write_bytes(b"")
    result = parse_replay_for_cloud(fake_path, player_handle="Me")
    assert result is not None
    payload = result.to_payload()

    # macroBreakdown still present — the chart side renders.
    assert "macroBreakdown" in payload, (
        "compute_macro_score raised but macroBreakdown still must ship "
        "with the chart's stats_events + unit_timeline so the SPA can "
        "render the Active Army chart and roster. Pre-fix this returned "
        "None and the SPA showed 'Macro breakdown not available'."
    )
    mb = payload["macroBreakdown"]
    # Score-engine outputs degrade gracefully to empty dicts/lists.
    assert mb["raw"] == {}
    assert mb["all_leaks"] == []
    assert mb["top_3_leaks"] == []
    # Chart inputs survived intact — this is the load-bearing assert.
    assert len(mb["stats_events"]) >= 1
    assert len(mb["opp_stats_events"]) >= 1
    assert len(mb["unit_timeline"]) >= 1
    # Extractor output without the opponent lifetime mirrors (older
    # replay-engine copy) degrades to empty lists, not a KeyError.
    assert mb["production_buildings"] == []
    assert mb["opp_production_buildings"] == []
    # No headline macroScore — the dossier shows "—" rather than 0.
    assert "macroScore" not in payload


def test_parse_replay_for_cloud_omits_league_id_for_non_ladder_games(
    monkeypatch, tmp_path,
):
    """A Private/Public (custom) game must NOT stamp opponent.leagueId.

    The cloud bands its ladder-meta / benchmark aggregations on
    ``opponent.leagueId`` under the assumption that matchmaking put the
    two players in the same bracket. A custom-lobby opponent's season
    league says nothing about the bracket the game was played in, so
    the field stays off the payload when the replay says non-ladder.
    """
    import sys
    from types import SimpleNamespace

    me = SimpleNamespace(
        pid=1, name="Me", race="Protoss", result="Win",
        handle="1-S2-1-267727", mmr=4500, apm=180.0, spq=82.0,
    )
    opp = SimpleNamespace(
        pid=2, name="Opp", race="Zerg", result="Loss",
        handle="1-S2-2-690921", mmr=4400, league_id=6,
    )
    fake_ctx = SimpleNamespace(
        game_id="2026-05-08T10:00:00|Opp|Goldenaura|300",
        date_iso="2026-05-08T10:00:00",
        map_name="Goldenaura",
        length_seconds=300,
        is_ai_game=False,
        me=me,
        opponent=opp,
        all_players=[me, opp],
        my_events=[],
        opp_events=[],
        my_build="PvZ - Gate Expand",
        opp_strategy=None,
        build_log=["[0:00] Nexus"],
        early_build_log=["[0:00] Nexus"],
        opp_build_log=[],
        opp_early_build_log=[],
        macro_score=None,
        raw=SimpleNamespace(category="Private"),
        file_path=str(tmp_path / "custom.SC2Replay"),
    )
    monkeypatch.setitem(
        sys.modules,
        "core.sc2_replay_parser",
        SimpleNamespace(parse_deep=lambda _p, _h: fake_ctx),
    )

    from sc2tools_agent.replay_pipeline import parse_replay_for_cloud
    fake_path = tmp_path / "custom.SC2Replay"
    fake_path.write_bytes(b"")
    result = parse_replay_for_cloud(fake_path, player_handle="Me")
    assert result is not None
    payload = result.to_payload()

    assert payload["isLadderGame"] is False
    # MMR still ships (it's real replay data either way); the league
    # banding signal does not.
    assert payload["opponent"]["mmr"] == 4400
    assert "leagueId" not in payload["opponent"]


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
# stats_events downsampling — the agent buckets sc2reader's native
# ~10 s PlayerStatsEvent stream to one entry per bucket before shipping
# the macroBreakdown payload. Bucket width matches the native cadence
# so the SPA's Active Army chart hover snaps to every emitted sample.
# macro_score is computed on the FULL stream first so leak detection /
# SQ / penalties are unaffected.
# -------------------------------------------------------------------------


def test_downsample_stats_events_keeps_first_per_bucket():
    from sc2tools_agent.replay_pipeline import (
        _downsample_stats_events,
        _STATS_EVENTS_BUCKET_SEC,
    )
    assert _STATS_EVENTS_BUCKET_SEC == 10  # locked to sc2reader native cadence
    # 5 s cadence input, 0..50 s — buckets are [0,10), [10,20), [20,30),
    # [30,40), [40,50), [50,60) so we expect the first event in each
    # bucket: t=0, 10, 20, 30, 40, 50.
    events = [{"time": t, "food_used": t} for t in range(0, 55, 5)]
    out = _downsample_stats_events(events)
    assert [e["time"] for e in out] == [0, 10, 20, 30, 40, 50]


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
        {"time": 15, "food_used": 4},        # bucket 1
    ]
    out = _downsample_stats_events(events)
    assert [e["food_used"] for e in out] == [1, 4]


# ── map playback compaction ──────────────────────────────────────────


def _sample_playback():
    return {
        "map_name": "Alcyone LE",
        "game_length": 700.0,
        "bounds": {"x_min": 10.0, "x_max": 190.0, "y_min": 20.0, "y_max": 160.0},
        "spawn_locations": [
            {"owner": "me", "x": 30.0, "y": 40.0},
            {"owner": "opp", "x": 170.0, "y": 140.0},
        ],
        "my_events": [
            {"type": "building", "name": "Nexus", "time": 0.0, "x": 30.0, "y": 40.0},
            {"type": "unit", "name": "Probe", "time": 1.0, "x": 30.0, "y": 41.0},
        ],
        "opp_events": [
            {"type": "building", "name": "Hatchery", "time": 0.0, "x": 170.0, "y": 140.0},
        ],
        "my_stats": [
            {"time": 0.0, "army_val": 0, "workers": 12, "food_used": 12},
            {"time": 5.0, "army_val": 0, "workers": 13, "food_used": 13},
            {"time": 20.0, "army_val": 100, "workers": 16, "food_used": 18},
        ],
        "opp_stats": [
            {"time": 0.0, "army_val": 0, "workers": 12, "food_used": 12},
        ],
        "my_units": [
            {
                "name": "Stalker",
                "born": 120.0,
                "died": 300.0,
                # Tuple-style waypoints. The middle sample sits ~0.7
                # world units off the chord the other two draw, so the
                # corner-preserving pass reads it as redundant.
                "waypoints": [(120.0, 30.0, 40.0), (120.5, 31.0, 40.0), (125.0, 40.0, 50.0)],
            },
        ],
        "opp_units": [
            {
                "name": "Zergling",
                "born": 130.0,
                "died": None,
                # Flat-style waypoints must parse too.
                "waypoints": [130.0, 170.0, 140.0, 140.0, 150.0, 120.0],
            },
        ],
    }


def test_compact_map_playback_produces_bounded_camelcase_payload():
    from sc2tools_agent.replay_pipeline import _compact_map_playback

    out = _compact_map_playback(
        _sample_playback(),
        [{"time": 200.0, "x": 100.0, "y": 90.0, "side": "me"}],
    )
    assert out is not None
    assert out["v"] == 3
    assert out["mapName"] == "Alcyone LE"
    assert out["bounds"] == {"minX": 10.0, "minY": 20.0, "maxX": 190.0, "maxY": 160.0}
    assert out["spawns"][0] == {"owner": "me", "x": 30.0, "y": 40.0}
    assert out["battles"] == [{"t": 200.0, "x": 100.0, "y": 90.0}]
    # Buildings only — the Probe unit event is not a building.
    assert [b["name"] for b in out["buildings"]] == ["Nexus", "Hatchery"]
    # Waypoint simplification: the 120.5s sample lies within epsilon of
    # the straight line between its neighbours, so it is dropped.
    stalker = next(u for u in out["units"] if u["name"] == "Stalker")
    assert stalker["wp"] == [120.0, 30.0, 40.0, 125.0, 40.0, 50.0]
    assert stalker["died"] == 300.0
    # Flat-style waypoints parse identically.
    ling = next(u for u in out["units"] if u["name"] == "Zergling")
    assert ling["owner"] == "opp"
    assert ling["wp"] == [130.0, 170.0, 140.0, 140.0, 150.0, 120.0]
    assert ling["died"] is None
    # Stats downsampled to >= 10s spacing: 0s and 20s survive, 5s dropped.
    assert [row[0] for row in out["stats"]["me"]] == [0.0, 20.0]


def test_compact_map_playback_marks_spent_deaths_and_claims_v4():
    """Engines that attribute deaths (killer_pid key present) upgrade
    the payload to v4 and mark killer-less deaths ``sd`` — the web's
    loss ledger uses that to tell a morphed drone from a killed one.
    Payloads without attribution must stay v3 (first test above)."""
    from sc2tools_agent.replay_pipeline import _compact_map_playback

    pb = _sample_playback()
    pb["my_units"] = [
        {"name": "Drone", "born": 0.0, "died": 60.0, "killer_pid": None,
         "waypoints": [(0.0, 50.0, 50.0)]},          # morphed into a building
        {"name": "Drone", "born": 0.0, "died": 90.0, "killer_pid": 2,
         "waypoints": [(0.0, 50.0, 50.0)]},          # killed by the opponent
        {"name": "Drone", "born": 0.0, "died": None, "killer_pid": None,
         "waypoints": [(0.0, 50.0, 50.0)]},          # survived
    ]
    out = _compact_map_playback(pb)
    assert out["v"] == 4
    drones = [u for u in out["units"] if u["owner"] == "me"]
    assert drones[0].get("sd") is True
    assert "sd" not in drones[1]
    assert "sd" not in drones[2]


def test_compact_map_playback_emits_casts_and_claims_v5():
    """Ability casts ride along as ``casts`` and lift the payload to v5.

    ``o`` is 0 for me / 1 for the opponent, ``a`` is the engine's
    stable slug, coordinates round to 1 decimal, and a cast the engine
    could not place OMITS x/y rather than sending nulls."""
    from sc2tools_agent.replay_pipeline import _compact_map_playback

    pb = _sample_playback()
    pb["my_units"][0]["killer_pid"] = 2          # attribution -> v4 floor
    pb["ability_casts"] = [
        {"owner": "me", "ability": "PsiStorm", "t": 301.44,
         "x": 100.06, "y": 90.02, "targetUnitId": None},
        {"owner": "opp", "ability": "FungalGrowth", "t": 305.0,
         "x": 101.0, "y": 91.0, "targetUnitId": None},
        # Self-cast the engine could not place.
        {"owner": "me", "ability": "Stim", "t": 310.0,
         "x": None, "y": None, "targetUnitId": None},
    ]
    out = _compact_map_playback(pb)
    assert out["v"] == 5
    assert out["casts"] == [
        {"o": 0, "a": "PsiStorm", "t": 301.4, "x": 100.1, "y": 90.0},
        {"o": 1, "a": "FungalGrowth", "t": 305.0, "x": 101.0, "y": 91.0},
        {"o": 0, "a": "Stim", "t": 310.0},
    ]
    # Omitted, never null — the web treats absent and null the same
    # but absent is smaller and this rides in every upload.
    assert "x" not in out["casts"][2]


def test_compact_map_playback_drops_malformed_casts():
    from sc2tools_agent.replay_pipeline import _compact_map_playback

    pb = _sample_playback()
    pb["ability_casts"] = [
        {"owner": "me", "ability": "EMP", "t": 100.0, "x": 5.0, "y": 6.0},
        {"owner": "spectator", "ability": "EMP", "t": 100.0},   # bad owner
        {"owner": "me", "ability": "", "t": 100.0},             # no ability
        {"owner": "me", "ability": "EMP", "t": None},           # no time
        "not-a-mapping",
    ]
    out = _compact_map_playback(pb)
    assert [c["a"] for c in out["casts"]] == ["EMP"]


def test_compact_map_playback_without_casts_key_stays_v4():
    """Backward compatibility is the whole game here: the API has no
    recompute path, so most stored games will never have casts. An
    engine too old to produce them must keep emitting exactly the v4
    payload it emitted before."""
    from sc2tools_agent.replay_pipeline import _compact_map_playback

    pb = _sample_playback()
    pb["my_units"][0]["killer_pid"] = 2
    assert "ability_casts" not in pb
    out = _compact_map_playback(pb)
    assert out["v"] == 4
    assert "casts" not in out

    # A new engine on a game with no spells at all still claims v5 --
    # presence of the KEY is the capability signal, not the count.
    pb["ability_casts"] = []
    out_empty = _compact_map_playback(pb)
    assert out_empty["v"] == 5
    assert "casts" not in out_empty


def test_compact_map_playback_caps_casts_keeping_the_decisive_ones():
    """Over the cap, whole priority tiers survive in order and the one
    tier that overflows is thinned by EVEN TIME SPACING. Chrono Boost
    spam must never crowd out a Psi Storm, and the thinning must not
    amputate the back half of the game the way [:400] would."""
    from sc2tools_agent.replay_pipeline import (
        _PLAYBACK_MAX_CASTS,
        _compact_map_playback,
    )

    pb = _sample_playback()
    casts = []
    # 600 chrono boosts spread over the whole game (tier 2)...
    for i in range(600):
        casts.append({"owner": "me", "ability": "ChronoBoost",
                      "t": float(i), "x": 10.0, "y": 10.0})
    # ...and 30 storms scattered through it (tier 0).
    for i in range(30):
        casts.append({"owner": "opp", "ability": "PsiStorm",
                      "t": float(i * 20), "x": 20.0, "y": 20.0})
    pb["ability_casts"] = casts
    out = _compact_map_playback(pb)

    assert len(out["casts"]) == _PLAYBACK_MAX_CASTS
    # Every storm survives; the chrono tier absorbs the loss.
    assert sum(1 for c in out["casts"] if c["a"] == "PsiStorm") == 30
    assert sum(1 for c in out["casts"] if c["a"] == "ChronoBoost") == (
        _PLAYBACK_MAX_CASTS - 30
    )
    # Still chronological, and the LAST minute of the game is still
    # represented — the thinning is a sample, not a truncation.
    times = [c["t"] for c in out["casts"]]
    assert times == sorted(times)
    assert max(times) >= 560.0


def test_compact_map_playback_rejects_junk_bounds():
    from sc2tools_agent.replay_pipeline import _compact_map_playback

    bad = _sample_playback()
    bad["bounds"] = {"x_min": 50.0, "x_max": 50.0, "y_min": 0.0, "y_max": 10.0}
    assert _compact_map_playback(bad) is None
    assert _compact_map_playback({"bounds": None}) is None


def test_compact_map_playback_caps_unit_count_keeping_longest_lived():
    from sc2tools_agent.replay_pipeline import (
        _PLAYBACK_MAX_UNITS_PER_SIDE,
        _compact_map_playback,
    )

    pb = _sample_playback()
    pb["my_units"] = [
        {
            "name": f"U{i}",
            "born": 0.0,
            "died": float(i),  # lifespan == i seconds
            "waypoints": [(0.0, 50.0, 50.0)],
        }
        for i in range(_PLAYBACK_MAX_UNITS_PER_SIDE + 50)
    ]
    out = _compact_map_playback(pb)
    mine = [u for u in out["units"] if u["owner"] == "me"]
    assert len(mine) == _PLAYBACK_MAX_UNITS_PER_SIDE
    # The 50 shortest-lived blips are the ones dropped.
    kept_died = sorted(u["died"] for u in mine)
    assert kept_died[0] == 50.0


def test_compact_map_playback_passes_resources_through_with_caps():
    from sc2tools_agent.replay_pipeline import _compact_map_playback

    playback = _sample_playback()
    playback["resources"] = [
        {"kind": "minerals", "x": 26.04, "y": 34.06, "died": None},
        {"kind": "gold", "x": 100.0, "y": 100.0, "died": 300.04},
        {"kind": "gas", "x": 25.0, "y": 27.0},
        {"kind": "rocks", "x": 80.0, "y": 80.0, "died": 250.0},
        {"kind": "tower", "x": 88.0, "y": 88.0},
        {"kind": "nuke", "x": 1.0, "y": 1.0},          # unknown kind dropped
        {"kind": "minerals", "x": "junk", "y": 2.0},   # junk coords dropped
    ]
    out = _compact_map_playback(playback, [])
    assert out is not None
    res = out["resources"]
    assert [r["kind"] for r in res] == ["minerals", "gold", "gas", "rocks", "tower"]
    # Coordinates round to one decimal; died survives only when numeric.
    assert res[0] == {"kind": "minerals", "x": 26.0, "y": 34.1}
    assert res[1]["died"] == 300.0
    assert "died" not in res[2]


def test_compact_map_playback_omits_resources_key_when_absent():
    from sc2tools_agent.replay_pipeline import _compact_map_playback

    out = _compact_map_playback(_sample_playback(), [])
    assert out is not None
    assert "resources" not in out


def test_compact_map_playback_prefers_lifecycle_buildings_with_moves():
    from sc2tools_agent.replay_pipeline import _compact_map_playback

    playback = _sample_playback()
    playback["my_buildings"] = [
        {"name": "CommandCenter", "born": 12.04, "x": 30.0, "y": 40.0,
         "moves": [300.0, 90.0, 88.0], "died": None},
    ]
    playback["opp_buildings"] = [
        {"name": "Hatchery", "born": 0.0, "x": 170.0, "y": 140.0,
         "moves": [], "died": 512.06},
    ]
    out = _compact_map_playback(playback, [])
    assert out is not None
    cc = next(b for b in out["buildings"] if b["name"] == "CommandCenter")
    hatch = next(b for b in out["buildings"] if b["name"] == "Hatchery")
    assert cc["t"] == 12.0
    assert cc["moves"] == [300.0, 90.0, 88.0]
    assert "died" not in cc
    assert hatch["died"] == 512.1
    assert "moves" not in hatch
    # Legacy event-scan buildings are NOT mixed in when lifecycle exists.
    assert len(out["buildings"]) == 2


# ── Corner-preserving waypoint simplification (RDP) ──────────────────
#
# The compaction used to keep one sample every 2 seconds, which sampled
# away the corners a unit walked around cliffs and ramps — the web
# interpolates between waypoints, so a missing corner is drawn as a
# straight line through unwalkable ground. These lock down the
# Ramer-Douglas-Peucker replacement: corners survive, straight runs
# collapse, the per-unit cap still holds, and the ends of every track
# stay put so ``born`` / ``died`` keep lining up.


def _unit_with_track(track, **extra):
    """A my_units entry carrying ``track`` as tuple-style waypoints."""
    unit = {"name": "Stalker", "born": track[0][0] if track else 0.0,
            "died": None, "waypoints": list(track)}
    unit.update(extra)
    return unit


def _wp_of(out, name="Stalker"):
    return next(u for u in out["units"] if u["name"] == name)["wp"]


def test_compact_map_playback_keeps_corners_and_drops_collinear_runs():
    """The whole point of the change: a unit that walked east and then
    turned north keeps its turn and loses the redundant samples along
    each leg. Under the old fixed-time rule the corner was whatever
    happened to land on the 2-second grid."""
    from sc2tools_agent.replay_pipeline import _compact_map_playback

    east = [(float(i), 50.0 + i, 50.0) for i in range(11)]     # → (60, 50)
    north = [(float(10 + i), 60.0, 50.0 + i) for i in range(1, 11)]
    pb = _sample_playback()
    pb["my_units"] = [_unit_with_track(east + north)]
    pb["opp_units"] = []

    out = _compact_map_playback(pb, [])
    assert out is not None
    # Three samples survive: both ends and the corner itself.
    assert _wp_of(out) == [0.0, 50.0, 50.0, 10.0, 60.0, 50.0, 20.0, 60.0, 60.0]


def test_compact_map_playback_simplification_respects_the_waypoint_cap():
    """A pathological all-corners track must still fit the cap, and it
    must fit it by coarsening — never by truncation. A truncated track
    stops mid-map and never reaches where the unit actually died."""
    from sc2tools_agent.replay_pipeline import (
        _PLAYBACK_MAX_WAYPOINTS_PER_UNIT,
        _compact_map_playback,
    )

    # 800 alternating samples: every single one is a real corner.
    zigzag = [
        (float(i), i * 0.5, 0.0 if i % 2 == 0 else 8.0)
        for i in range(800)
    ]
    pb = _sample_playback()
    pb["my_units"] = [_unit_with_track(zigzag)]
    pb["opp_units"] = []

    wp = _wp_of(_compact_map_playback(pb, []))
    assert len(wp) % 3 == 0
    assert len(wp) // 3 <= _PLAYBACK_MAX_WAYPOINTS_PER_UNIT
    # Coarsened, not truncated: the last sample is the track's last
    # sample, not the 240th one.
    assert wp[:3] == [0.0, 0.0, 0.0]
    assert wp[-3:] == [799.0, 399.5, 8.0]
    # And it uses the budget it has rather than collapsing to the ends.
    assert len(wp) // 3 > _PLAYBACK_MAX_WAYPOINTS_PER_UNIT // 2


def test_compact_map_playback_keeps_endpoints_and_monotonic_time():
    """Each surviving waypoint keeps its own real timestamp — nothing is
    resampled onto a grid — and time only ever moves forward. The web
    lerps on ``t1 - t0``, so a repeated or backwards stamp renders as a
    teleport."""
    from sc2tools_agent.replay_pipeline import _compact_map_playback

    track = [
        (100.0, 20.0, 20.0),
        (101.5, 60.0, 21.0),
        (101.5, 99.0, 99.0),   # duplicate stamp — dropped
        (100.9, 10.0, 10.0),   # backwards stamp — dropped
        (104.28, 60.0, 80.0),
        (109.0, 21.0, 79.0),
    ]
    pb = _sample_playback()
    pb["my_units"] = [_unit_with_track(track, born=100.0, died=109.0)]
    pb["opp_units"] = []

    out = _compact_map_playback(pb, [])
    unit = next(u for u in out["units"] if u["name"] == "Stalker")
    wp = unit["wp"]
    times = wp[0::3]
    assert times[0] == 100.0 and times[-1] == 109.0
    assert all(b > a for a, b in zip(times, times[1:]))
    # Real stamps, not a 2s grid: 104.28 rounds to 104.3, not to 104.0.
    assert 104.3 in times
    assert unit["born"] == 100.0 and unit["died"] == 109.0


def test_compact_map_playback_separates_stamps_that_collide_when_rounded():
    """Two samples the engine kept apart can still land on the same 0.1s
    stamp once the payload rounds them, and the web's lerp divides by
    (t1 - t0). The old 2s gap rule made that unreachable; RDP happily
    keeps both sides of a sharp turn taken inside a single tick, so the
    monotonic guard has to compare at the resolution that ships."""
    from sc2tools_agent.replay_pipeline import _compact_map_playback

    # A corner turned 0.03s after the previous sample — both survive RDP,
    # and 104.28 / 104.31 both round to 104.3.
    track = [
        (100.00, 20.0, 20.0),
        (104.28, 60.0, 20.0),
        (104.31, 60.0, 60.0),
        (109.00, 20.0, 60.0),
    ]
    pb = _sample_playback()
    pb["my_units"] = [_unit_with_track(track)]
    pb["opp_units"] = []

    times = _wp_of(_compact_map_playback(pb, []))[0::3]
    assert all(b > a for a, b in zip(times, times[1:])), times
    # Ends still line up with the track, and the collision cost exactly
    # one sample rather than the whole tail.
    assert times[0] == 100.0 and times[-1] == 109.0


def test_compact_map_playback_handles_degenerate_tracks():
    """0, 1 and 2 samples, plus a unit that never moved. A stationary
    unit collapses to its two ends — the whole middle is redundant."""
    from sc2tools_agent.replay_pipeline import _compact_map_playback

    pb = _sample_playback()
    pb["my_units"] = [
        {"name": "Empty", "born": 0.0, "died": None, "waypoints": []},
        {"name": "One", "born": 5.0, "died": None,
         "waypoints": [(5.0, 30.0, 30.0)]},
        {"name": "Two", "born": 6.0, "died": None,
         "waypoints": [(6.0, 30.0, 30.0), (9.0, 44.0, 51.0)]},
        {"name": "Parked", "born": 0.0, "died": 119.0,
         "waypoints": [(float(i), 25.0, 25.0) for i in range(120)]},
    ]
    pb["opp_units"] = []

    out = _compact_map_playback(pb, [])
    names = [u["name"] for u in out["units"]]
    # A unit with no track at all carries no story and is dropped.
    assert "Empty" not in names
    assert _wp_of(out, "One") == [5.0, 30.0, 30.0]
    assert _wp_of(out, "Two") == [6.0, 30.0, 30.0, 9.0, 44.0, 51.0]
    assert _wp_of(out, "Parked") == [0.0, 25.0, 25.0, 119.0, 25.0, 25.0]


def test_simplify_track_keeps_an_out_and_back_excursion():
    """Distance is measured to the chord SEGMENT, not its infinite line.
    A worker that walks out to a patch and returns gives a chord whose
    ends nearly coincide; measured against the infinite line the far
    turn sits at ~zero distance and the whole trip would vanish."""
    from sc2tools_agent.replay_pipeline import (
        _PLAYBACK_MAX_WAYPOINTS_PER_UNIT,
        _PLAYBACK_WAYPOINT_EPSILON,
        _simplify_track,
    )

    out_and_back = [(0.0, 10.0, 10.0), (5.0, 40.0, 10.0), (10.0, 10.2, 10.0)]
    kept = _simplify_track(
        out_and_back, _PLAYBACK_WAYPOINT_EPSILON,
        _PLAYBACK_MAX_WAYPOINTS_PER_UNIT,
    )
    assert kept == out_and_back


def test_simplify_track_survives_a_track_deeper_than_the_recursion_limit():
    """The simplifier is iterative on purpose. A long track splits once
    per corner, and the textbook recursive form would run out of stack
    on a real 20-minute worker before it ran out of waypoints."""
    import random

    from sc2tools_agent.replay_pipeline import (
        _PLAYBACK_MAX_WAYPOINTS_PER_UNIT,
        _PLAYBACK_WAYPOINT_EPSILON,
        _simplify_track,
    )

    rng = random.Random(7)
    track = [
        (float(i), rng.uniform(0.0, 150.0), rng.uniform(0.0, 150.0))
        for i in range(6000)
    ]
    kept = _simplify_track(
        track, _PLAYBACK_WAYPOINT_EPSILON, _PLAYBACK_MAX_WAYPOINTS_PER_UNIT,
    )
    assert 2 <= len(kept) <= _PLAYBACK_MAX_WAYPOINTS_PER_UNIT
    assert kept[0] == track[0] and kept[-1] == track[-1]
