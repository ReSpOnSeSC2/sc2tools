"""Loading-card policy, live record I/O, prefs and actor plumbing of
``BuildCheckinController`` (contract §1.1, §1.2, §10.2)."""

from __future__ import annotations

import threading
import time

import pytest

from sc2tools_agent.build_checkin.controller import (
    LOADING_CARD_MAX_SEC,
    OPTIONS_TTL_SEC,
    BuildCheckinController,
)
from sc2tools_agent.build_checkin.models import (
    LOCKED_IN,
    PICKED_ON_WEB,
    RANDOMIZER_ROLLING,
    RANDOMIZER_WILL_ROLL,
    STATUS_DECLARE_OFFLINE,
    STATUS_DECLARE_UNAVAILABLE,
    STATUS_OPTIONS_FAILED,
    CheckinPrefs,
)
from sc2tools_agent.live.event_bus import EventBus
from tests.build_checkin_fakes import (
    ME,
    OPP,
    FakeCheckinApi,
    FakeView,
    Harness,
    ManualExecutor,
    SyncExecutor,
    api_error,
    envelope,
    option,
    options_payload,
    players,
)


@pytest.fixture
def h() -> Harness:
    return Harness().boot()


def _loading(h: Harness):
    return h.view.last("show_loading", "update_loading")


# ------------------------------------------------------------ show rules


def test_loading_card_shows_matchup_options_and_registers(h: Harness) -> None:
    key = h.new_key()
    h.send(envelope("match_loading", key))

    shown = h.view.of("show_loading")
    assert len(shown) == 1
    assert shown[0].game_key == key
    model = _loading(h)
    assert model.title == f"PvZ · vs {OPP}"
    assert model.heading == "What's the plan?"
    assert model.waiting_for_matchup is False
    assert [row.key for row in model.featured] == [
        "custom:dt-3-gate", "pvz-2-stargate-phoenix",
    ]
    assert model.featured[0].record == "7–5"
    assert [row.key for row in model.more] == ["pvz-chargelot-all-in"]
    assert next(row for row in model.featured if row.usual).key == "pvz-2-stargate-phoenix"
    register = h.api.live_bodies()[0]
    assert register == {
        "action": "register", "myRace": "Protoss", "oppRace": "Zerg", "oppName": OPP,
    }


def test_waiting_card_fills_in_as_the_roster_completes(h: Harness) -> None:
    key = h.new_key(names=f"{ME}")
    h.send(envelope(
        "match_loading", key,
        roster=players(opp=("", "?")),
        opponent=(None, None),
        user=(ME, "Protoss"),
    ))
    waiting = h.view.last("show_loading")
    assert waiting.waiting_for_matchup is True
    assert waiting.title == ""
    assert waiting.featured == ()

    h.send(envelope("match_loading", key))
    filled = _loading(h)
    assert filled.waiting_for_matchup is False
    assert filled.title == f"PvZ · vs {OPP}"
    assert len(h.view.of("show_loading")) == 1
    # Registered again once the matchup became concrete (hold decision).
    assert h.api.live_actions() == ["register", "register"]


def test_empty_roster_waits_for_a_human_opponent(h: Harness) -> None:
    key = h.new_key(names="unknown")
    h.send(envelope("match_loading", key, roster=[], opponent=(None, None), user=None))
    assert h.view.of("show_loading") == []
    h.send(envelope("match_loading", key))
    assert len(h.view.of("show_loading")) == 1


@pytest.mark.parametrize("roster", [
    [{"name": ME, "type": "user", "race": "Prot", "result": "Undecided"},
     {"name": "A.I. 1 (Elite)", "type": "computer", "race": "Zerg", "result": "Undecided"}],
    [{"name": f"P{i}", "type": "user", "race": "Zerg", "result": "Undecided"} for i in range(4)],
])
def test_no_loading_card_for_ai_or_team_games(h: Harness, roster) -> None:
    h.send(envelope("match_loading", h.new_key(), roster=roster))
    assert h.view.of("show_loading") == []
    assert h.api.calls_to("put_live_intent") == []


def test_unresolvable_identity_gets_no_card(h: Harness) -> None:
    h.send(envelope("match_loading", h.new_key(), opponent=(None, None), user=None))
    assert h.view.of("show_loading") == []


@pytest.mark.parametrize("side", ["user", "opponent"])
def test_random_never_gets_a_loading_card(h: Harness, side: str) -> None:
    kwargs = {"user": (ME, "Random")} if side == "user" else {"opponent": (OPP, "Random")}
    h.send(envelope("match_loading", h.new_key(), **kwargs))
    assert h.view.of("show_loading") == []


def test_card_hides_when_a_race_turns_out_random(h: Harness) -> None:
    key = h.new_key()
    h.send(envelope("match_loading", key, opponent=(OPP, None)))
    assert len(h.view.of("show_loading")) == 1
    h.send(envelope("match_loading", key, opponent=(OPP, "Random")))
    assert h.view.of("hide_loading") == [(key, "random")]


def test_match_started_within_cutoff_still_shows(h: Harness) -> None:
    key = h.new_key()
    h.send(envelope("match_started", key, display_time=5.0))
    assert len(h.view.of("show_loading")) == 1


def test_match_started_after_cutoff_does_not_show(h: Harness) -> None:
    h.send(envelope("match_started", h.new_key(), display_time=31.0))
    assert h.view.of("show_loading") == []


def test_in_progress_first_sighting_does_not_show(h: Harness) -> None:
    h.send(envelope("match_in_progress", h.new_key(), display_time=4.0))
    assert h.view.of("show_loading") == []


def test_card_hides_at_thirty_game_seconds(h: Harness) -> None:
    key = h.new_key()
    h.send(envelope("match_loading", key))
    h.send(envelope("match_started", key, display_time=1.0))
    h.send(envelope("match_in_progress", key, display_time=29.0))
    assert h.view.of("hide_loading") == []
    h.send(envelope("match_in_progress", key, display_time=30.0))
    assert h.view.of("hide_loading") == [(key, "in_game")]


@pytest.mark.parametrize("phase,reason", [("menu", "menu"), ("idle", "menu")])
def test_card_hides_when_leaving_the_match(h: Harness, phase: str, reason: str) -> None:
    key = h.new_key()
    h.send(envelope("match_loading", key))
    h.send({"type": "liveGameState", "phase": phase})
    assert h.view.of("hide_loading") == [(key, reason)]
    # Envelopes of the retired key no longer revive anything.
    h.send(envelope("match_loading", key))
    assert len(h.view.of("show_loading")) == 1


def test_card_hides_at_match_end(h: Harness) -> None:
    key = h.new_key()
    h.send(envelope("match_loading", key))
    h.end(key)
    assert (key, "match_ended") in h.view.of("hide_loading")


def test_new_game_key_replaces_the_previous_card(h: Harness) -> None:
    first, second = h.new_key(), h.new_key()
    h.send(envelope("match_loading", first))
    h.send(envelope("match_loading", second))
    assert h.view.of("hide_loading") == [(first, "new_game")]
    assert [m.game_key for m in h.view.of("show_loading")] == [first, second]
    # A late envelope of the previous key is ignored.
    h.view.clear()
    h.send(envelope("match_loading", first))
    assert h.view.calls == []


def test_pulse_re_emit_without_players_does_not_flip_state(h: Harness) -> None:
    key = h.new_key()
    h.send(envelope("match_loading", key))
    h.view.clear()
    # The bridge's late Pulse re-emit: no players, no displayTime.
    h.send(envelope("match_loading", key, with_players=False))
    assert "hide_loading" not in h.view.names()
    h.send(envelope("match_in_progress", key, display_time=12.0))
    h.send(envelope("match_in_progress", key, with_players=False))
    assert "hide_loading" not in h.view.names()


def test_card_is_shown_once_per_game(h: Harness) -> None:
    key = h.new_key()
    h.send(envelope("match_loading", key))
    h.ctl.not_now(key)
    h.pump()
    h.send(envelope("match_loading", key))
    h.send(envelope("match_started", key, display_time=2.0))
    assert len(h.view.of("show_loading")) == 1


def test_loading_card_safety_timeout(h: Harness) -> None:
    key = h.new_key()
    h.send(envelope("match_loading", key))
    h.advance(LOADING_CARD_MAX_SEC - 1)
    assert h.view.of("hide_loading") == []
    h.advance(1)
    assert h.view.of("hide_loading") == [(key, "timeout")]


# ----------------------------------------------------------------- prefs


def test_ask_at_loading_off_shows_no_card() -> None:
    h = Harness()
    h.api.prefs["askAtLoading"] = False
    h.boot()
    h.send(envelope("match_loading", h.new_key()))
    assert h.view.of("show_loading") == []
    assert h.api.calls_to("put_live_intent") == []


def test_disabled_shows_no_cards_and_fetches_no_options() -> None:
    h = Harness()
    h.api.prefs["enabled"] = False
    h.boot()
    key = h.new_key()
    h.play(key)
    assert h.view.calls == []
    assert h.api.calls_to("get_build_options") == []
    assert h.api.calls_to("put_live_intent") == []


def test_api_without_build_checkin_keeps_the_controller_dormant() -> None:
    h = Harness()
    h.api.fail_next("get_checkin_prefs", api_error(404, "unknown_preference_type"))
    h.boot()
    h.play(h.new_key())
    assert h.view.calls == []
    assert [name for name, *_ in h.api.calls] == ["get_checkin_prefs"]


def test_prefs_fetch_failure_keeps_defaults() -> None:
    h = Harness()
    h.api.fail_next("get_checkin_prefs", ConnectionError("offline"))
    h.boot()
    h.send(envelope("match_loading", h.new_key()))
    assert len(h.view.of("show_loading")) == 1
    assert h.ctl.prefs == CheckinPrefs()


def test_server_turning_cards_off_hides_the_loading_card(h: Harness) -> None:
    key = h.new_key()
    h.send(envelope("match_loading", key))
    h.api.prefs["askAtLoading"] = False
    h.ctl.on_intent_changed({"gameKey": key})
    h.pump()
    assert h.view.of("hide_loading") == [(key, "disabled")]
    assert h.view.prefs[-1].ask_at_loading is False


def test_disable_loading_writes_the_pref_releases_and_hides(h: Harness) -> None:
    key = h.new_key()
    h.send(envelope("match_loading", key))
    h.ctl.disable("loading")
    h.pump()
    assert h.api.calls_to("put_checkin_prefs")[-1][0][0] == {
        "enabled": True, "askAtLoading": False, "askAfterGame": True,
    }
    assert h.api.live_actions()[-1] == "release"
    assert h.view.of("hide_loading") == [(key, "disabled")]
    assert h.ctl.prefs.ask_at_loading is False


def test_settings_write_is_optimistic_and_reverts_on_failure(h: Harness) -> None:
    h.api.fail_next("put_checkin_prefs", ConnectionError("offline"))
    h.ctl.set_prefs(ask_after_game=False)
    h.pump()
    # Loaded at boot, optimistic while saving, then reverted.
    assert [p.ask_after_game for p in h.view.prefs] == [True, False, True]
    assert h.ctl.prefs.ask_after_game is True


def test_settings_writes_are_serialised_and_last_one_wins() -> None:
    executor = ManualExecutor()
    h = Harness(executor=executor)
    h.ctl.set_prefs(enabled=False)
    h.ctl.set_prefs(enabled=True, ask_at_loading=False)
    h.pump()
    assert len(executor.jobs) == 1
    executor.run_all()
    h.pump()
    executor.run_all()
    h.pump()
    writes = [args[0] for args, _ in h.api.calls_to("put_checkin_prefs")]
    assert writes == [
        {"enabled": False, "askAtLoading": True, "askAfterGame": True},
        {"enabled": True, "askAtLoading": False, "askAfterGame": True},
    ]
    assert h.ctl.prefs == CheckinPrefs(enabled=True, ask_at_loading=False)


def test_server_read_does_not_override_a_pending_settings_write() -> None:
    executor = ManualExecutor()
    h = Harness(executor=executor)
    h.ctl.refresh_prefs()
    h.pump()
    h.ctl.set_prefs(ask_at_loading=False)
    h.pump()
    executor.run(0)  # the read answers with the old value
    h.pump()
    assert h.ctl.prefs.ask_at_loading is False
    executor.run_all()
    h.pump()
    assert h.ctl.prefs.ask_at_loading is False


# ------------------------------------------------------------ declaring


def test_declare_collapses_and_locks_in(h: Harness) -> None:
    key = h.new_key()
    h.send(envelope("match_loading", key))
    h.ctl.declare(key, "custom:dt-3-gate")
    h.pump()

    declare = [b for b in h.api.live_bodies() if b["action"] == "declare"]
    assert declare == [{
        "action": "declare", "buildKey": "custom:dt-3-gate",
        "myRace": "Protoss", "oppRace": "Zerg", "oppName": OPP,
    }]
    assert h.api.calls_to("put_live_intent")[-1][1] == {"attempts": 2}
    model = _loading(h)
    assert model.collapsed is True
    assert model.locked_label == LOCKED_IN.format(name="DT into 3 Gate")
    assert model.can_change is True
    assert model.randomizer is None
    assert model.saving is False


def test_declare_shows_saving_until_the_server_answers() -> None:
    executor = ManualExecutor()
    h = Harness(executor=executor)
    key = h.new_key()
    h.send(envelope("match_loading", key))
    executor.run_all()
    h.pump()
    h.ctl.declare(key, "pvz-2-stargate-phoenix")
    h.pump()
    assert _loading(h).saving is True
    executor.run_all()
    h.pump()
    assert _loading(h).saving is False


def test_unknown_build_key_is_ignored(h: Harness) -> None:
    key = h.new_key()
    h.send(envelope("match_loading", key))
    h.ctl.declare(key, "made-up")
    h.ctl.declare("another|key|1", "custom:dt-3-gate")
    h.pump()
    assert "declare" not in h.api.live_actions()


def test_change_undeclares_and_reopens_the_list(h: Harness) -> None:
    key = h.new_key()
    h.send(envelope("match_loading", key))
    h.ctl.declare(key, "custom:dt-3-gate")
    h.pump()
    h.ctl.undeclare(key)
    h.pump()
    assert h.api.live_actions()[-1] == "undeclare"
    model = _loading(h)
    assert model.collapsed is False
    assert model.locked_label is None


def test_rapid_picks_collapse_to_the_last_one() -> None:
    executor = ManualExecutor()
    h = Harness(executor=executor)
    key = h.new_key()
    h.send(envelope("match_loading", key))
    executor.run_all()
    h.pump()
    h.ctl.declare(key, "custom:dt-3-gate")
    h.ctl.undeclare(key)
    h.ctl.declare(key, "pvz-2-stargate-phoenix")
    h.ctl.declare(key, "pvz-chargelot-all-in")
    h.pump()
    executor.run_all()
    h.pump()
    executor.run_all()
    h.pump()
    actions = [(b["action"], b.get("buildKey")) for b in h.api.live_bodies()[1:]]
    assert actions == [
        ("declare", "custom:dt-3-gate"),
        ("declare", "pvz-chargelot-all-in"),
    ]
    assert _loading(h).locked_key == "pvz-chargelot-all-in"


def test_failed_declare_keeps_the_pick_locally(h: Harness) -> None:
    key = h.new_key()
    h.send(envelope("match_loading", key))
    h.api.fail_next("put_live_intent", ConnectionError("offline"))
    h.ctl.declare(key, "custom:dt-3-gate")
    h.pump()
    model = _loading(h)
    assert model.collapsed is True
    assert model.status == STATUS_DECLARE_OFFLINE


def test_declare_rejected_as_unknown_reopens_the_list(h: Harness) -> None:
    key = h.new_key()
    h.send(envelope("match_loading", key))
    h.api.fail_next("put_live_intent", api_error(400, "unknown_build"))
    h.ctl.declare(key, "custom:dt-3-gate")
    h.pump()
    model = _loading(h)
    assert model.collapsed is False
    assert model.status == STATUS_DECLARE_UNAVAILABLE


# ------------------------------------------------------------ randomizer


def test_randomizer_strip_roll_now_and_rolled_chip(h: Harness) -> None:
    key = h.new_key()
    h.send(envelope("match_loading", key))
    strip = _loading(h).randomizer
    assert strip.label == RANDOMIZER_WILL_ROLL
    assert strip.can_roll_now is True

    h.ctl.roll_now(key)
    h.pump()
    assert h.api.live_actions()[-1] == "release"
    strip = _loading(h).randomizer
    assert strip.label == RANDOMIZER_ROLLING
    assert strip.can_roll_now is False

    h.api.live[key]["randomizer"] = {
        "key": "custom:dt-3-gate", "name": "DT into 3 Gate", "slug": "dt-3-gate", "source": "custom",
    }
    h.ctl.on_intent_changed({"gameKey": key})
    h.pump()
    model = _loading(h)
    assert model.randomizer.label == "🎲 Randomizer: DT into 3 Gate"
    rolled = [row.key for row in model.featured + model.more if row.rolled]
    assert rolled == ["custom:dt-3-gate"]
    # The rolled row keeps its place.
    assert [row.key for row in model.featured][0] == "custom:dt-3-gate"


def test_roll_now_is_sent_once(h: Harness) -> None:
    key = h.new_key()
    h.send(envelope("match_loading", key))
    h.ctl.roll_now(key)
    h.ctl.roll_now(key)
    h.pump()
    assert h.api.live_actions().count("release") == 1


def test_no_strip_without_randomizer(h: Harness) -> None:
    h.api.randomizer_enabled = False
    h.api.options["PvZ"] = options_payload("PvZ", option("pvz-a"))
    h.send(envelope("match_loading", h.new_key()))
    assert _loading(h).randomizer is None


def test_not_now_releases_the_hold_and_hides(h: Harness) -> None:
    key = h.new_key()
    h.send(envelope("match_loading", key))
    h.ctl.not_now(key)
    h.pump()
    assert h.api.live_actions()[-1] == "release"
    assert h.view.of("hide_loading") == [(key, "dismissed")]


def test_not_now_after_declaring_does_not_release(h: Harness) -> None:
    key = h.new_key()
    h.send(envelope("match_loading", key))
    h.ctl.declare(key, "custom:dt-3-gate")
    h.ctl.not_now(key)
    h.pump()
    assert "release" not in h.api.live_actions()


def test_web_pick_shows_on_the_card(h: Harness) -> None:
    key = h.new_key()
    h.send(envelope("match_loading", key))
    h.api.live[key]["declared"] = {
        "key": "pvz-2-stargate-phoenix", "name": "PvZ - 2 Stargate Phoenix",
        "slug": None, "source": "catalog", "via": "web",
    }
    h.ctl.on_intent_changed({"gameKey": key})
    h.pump()
    model = _loading(h)
    assert model.collapsed is True
    assert model.declared_elsewhere is True
    assert model.locked_label == PICKED_ON_WEB.format(name="PvZ - 2 Stargate Phoenix")


def test_web_pick_replaces_an_older_agent_pick(h: Harness) -> None:
    key = h.new_key()
    h.send(envelope("match_loading", key))
    h.ctl.declare(key, "custom:dt-3-gate")
    h.pump()
    h.api.live[key]["declared"] = {
        "key": "pvz-2-stargate-phoenix", "name": "PvZ - 2 Stargate Phoenix",
        "slug": None, "source": "catalog", "via": "web",
    }
    h.ctl.on_intent_changed({"gameKey": key})
    h.pump()
    assert _loading(h).locked_label == PICKED_ON_WEB.format(name="PvZ - 2 Stargate Phoenix")


def test_stale_live_read_cannot_undo_a_newer_declare() -> None:
    executor = ManualExecutor()
    h = Harness(executor=executor)
    key = h.new_key()
    h.send(envelope("match_loading", key))
    executor.run_all()
    h.pump()
    h.ctl.on_intent_changed({"gameKey": key})  # GET issued first …
    h.pump()
    h.ctl.declare(key, "custom:dt-3-gate")     # … then the declare
    h.pump()
    stale = h.api.get_live_intent(key)          # server state before declaring
    executor.jobs.pop(0)                         # hold the GET back …
    executor.run_all()                           # … while the declare lands
    h.pump()
    assert _loading(h).locked_key == "custom:dt-3-gate"
    # The GET (generation 2: after register, before declare) answers last.
    h.ctl._post(h.ctl._on_live_read, (key, 2), stale, None)
    h.pump()
    assert stale["declared"] is None
    assert _loading(h).locked_key == "custom:dt-3-gate"
    assert _loading(h).collapsed is True


def test_pings_for_unknown_or_old_games_are_ignored(h: Harness) -> None:
    h.ctl.on_intent_changed({"gameKey": "nobody|1"})
    h.ctl.on_intent_changed({"gameId": "nothing"})
    h.ctl.on_intent_changed({})
    h.pump()
    assert h.api.calls_to("get_live_intent") == []
    assert h.api.calls_to("get_game_intent") == []


# ----------------------------------------------------------------- rows


def test_rows_never_reorder_after_first_paint() -> None:
    executor = ManualExecutor()
    h = Harness(executor=executor)
    key = h.new_key()
    h.send(envelope("match_loading", key))
    executor.run_all()
    h.pump()
    first = _loading(h)
    order = [row.key for row in first.featured + first.more]

    # Records move on (another game finished) and the cache expires.
    h.api.options["PvZ"] = options_payload(
        "PvZ",
        option("pvz-chargelot-all-in", "PvZ - Chargelot All-in", games=30, wins=20, losses=10),
        option("pvz-new-build", "PvZ - New"),
        option("pvz-2-stargate-phoenix", "PvZ - 2 Stargate Phoenix", games=5, wins=3, losses=2),
        option("custom:dt-3-gate", "DT into 3 Gate", games=12, wins=7, losses=5, source="custom"),
        usual="pvz-chargelot-all-in",
    )
    h.ctl._ensure_options("PvZ", force=True)
    executor.run_all()
    h.pump()
    later = _loading(h)
    assert [row.key for row in later.featured + later.more] == order + ["pvz-new-build"]
    assert [row.key for row in later.featured] == [row.key for row in first.featured]
    chargelot = next(row for row in later.more if row.key == "pvz-chargelot-all-in")
    assert chargelot.record == "20–10"


def test_options_loading_then_error_state() -> None:
    executor = ManualExecutor()
    h = Harness(executor=executor)
    key = h.new_key()
    h.send(envelope("match_loading", key))
    assert h.view.last("show_loading").options_loading is True
    h.api.fail_next("get_build_options", ConnectionError("offline"), times=3)
    executor.run_all()
    h.pump()
    model = _loading(h)
    assert model.options_loading is False
    assert model.status == STATUS_OPTIONS_FAILED


def test_options_prefetch_for_the_users_race_and_cache_ttl(h: Harness) -> None:
    h.send(envelope("match_loading", h.new_key()))
    fetched = sorted(args[0] for args, _ in h.api.calls_to("get_build_options"))
    assert fetched == ["PvP", "PvT", "PvZ"]
    h.send(envelope("match_loading", h.new_key()))
    assert len(h.api.calls_to("get_build_options")) == 3
    h.advance(OPTIONS_TTL_SEC + 1)
    h.send(envelope("match_loading", h.new_key()))
    assert [args[0] for args, _ in h.api.calls_to("get_build_options")][3:] == ["PvZ"]


# ------------------------------------------------------------------ intro


def test_intro_shows_until_dismissed_and_is_persisted() -> None:
    h = Harness(intro_seen=False).boot()
    key = h.new_key()
    h.send(envelope("match_loading", key))
    assert h.view.last("show_loading").show_intro is True
    h.ctl.dismiss_intro()
    h.ctl.dismiss_intro()
    h.pump()
    assert _loading(h).show_intro is False
    assert h.intro_dismissed == [True]


# ---------------------------------------------------------------- plumbing


def test_view_errors_never_break_the_controller() -> None:
    class Exploding(FakeView):
        def show_loading(self, model):
            raise RuntimeError("qt went away")

    h = Harness(view=Exploding()).boot()
    key = h.new_key()
    h.send(envelope("match_loading", key))
    h.ctl.declare(key, "custom:dt-3-gate")
    h.pump()
    assert "declare" in h.api.live_actions()


def test_set_view_repaints_the_current_card(h: Harness) -> None:
    key = h.new_key()
    h.send(envelope("match_loading", key))
    late = FakeView()
    h.ctl.set_view(late)
    h.pump()
    assert [m.game_key for m in late.of("show_loading")] == [key]
    assert late.prefs == [CheckinPrefs()]


def test_threaded_start_attach_and_stop() -> None:
    api = FakeCheckinApi()
    view = FakeView()
    bus: EventBus = EventBus()
    ctl = BuildCheckinController(api=api, view=view)
    ctl.attach(bus)
    ctl.start()
    try:
        bus.publish(envelope("match_loading", f"{OPP}|{ME}|1700000000000"))
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and not view.of("show_loading"):
            time.sleep(0.01)
        assert len(view.of("show_loading")) == 1
    finally:
        ctl.stop()
    assert bus.subscriber_count == 0
    assert not any(t.name == "sc2tools-build-checkin" and t.is_alive()
                   for t in threading.enumerate())
    ctl.on_envelope(envelope("match_loading", f"{OPP}|{ME}|1700000009999"))
    assert ctl.run_pending() == 0


def test_inputs_never_block_the_caller() -> None:
    api = FakeCheckinApi()
    gate = threading.Event()
    original = api.put_live_intent

    def slow(*args, **kwargs):
        gate.wait(2.0)
        return original(*args, **kwargs)

    api.put_live_intent = slow  # type: ignore[method-assign]
    ctl = BuildCheckinController(api=api, view=FakeView())
    ctl.start()
    try:
        started = time.monotonic()
        for index in range(50):
            ctl.on_envelope(envelope("match_loading", f"{OPP}|{ME}|17000000{index:05d}"))
        assert time.monotonic() - started < 0.5
    finally:
        gate.set()
        ctl.stop()


def test_a_crashing_handler_is_contained() -> None:
    h = Harness(executor=SyncExecutor())
    h.ctl._post(lambda: 1 / 0)
    h.send(envelope("match_loading", h.new_key()))
    assert len(h.view.of("show_loading")) == 1


def test_prefetch_waits_until_check_ins_are_on() -> None:
    h = Harness()
    h.api.prefs["enabled"] = False
    h.boot()
    h.send(envelope("match_loading", h.new_key()))
    assert h.api.calls_to("get_build_options") == []
    h.ctl.set_prefs(enabled=True)
    h.pump()
    h.send(envelope("match_in_progress", h.new_key(), display_time=40.0))
    assert sorted(a[0] for a, _ in h.api.calls_to("get_build_options")) == ["PvP", "PvT", "PvZ"]


def test_declare_never_waits_behind_the_register_write() -> None:
    executor = ManualExecutor()
    h = Harness(executor=executor)
    key = h.new_key()
    h.send(envelope("match_loading", key))
    # Let the option lists load but hold the register write back.
    while len(executor.jobs) > 1:
        executor.run(0)
    h.pump()
    assert h.api.live_actions() == []
    h.ctl.declare(key, "custom:dt-3-gate")
    h.pump()
    assert len(executor.jobs) == 2
    executor.run(1)
    h.pump()
    assert h.api.live_actions() == ["declare"]
    executor.run_all()
    h.pump()
    model = _loading(h)
    assert model.locked_key == "custom:dt-3-gate" and model.saving is False


def test_view_learns_loaded_prefs_even_when_they_are_the_defaults() -> None:
    h = Harness()
    assert h.ctl.available is None
    h.boot()
    assert h.ctl.available is True
    assert h.view.prefs == [CheckinPrefs()]


def test_unavailable_api_is_reported() -> None:
    h = Harness()
    h.api.fail_next("get_checkin_prefs", api_error(404, "not_found"))
    h.boot()
    assert h.ctl.available is False
    assert h.view.prefs == []
