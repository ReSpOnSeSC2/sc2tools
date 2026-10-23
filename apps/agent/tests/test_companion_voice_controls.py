import textwrap

import pytest

from tests._gui_offscreen import run_gui_check


def run_voice_check(tmp_path, body):
    setup = '''
from copy import deepcopy
import time
from sc2tools_agent.companion_modes import default_modes
from sc2tools_agent.ui.companion_page import build_companion_page

class FakeSpeech(QtCore.QObject):
    statusChanged = QtCore.Signal(str)

    def __init__(self, owner):
        super().__init__(owner)
        self.attempts = []
        self.events = []
        self.accept = True
        self.active = False
        self.stops = 0
        self.shutdowns = 0

    def speak(self, text):
        self.attempts.append(text)
        self.events.append(("speak", text))
        self.active = bool(self.accept)
        self.statusChanged.emit("Reading current report" if self.accept else "System voice unavailable")
        return self.accept

    def stop(self):
        self.stops += 1
        self.active = False
        self.events.append(("stop", None))

    def shutdown(self):
        self.shutdowns += 1
        self.active = False
        self.events.append(("shutdown", None))

factories = []
def speech_factory(owner, *, QtCore):
    speaker = FakeSpeech(owner)
    factories.append(speaker)
    return speaker

state = {
    "preferences": {"overlaysEnabled": True, "opponentOverlay": False, "scoutingOverlay": False},
    "modes": default_modes(), "calls": [],
}
def handler(payload):
    state["calls"].append(deepcopy(payload))
    action = payload["action"]
    if action == "snapshot":
        return {"paired": True, "preferences": deepcopy(state["preferences"]), "modes": deepcopy(state["modes"]), "liveGame": None}
    if action == "preferences":
        state["preferences"] = deepcopy(payload["preferences"])
        return {"preferences": deepcopy(state["preferences"])}
    if action == "companion_modes":
        if "modes" in payload:
            state["modes"] = deepcopy(payload["modes"])
        return {"modes": deepcopy(state["modes"]), "preferences": deepcopy(state["preferences"])}
    if action == "ghost_state":
        return {"ghost": {"v": 1, "enabled": False, "slots": {}}, "references": {}}
    return {"items": []}

def wait_for(predicate):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        app.processEvents()
        if predicate():
            return
        QtTest.QTest.qWait(5)
    assert predicate(), "Companion did not settle its local fake handler"

page = build_companion_page(None, handler=handler, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets, speech_factory=speech_factory)
page.timer.stop()
wait_for(lambda: page._paired and not page._requests)
speaker = factories[0]
assert len(factories) == 1
assert speaker.parent() is page

def enable_voice():
    page.preference_checks["scoutingReadAloud"].setChecked(True)
    wait_for(lambda: not page._preference_busy and state["preferences"].get("scoutingReadAloud") is True)

def put_game(phase="match_started", key="game-a", name="Current opponent"):
    envelope = {
        "phase": phase, "gameKey": key, "capturedAt": time.time(),
        "players": [{"type": "user"}, {"type": "user"}],
        "opponent": {"name": name, "race": "Terran", "profile": {"mmr": 4000}},
        "streamerHistory": {"headToHead": {"wins": 2, "losses": 1},
            "opponentNotes": {"text": "Current opponent scouting note", "readAloud": True}},
    }
    page._snapshot = {"liveGame": envelope}
    page._snapshot_healthy = True
    return envelope

def render():
    page._update_overlays()
    app.processEvents()
'''
    script = setup + "\ntry:\n" + textwrap.indent(textwrap.dedent(body), "    ")
    script += "\nfinally:\n    page.shutdown()\n    page.deleteLater()\n    app.processEvents()\n"
    run_gui_check(tmp_path, script)


def test_voice_is_opt_in_persisted_and_independent_from_scouting_pin(tmp_path):
    run_voice_check(tmp_path, '''
        assert page._preferences["scoutingReadAloud"] is False
        assert not page.preference_checks["scoutingReadAloud"].isChecked()
        assert not speaker.attempts
        enable_voice()
        assert state["preferences"]["scoutingReadAloud"] is True
        assert state["preferences"]["scoutingOverlay"] is False
        assert any(call["action"] == "preferences" and call["preferences"]["scoutingReadAloud"] is True for call in state["calls"])
        page._modes["profiles"]["ladder"]["scoutingOverlay"] = False
        put_game()
        render()
        assert len(speaker.attempts) == 1
        assert not page.overlays["scouting"].isVisible()
        assert page.read_report_button.isEnabled()
        page._modes["profiles"]["ladder"]["scoutingReadAloud"] = False
        render()
        assert speaker.stops == 1
        assert not page.read_report_button.isEnabled()
        assert page._preferences["scoutingReadAloud"] is True
    ''')


def test_automatic_report_waits_briefly_for_enrichment_without_losing_opted_notes(tmp_path):
    run_voice_check(tmp_path, '''
        enable_voice()
        envelope = put_game()
        history = envelope.pop("streamerHistory")
        render()
        assert not speaker.attempts
        assert "Preparing" in page.voice_status.text()
        envelope["streamerHistory"] = history
        render()
        assert len(speaker.attempts) == 1
        assert "2 wins and 1 loss" in speaker.attempts[0]
        assert "Current opponent scouting note" in speaker.attempts[0]
        render()
        assert len(speaker.attempts) == 1
    ''')


def test_missing_enrichment_has_a_bounded_wait_then_truthful_partial_report(tmp_path):
    run_voice_check(tmp_path, '''
        enable_voice()
        envelope = put_game()
        envelope.pop("streamerHistory")
        render()
        assert not speaker.attempts
        page._speech_pending_at -= 7
        render()
        assert len(speaker.attempts) == 1
        assert "Current opponent" in speaker.attempts[0]
        assert "Your record" not in speaker.attempts[0]
        assert "scouting notes" not in speaker.attempts[0]
    ''')


def test_stop_cancels_pending_automatic_report_but_manual_repeat_remains_available(tmp_path):
    run_voice_check(tmp_path, '''
        enable_voice()
        envelope = put_game()
        history = envelope.pop("streamerHistory")
        render()
        page.stop_report_button.click()
        envelope["streamerHistory"] = history
        render()
        assert not speaker.attempts
        page.read_report_button.click()
        assert len(speaker.attempts) == 1
        render()
        assert len(speaker.attempts) == 1
    ''')


def test_header_voice_switch_and_assistance_checkbox_share_the_saved_switch(tmp_path):
    run_voice_check(tmp_path, '''
        page.voice_shortcut.click()
        wait_for(lambda: not page._preference_busy)
        assert page.preference_checks["scoutingReadAloud"].isChecked()
        assert page.voice_shortcut.text() == "Voice on"
        assert state["preferences"]["scoutingReadAloud"] is True
        page.preference_checks["scoutingReadAloud"].setChecked(False)
        wait_for(lambda: not page._preference_busy)
        assert not page.voice_shortcut.isChecked()
        assert page.voice_shortcut.text() == "Voice off"
        assert state["preferences"]["scoutingReadAloud"] is False
    ''')


def test_automatic_speech_waits_for_game_start_once_per_game_and_manual_repeat_is_explicit(tmp_path):
    run_voice_check(tmp_path, '''
        enable_voice()
        envelope = put_game(phase="match_loading")
        render()
        assert speaker.attempts == []
        envelope["phase"] = "match_started"
        render()
        assert len(speaker.attempts) == 1
        envelope["phase"] = "match_in_progress"
        for tick in range(3):
            render()
        assert len(speaker.attempts) == 1
        assert "Current opponent" in speaker.attempts[0]
        page.read_report_button.click()
        assert len(speaker.attempts) == 2
        page.stop_report_button.click()
        assert speaker.stops == 1
        assert not speaker.active
        render()
        assert len(speaker.attempts) == 2
        put_game(key="game-b", name="Next opponent")
        render()
        assert len(speaker.attempts) == 3
        assert "Next opponent" in speaker.attempts[-1]
    ''')


@pytest.mark.parametrize("change", [
    "page._paired = False",
    "page._snapshot_healthy = False",
    "page._preferences['overlaysEnabled'] = False",
    "page._preferences['scoutingReadAloud'] = False",
    "page._modes['profiles']['ladder']['scoutingReadAloud'] = False",
    "envelope['capturedAt'] = time.time() - 31",
    "envelope['capturedAt'] = time.time() + 10",
    "envelope.pop('capturedAt')",
    "envelope['receivedAt'] = (time.time() - 31) * 1000",
    "envelope['players'] = []",
    "envelope['players'] = [{'type': 'user'}] * 4",
    "envelope['players'][1]['type'] = 'computer'",
    "envelope['isReplay'] = True",
    "envelope['gameKey'] = ''",
    "envelope['opponent']['name'] = ''",
    "envelope['gameKey'] = '   '",
    "envelope['opponent']['name'] = '   '",
])
def test_unsafe_or_unidentified_live_context_cannot_start_speech(tmp_path, change):
    run_voice_check(tmp_path, f'''
        enable_voice()
        envelope = put_game()
        {change}
        render()
        assert not speaker.attempts
        assert not page.read_report_button.isEnabled()
    ''')


@pytest.mark.parametrize("change", [
    "page._paired = False",
    "page._snapshot_healthy = False",
    "page._preferences['overlaysEnabled'] = False",
    "page._preferences['scoutingReadAloud'] = False",
    "envelope['capturedAt'] = time.time() - 31",
    "envelope['phase'] = 'match_ended'",
])
def test_active_readout_stops_when_its_current_permission_or_game_expires(tmp_path, change):
    run_voice_check(tmp_path, f'''
        enable_voice()
        envelope = put_game()
        render()
        assert speaker.active
        {change}
        render()
        assert speaker.stops == 1
        assert not speaker.active
        assert not page.read_report_button.isEnabled()
        render()
        assert speaker.stops == 1
        assert len(speaker.attempts) == 1
    ''')


def test_game_change_stops_previous_readout_before_waiting_for_next_game(tmp_path):
    run_voice_check(tmp_path, '''
        enable_voice()
        put_game()
        render()
        envelope = put_game(phase="match_loading", key="game-b", name="Next opponent")
        render()
        assert not speaker.active
        assert speaker.stops == 1
        assert len(speaker.attempts) == 1
        envelope["phase"] = "match_started"
        render()
        assert speaker.active
        assert speaker.events[-2][0] == "stop"
        assert speaker.events[-1][0] == "speak"
        assert "Next opponent" in speaker.attempts[-1]
    ''')


def test_browsing_does_not_read_selected_profile_and_manual_report_uses_current_match(tmp_path):
    run_voice_check(tmp_path, '''
        enable_voice()
        put_game()
        render()
        assert len(speaker.attempts) == 1
        page._detail = {"name": "Browsed history player", "race": "Zerg", "mmr": 5000,
                        "notes": "Private browsed note", "last5GamesScouting": []}
        page._render_detail()
        render()
        assert len(speaker.attempts) == 1
        page.read_report_button.click()
        assert len(speaker.attempts) == 2
        assert "Current opponent" in speaker.attempts[-1]
        assert "Browsed history player" not in speaker.attempts[-1]
        assert "Private browsed note" not in speaker.attempts[-1]
        page._snapshot = {"liveGame": {"phase": "menu"}}
        render()
        assert not page.read_report_button.isEnabled()
        page._render_detail()
        assert len(speaker.attempts) == 2
    ''')


def test_failed_system_voice_is_visible_manual_retryable_and_shutdown_is_idempotent(tmp_path):
    run_voice_check(tmp_path, '''
        enable_voice()
        speaker.accept = False
        put_game()
        render()
        assert page.voice_status.text() == "System voice unavailable"
        assert len(speaker.attempts) == 1
        render()
        assert len(speaker.attempts) == 1
        speaker.accept = True
        page.read_report_button.click()
        assert len(speaker.attempts) == 2
        assert speaker.active
        speaker.statusChanged.emit("Finished current report")
        assert page.voice_status.text() == "Finished current report"
        page.shutdown()
        assert speaker.shutdowns == 1
        assert not speaker.active
        page.shutdown()
        assert speaker.shutdowns == 1
    ''')


@pytest.mark.parametrize("change", [
    "page._paired = False",
    "page._preferences['overlaysEnabled'] = False",
    "page._preferences['scoutingReadAloud'] = False",
    "page._modes['profiles']['ladder']['scoutingReadAloud'] = False",
    "envelope['players'][1]['type'] = 'computer'",
    "envelope['opponent']['name'] = ''",
])
def test_manual_read_revalidates_permission_and_identity_at_click_time(tmp_path, change):
    run_voice_check(tmp_path, f'''
        enable_voice()
        envelope = put_game()
        render()
        assert page.read_report_button.isEnabled()
        assert len(speaker.attempts) == 1
        {change}
        page.read_report_button.click()
        assert len(speaker.attempts) == 1
    ''')
