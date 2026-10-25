"""Game-screen assistance requires the user's feature choices."""

from sc2tools_agent.build_checkin.models import CheckinPrefs
from sc2tools_agent.companion import normalize_preferences
from sc2tools_agent.state import AgentState, load_state, save_state
from tests.build_checkin_fakes import Harness, ManualExecutor, envelope


def test_new_agent_has_no_automatic_game_screen_assistance(tmp_path):
    for state in (AgentState(), load_state(tmp_path)):
        assert not any(normalize_preferences(state.companion_preferences).values())
        assert not state.companion_session_enabled
        assert not state.companion_ghost.get("enabled", False)
        assert not state.show_scouting_at_loading
        assert state.build_checkin_prefs is None
    assert CheckinPrefs().loading_cards is False
    assert CheckinPrefs().postgame_cards is False


def test_fresh_account_stays_quiet_for_loading_and_postgame():
    h = Harness()
    h.api.prefs = {}
    h.boot()
    assert h.ctl.prefs == CheckinPrefs()
    assert h.ctl.scouting_enabled is False
    h.play(h.new_key())
    assert not h.view.of("show_loading")
    assert not h.view.of("show_postgame")


def test_new_offline_account_does_not_fall_back_to_enabled_prompts():
    h = Harness()
    h.api.fail_next("get_checkin_prefs", ConnectionError("offline"))
    h.boot()
    h.play(h.new_key())
    assert h.ctl.prefs == CheckinPrefs()
    assert not h.view.of("show_loading")
    assert not h.view.of("show_postgame")


def test_selecting_one_prompt_does_not_enable_the_other():
    h = Harness()
    h.api.prefs = {}
    h.boot()
    h.ctl.set_prefs(enabled=True, ask_at_loading=True)
    h.pump()
    assert h.ctl.prefs == CheckinPrefs(enabled=True, ask_at_loading=True)
    key = h.new_key()
    h.send(envelope("match_loading", key))
    assert len(h.view.of("show_loading")) == 1
    h.end(key)
    assert not h.view.of("show_postgame")
    h.ctl.set_prefs(ask_at_loading=False, ask_after_game=True)
    h.pump()
    h.play(h.new_key())
    assert len(h.view.of("show_loading")) == 1
    assert len(h.view.of("show_postgame")) == 1


def test_first_server_opt_in_can_show_loading_without_another_game_update():
    executor = ManualExecutor()
    h = Harness(executor=executor)
    h.send(envelope("match_loading", h.new_key()))
    assert not h.view.of("show_loading")
    executor.run_all()
    h.pump()
    assert len(h.view.of("show_loading")) == 1
    assert len(h.view.prefs) == 1


def test_saved_opt_ins_survive_loading_and_saving(tmp_path):
    prefs = {"enabled": True, "askAtLoading": True, "askAfterGame": True}
    panels = {"overlaysEnabled": True, "opponentOverlay": True,
              "scoutingOverlay": True, "scoutingReadAloud": True}
    save_state(tmp_path, AgentState(
        build_checkin_prefs=prefs, companion_preferences=panels,
        show_scouting_at_loading=True, companion_session_enabled=True,
        companion_ghost={"v": 1, "enabled": True, "slots": {}},
    ))
    restored = load_state(tmp_path)
    assert restored.build_checkin_prefs == prefs
    assert normalize_preferences(restored.companion_preferences) == panels
    assert restored.show_scouting_at_loading is True
    assert restored.companion_session_enabled is True
    assert restored.companion_ghost["enabled"] is True
