"""Stream Guardian: settings, the four rules, the OBS reads, the loop, and the service and Dock wiring."""
import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from sc2tools_agent.streaming import guardian_rules as rules
from sc2tools_agent.streaming.cloud_client import CloudStreamingClient
from sc2tools_agent.streaming.guardian import (HEARTBEAT_SECONDS, IDLE_SECONDS, LIVE_SECONDS, MESSAGES, OFF_SECONDS,
                                               RETRY_SECONDS, UNREACHABLE_SECONDS, GameWatch, StreamGuardian)
from sc2tools_agent.streaming.guardian_probe import ObsGuardianProbe
from sc2tools_agent.streaming.guardian_settings import RULES, configure_guardian_settings, load_guardian_settings
from sc2tools_agent.streaming.service import StreamService
from sc2tools_agent.ui.tray import TrayUI
from tests.test_stream_title_controller import deny_network, live_event  # noqa: F401

ALL_OFF = {rule: False for rule in RULES}


def on(*names):
    return {rule: rule in names for rule in RULES}


def reading(**changes):
    base = {"streaming": True, "reconnecting": False, "skipped": 0, "total": 0, "recording": False,
            "capturing": True, "scene": "Live Scene", "muted": False}
    return {**base, **changes}


def game(active_since=None, last_end=None):
    return SimpleNamespace(active_since=active_since, last_end=last_end)


# ---------- settings ----------

def test_every_switch_starts_off_and_a_damaged_save_loads_as_off():
    assert load_guardian_settings(None) == {"switches": ALL_OFF, "microphone": ""}
    damaged = {"switches": {"mic_muted": "yes", "stream_unstable": 1, "not_recording": True}, "microphone": " padded "}
    assert load_guardian_settings(damaged) == {"switches": on("not_recording"), "microphone": ""}


def test_saving_needs_real_booleans_for_all_four_and_a_microphone_for_the_mute_rule():
    assert configure_guardian_settings({"switches": on("stuck_on_break"), "microphone": "  Mic/Aux "}) == {
        "switches": on("stuck_on_break"), "microphone": "Mic/Aux"}
    for payload in ({}, {"switches": {"mic_muted": True}}, {"switches": {**ALL_OFF, "mic_muted": "true"}},
                    {"switches": {**ALL_OFF, "extra": False}}, {"switches": on("mic_muted")},
                    {"switches": ALL_OFF, "microphone": "bad\nname"}, {"switches": ALL_OFF, "microphone": 5}):
        with pytest.raises(ValueError):
            configure_guardian_settings(payload)


# ---------- rules ----------

def test_a_microphone_muted_for_two_minutes_while_live_warns_from_when_it_was_muted():
    rule = rules.MicMuted()
    assert rule.update(reading(muted=True), game(), 1000) is None
    assert rule.update(reading(muted=True), game(), 1000 + rules.MIC_MUTED_SECONDS - 1) is None
    assert rule.update(reading(muted=True), game(), 1000 + rules.MIC_MUTED_SECONDS) == 1000


@pytest.mark.parametrize("cleared", [reading(muted=False), reading(muted=None), reading(streaming=False, muted=True), None])
def test_unmuting_going_offline_or_an_unknown_input_clears_the_mute_clock(cleared):
    rule = rules.MicMuted()
    rule.update(reading(muted=True), game(), 1000)
    assert rule.update(cleared, game(), 1500) is None
    assert rule.update(reading(muted=True), game(), 1500 + rules.MIC_MUTED_SECONDS - 1) is None


def test_a_stream_that_is_reconnecting_warns_at_once_and_clears_after_two_clean_readings():
    rule = rules.StreamUnstable()
    assert rule.update(reading(reconnecting=True), game(), 50) == 50
    assert rule.update(reading(skipped=0, total=100), game(), 55) == 50
    assert rule.update(reading(skipped=0, total=200), game(), 60) == 50
    assert rule.update(reading(skipped=0, total=300), game(), 65) is None


def test_skipped_frames_warn_on_the_second_bad_reading_dated_from_the_first():
    rule = rules.StreamUnstable()
    assert rule.update(reading(skipped=0, total=1000), game(), 10) is None  # the baseline
    assert rule.update(reading(skipped=100, total=1100), game(), 15) is None
    assert rule.update(reading(skipped=200, total=1200), game(), 20) == 15
    assert rule.update(reading(skipped=200, total=1300), game(), 25) == 15
    assert rule.update(reading(skipped=200, total=1400), game(), 30) is None


def test_a_few_skipped_frames_and_too_little_video_never_warn():
    rule = rules.StreamUnstable()
    rule.update(reading(skipped=0, total=1000), game(), 10)
    for step in range(1, 6):
        total = 1000 + step * 1000
        assert rule.update(reading(skipped=step * 20, total=total), game(), 10 + step * 5) is None  # 2 percent
    rule = rules.StreamUnstable()
    rule.update(reading(skipped=0, total=100), game(), 10)
    for step in range(1, 5):  # 20 new frames a reading, all skipped: judged only once 60 have gathered, and one verdict is not two
        assert rule.update(reading(skipped=step * 20, total=100 + step * 20), game(), 10 + step * 5) is None


def test_a_new_stream_starts_the_frame_count_over_and_going_offline_forgets_the_incident():
    rule = rules.StreamUnstable()
    rule.update(reading(skipped=0, total=1000), game(), 10)
    rule.update(reading(skipped=500, total=1100), game(), 15)
    assert rule.update(reading(skipped=0, total=50), game(), 20) is None  # counters went backwards: a new stream
    rule.update(reading(reconnecting=True), game(), 25)
    assert rule.update(reading(streaming=False), game(), 30) is None
    assert rule.update(reading(skipped=0, total=100), game(), 35) is None


def test_a_game_with_no_capture_warns_after_a_few_seconds_from_the_game_start_until_either_starts():
    rule = rules.NotCapturing()
    idle = reading(streaming=False, capturing=False)
    assert rule.update(idle, game(), 1000) is None
    assert rule.update(idle, game(active_since=1000), 1000 + rules.GAME_GRACE_SECONDS - 1) is None
    assert rule.update(idle, game(active_since=1000), 1000 + rules.GAME_GRACE_SECONDS) == 1000
    assert rule.update(reading(streaming=False, recording=True, capturing=True), game(active_since=1000), 1100) is None
    assert rule.update(None, game(active_since=1000), 1100) is None  # OBS closed: nothing is known
    assert rule.update(idle, game(last_end=1050), 1100) is None  # the game is over


@pytest.mark.parametrize("scene", ["BRB", "Be Right Back", "Starting Soon", "Stream break", "intermission", "AFK screen", "Away"])
def test_break_scenes_are_found_by_name(scene):
    assert rules.BREAK_SCENE.search(scene)


@pytest.mark.parametrize("scene", ["Live Scene", "Gameplay", "Breakfast cam", "Brbright", "SC2 Tools — Between games", ""])
def test_game_and_between_game_scenes_are_not_break_scenes(scene):
    assert not rules.BREAK_SCENE.search(scene)


def test_live_on_a_break_scene_warns_twenty_minutes_after_the_later_of_the_scene_and_the_last_game():
    rule = rules.StuckOnBreak()
    brb = reading(scene="BRB")
    assert rule.update(brb, game(last_end=100), 1000) is None
    assert rule.update(brb, game(last_end=100), 1000 + rules.BREAK_SECONDS - 1) is None
    assert rule.update(brb, game(last_end=100), 1000 + rules.BREAK_SECONDS) == 1000
    rule = rules.StuckOnBreak()
    rule.update(brb, game(), 1000)
    assert rule.update(brb, game(last_end=1500), 1000 + rules.BREAK_SECONDS) is None  # a game just ended
    assert rule.update(brb, game(last_end=1500), 1500 + rules.BREAK_SECONDS) == 1500


def test_leaving_the_break_scene_or_going_offline_clears_it():
    rule = rules.StuckOnBreak()
    rule.update(reading(scene="BRB"), game(), 1000)
    assert rule.update(reading(scene="Live Scene"), game(), 3000) is None
    assert rule.update(reading(scene="BRB"), game(), 3001 + rules.BREAK_SECONDS - 2) is None  # the clock restarted
    rule.update(reading(scene="BRB"), game(), 5000)
    assert rule.update(reading(streaming=False, scene="BRB"), game(), 9000) is None
    assert rule.update(None, game(), 9001) is None


def test_a_rule_that_is_off_is_never_asked_and_forgets_its_clock():
    guard = rules.GuardianRules()
    muted = reading(muted=True)
    assert guard.evaluate(on("mic_muted"), muted, game(), 1000) == {}
    assert guard.evaluate(on("mic_muted"), muted, game(), 1000 + rules.MIC_MUTED_SECONDS) == {"mic_muted": 1000}
    assert guard.evaluate(ALL_OFF, muted, game(), 2000) == {}
    assert guard.evaluate(on("mic_muted"), muted, game(), 2000 + rules.MIC_MUTED_SECONDS) == {}  # starts fresh, not stale


# ---------- OBS reads ----------

def fake_obs(**changes):
    values = {"streaming": True, "reconnecting": False, "skipped": 4, "total": 900, "recording": False,
              "scene": "Live Scene", "muted": True, "outputs": []}
    values.update(changes)
    raw = Mock()
    raw.get_stream_status.return_value = SimpleNamespace(output_active=values["streaming"],
        output_reconnecting=values["reconnecting"], output_skipped_frames=values["skipped"], output_total_frames=values["total"])
    raw.get_record_status.return_value = SimpleNamespace(output_active=values["recording"])
    raw.get_current_program_scene.return_value = SimpleNamespace(current_program_scene_name=values["scene"])
    raw.get_input_mute.return_value = SimpleNamespace(input_muted=values["muted"])
    raw.get_output_list.return_value = SimpleNamespace(outputs=values["outputs"])
    raw.get_output_status.return_value = SimpleNamespace(output_active=False)
    return raw


def probe_for(raw):
    return ObsGuardianProbe(lambda: {}, factory=lambda **_: raw)


def test_a_live_reading_carries_frames_scene_and_the_chosen_inputs_mute():
    raw = fake_obs()
    assert probe_for(raw)("Mic/Aux") == {"streaming": True, "reconnecting": False, "skipped": 4, "total": 900,
        "recording": False, "scene": "Live Scene", "muted": True, "capturing": True}
    raw.get_input_mute.assert_called_once_with("Mic/Aux")


def test_while_not_live_only_the_two_status_reads_are_made():
    raw = fake_obs(streaming=False)
    result = probe_for(raw)("Mic/Aux")
    assert result["streaming"] is False and result["capturing"] is False and result["scene"] is None and result["muted"] is None
    raw.get_current_program_scene.assert_not_called()
    raw.get_input_mute.assert_not_called()
    raw.get_output_list.assert_not_called()


def test_no_chosen_microphone_asks_nothing_and_an_unknown_input_reads_as_unknown():
    raw = fake_obs()
    assert probe_for(raw)("")["muted"] is None
    raw.get_input_mute.assert_not_called()
    raw.get_input_mute.side_effect = RuntimeError("no such input")
    assert probe_for(raw)("Gone")["muted"] is None


def test_plugin_outputs_are_asked_only_on_request_and_only_when_nothing_native_runs():
    plugin = [{"outputName": "aitum_multi_output"}]
    raw = fake_obs(streaming=False, outputs=plugin)
    assert probe_for(raw)("", plugin_outputs=True)["capturing"] is False
    raw.get_output_status.assert_called_once_with("aitum_multi_output")
    raw = fake_obs(streaming=False, outputs=plugin)
    raw.get_output_status.return_value = SimpleNamespace(output_active=True)
    assert probe_for(raw)("", plugin_outputs=True)["capturing"] is True
    raw = fake_obs(streaming=False, outputs=plugin)
    assert probe_for(raw)("")["capturing"] is False
    raw.get_output_list.assert_not_called()


def test_an_unreachable_or_disabled_obs_is_no_reading_and_reconnects_next_time():
    def refuse(**_):
        raise ConnectionRefusedError()
    assert ObsGuardianProbe(lambda: {}, factory=refuse)("Mic") is None
    assert ObsGuardianProbe(lambda: {}, disabled=True)("Mic") is None
    raw = fake_obs()
    raw.get_stream_status.side_effect = RuntimeError("socket closed")
    probe = probe_for(raw)
    assert probe("Mic") is None and probe.raw is None
    raw.disconnect.assert_called_once()


def test_the_microphone_picker_lists_sound_inputs_sorted_and_reports_a_closed_obs():
    raw = Mock()
    raw.get_input_list.return_value = SimpleNamespace(inputs=[
        {"inputName": "Webcam", "inputKind": "dshow_input"}, {"inputName": "mic", "inputKind": "wasapi_input_capture"},
        {"inputName": "Headset", "inputKind": "wasapi_input_capture"}, {"inputName": "Game", "inputKind": "wasapi_process_output_capture"},
        {"inputKind": "wasapi_input_capture"}, "junk"])
    assert probe_for(raw).inputs() == ["Headset", "mic"]
    refused = ObsGuardianProbe(lambda: {}, factory=lambda **_: (_ for _ in ()).throw(ConnectionRefusedError()))
    with pytest.raises(ValueError, match="OBS could not be reached"):
        refused.inputs()
    with pytest.raises(ValueError):
        ObsGuardianProbe(lambda: {}, disabled=True).inputs()


# ---------- the loop ----------

class Harness:
    """A guardian with a scripted OBS, a clock, and the notice and Dock calls recorded."""

    def __init__(self, switches, microphone="Mic"):
        self.now = 10_000.0
        self.readings, self.calls, self.notices, self.sent, self.saved = [], [], [], [], []
        self.fail_send = False
        probe = Mock(side_effect=self.read)
        self.probe = probe
        self.guardian = StreamGuardian(probe, {"switches": switches, "microphone": microphone}, persist=self.saved.append,
                                       notify=self.notices.append, send=self.send, clock=lambda: self.now)

    def read(self, microphone, plugin_outputs=False):
        self.calls.append((microphone, plugin_outputs))
        return self.readings.pop(0) if len(self.readings) > 1 else self.readings[0]

    def send(self, warnings):
        if self.fail_send:
            raise ValueError("no account")
        self.sent.append(warnings)

    def tick(self, reading_, step=5):
        self.readings = [reading_]
        self.now += step
        return self.guardian.tick()


def test_with_every_switch_off_obs_is_never_read_and_its_connection_is_let_go():
    harness = Harness(ALL_OFF)
    assert harness.tick(reading()) == OFF_SECONDS
    assert harness.calls == [] and harness.sent == []
    harness.probe.close.assert_called()


def test_a_warning_notifies_once_per_incident_and_reaches_the_dock_with_its_start_time():
    harness = Harness(on("mic_muted"))
    harness.tick(reading(muted=True))
    started = harness.now
    harness.tick(reading(muted=True), step=rules.MIC_MUTED_SECONDS)
    assert harness.notices == [MESSAGES["mic_muted"]]
    assert harness.sent == [[{"rule": "mic_muted", "since": int(started * 1000)}]]
    harness.tick(reading(muted=True))
    assert len(harness.notices) == 1 and len(harness.sent) == 1
    assert harness.guardian.snapshot()["active"] == ["mic_muted"] and harness.guardian.dock_ok is True


def test_the_warning_clears_with_its_cause_and_a_new_incident_warns_again():
    harness = Harness(on("mic_muted"))
    harness.tick(reading(muted=True))
    harness.tick(reading(muted=True), step=rules.MIC_MUTED_SECONDS)
    harness.tick(reading(muted=False))
    assert harness.sent[-1] == [] and harness.guardian.snapshot()["active"] == []
    harness.tick(reading(muted=True))
    harness.tick(reading(muted=True), step=rules.MIC_MUTED_SECONDS)
    assert harness.notices == [MESSAGES["mic_muted"]] * 2


def test_an_unchanged_warning_is_repeated_to_the_dock_every_minute_so_it_does_not_expire():
    harness = Harness(on("mic_muted"))
    harness.tick(reading(muted=True))
    harness.tick(reading(muted=True), step=rules.MIC_MUTED_SECONDS)
    harness.tick(reading(muted=True), step=HEARTBEAT_SECONDS - 1)
    assert len(harness.sent) == 1
    harness.tick(reading(muted=True), step=1)
    assert len(harness.sent) == 2


def test_a_dock_that_cannot_be_reached_still_gets_the_tray_notice_and_is_retried_later():
    harness = Harness(on("mic_muted"))
    harness.fail_send = True
    harness.tick(reading(muted=True))
    harness.tick(reading(muted=True), step=rules.MIC_MUTED_SECONDS)
    assert harness.notices == [MESSAGES["mic_muted"]] and harness.guardian.dock_ok is False
    harness.fail_send = False
    harness.tick(reading(muted=True), step=RETRY_SECONDS - 1)
    assert harness.sent == []
    harness.tick(reading(muted=True), step=1)
    assert len(harness.sent) == 1 and harness.guardian.dock_ok is True


def test_a_failing_notice_never_stops_the_dock_banner():
    harness = Harness(on("mic_muted"))
    harness.guardian.notify = Mock(side_effect=RuntimeError("tray gone"))
    harness.tick(reading(muted=True))
    harness.tick(reading(muted=True), step=rules.MIC_MUTED_SECONDS)
    assert len(harness.sent) == 1


@pytest.mark.parametrize("current,expected", [
    (None, UNREACHABLE_SECONDS), (reading(streaming=False, capturing=False), IDLE_SECONDS), (reading(), LIVE_SECONDS)])
def test_checks_are_never_closer_than_five_seconds_and_slow_down_while_idle_or_unreachable(current, expected):
    assert Harness(on("mic_muted")).tick(current) == expected
    assert LIVE_SECONDS >= 5


def test_plugin_outputs_are_asked_only_while_a_game_runs_with_the_capture_rule_on():
    harness = Harness(on("not_recording", "mic_muted"))
    harness.tick(reading(streaming=False, capturing=False))
    assert harness.calls[-1] == ("Mic", False)
    harness.guardian.on_game_event(live_event(1, key="g1"))
    assert harness.guardian.game.active_since is not None
    assert harness.tick(reading(streaming=False, capturing=False)) == LIVE_SECONDS
    assert harness.calls[-1] == ("Mic", True)
    harness.guardian.settings = {"switches": on("mic_muted"), "microphone": "Mic"}
    harness.tick(reading(streaming=False, capturing=False))
    assert harness.calls[-1] == ("Mic", False)


def test_a_game_that_starts_with_obs_idle_warns_after_the_grace_and_clears_when_obs_goes_live():
    harness = Harness(on("not_recording"))
    harness.guardian.on_game_event(live_event(1, key="g1"))
    idle = reading(streaming=False, capturing=False)
    harness.tick(idle, step=1)
    assert harness.notices == []
    harness.tick(idle, step=rules.GAME_GRACE_SECONDS)
    assert harness.notices == [MESSAGES["not_recording"]] and harness.sent[-1][0]["rule"] == "not_recording"
    harness.tick(reading(), step=5)
    assert harness.sent[-1] == []


def test_the_game_watch_follows_play_ignores_replays_and_partial_telemetry():
    watch = GameWatch()
    watch.on_event(live_event(1, key="g1", is_replay=True), 100)
    assert watch.active_since is None
    watch.on_event(SimpleNamespace(phase="match_loading", game_state=None), 100)
    assert watch.active_since is None
    watch.on_event(live_event(1, key="g1"), 100)
    watch.on_event(live_event(2, key="g1", phase="match_in_progress"), 140)
    assert watch.active_since == 100
    watch.on_event(live_event(3, key="g1", phase="match_in_progress", is_replay=True), 150)
    assert watch.active_since is None and watch.last_end == 150
    watch.on_event(live_event(4, key="g2"), 200)
    watch.on_event(live_event(5, key="g2", phase="menu"), 260)
    assert watch.active_since is None and watch.last_end == 260


def test_saving_persists_wakes_the_loop_and_the_microphone_picker_is_kept():
    harness = Harness(ALL_OFF)
    harness.guardian.configure({"switches": on("mic_muted"), "microphone": "Mic"})
    assert harness.saved == [{"switches": on("mic_muted"), "microphone": "Mic"}] and harness.guardian.wake.is_set()
    harness.probe.inputs.return_value = ["Mic", "Headset"]
    harness.guardian.refresh_inputs()
    assert harness.guardian.snapshot()["inputs"] == ["Mic", "Headset"]
    with pytest.raises(ValueError):
        harness.guardian.configure({"switches": on("mic_muted"), "microphone": ""})
    assert len(harness.saved) == 1


# ---------- service, cloud and tray ----------

@pytest.fixture
def service(tmp_path):
    calls = []

    def transport(method, url, **kwargs):
        calls.append((method, url, kwargs.get("json")))
        return SimpleNamespace(status_code=200, json=lambda: {"warnings": []})
    client = CloudStreamingClient(lambda: ("https://api.sc2tools.com", "token"), transport=transport)
    instance = StreamService(tmp_path, lambda: {}, no_obs=True, cloud_client=client)
    yield instance, calls, tmp_path
    instance.close()


def test_saved_settings_reach_the_snapshot_and_survive_a_restart(service):
    instance, _, directory = service
    instance.action({"action": "configure_guardian", "switches": on("stuck_on_break"), "microphone": ""})
    assert instance.status()["guardian"]["switches"] == on("stuck_on_break")
    saved = json.loads(next(directory.rglob("youtube-button-helper.config.private.json")).read_text(encoding="utf-8"))
    assert saved["stream_guardian"] == {"switches": on("stuck_on_break"), "microphone": ""}
    instance.close()  # the account's process lock is held until the service lets go
    again = StreamService(directory, lambda: {}, no_obs=True, cloud_client=instance.cloud_client)
    try:
        assert again.guardian.settings["switches"] == on("stuck_on_break")
    finally:
        again.close()


def test_a_fresh_service_has_every_guardian_switch_off(service):
    instance, _, _ = service
    assert instance.status()["guardian"]["switches"] == ALL_OFF


def test_a_game_event_reaches_both_the_title_worker_and_the_guardian(service):
    instance, _, _ = service
    instance.guardian.on_game_event = Mock()
    instance.titles.worker.on_event = Mock()
    event = live_event(1, key="g1")
    instance.on_game_event(event)
    instance.guardian.on_game_event.assert_called_once_with(event)
    instance.titles.worker.on_event.assert_called_once_with(event)


def test_the_dock_gets_warnings_through_the_paired_account_and_a_local_setup_says_why_not(service):
    instance, calls, _ = service
    instance._send_guardian([{"rule": "mic_muted", "since": 5}])
    assert calls == [("POST", "https://api.sc2tools.com/v1/agent/streaming/guardian", {"warnings": [{"rule": "mic_muted", "since": 5}]})]
    instance.account_mode = "local"
    with pytest.raises(ValueError, match="Pair this agent"):
        instance._send_guardian([])


def test_notices_go_to_the_tray_only_once_it_exists(service):
    instance, _, _ = service
    instance._notify_guardian("nothing listens yet")
    tray = Mock()
    instance.notify = tray
    instance._notify_guardian("Mic muted")
    tray.assert_called_once_with("Mic muted", title="SC2 Tools Stream Guardian")


def test_listing_obs_inputs_is_an_explicit_action_that_needs_no_account(service):
    instance, _, _ = service
    instance.guardian.probe = Mock(inputs=Mock(return_value=["Mic"]))
    instance.action({"action": "list_obs_inputs"})
    assert instance.status()["guardian"]["inputs"] == ["Mic"]


def test_the_loop_starts_and_stops_with_the_service(service):
    instance, _, _ = service
    instance.start()
    assert instance.guardian.thread.is_alive()
    instance.close()
    instance.guardian.thread.join(timeout=3)
    assert not instance.guardian.thread.is_alive()


def test_the_quiet_notice_asks_windows_for_no_sound_and_other_systems_use_the_plain_notice(monkeypatch):
    icon = SimpleNamespace(_message=Mock())
    tray = SimpleNamespace(_notifications_enabled=lambda: True, _icon=icon, show_notice=Mock())
    monkeypatch.setattr("sc2tools_agent.ui.tray.sys.platform", "win32")
    TrayUI.show_quiet_notice(tray, "Mic muted", title="Guardian")
    (code, flags), fields = icon._message.call_args
    assert (code, flags) == (1, 0x10)
    assert fields == {"szInfo": "Mic muted", "szInfoTitle": "Guardian", "dwInfoFlags": 0x10}
    tray.show_notice.assert_not_called()
    monkeypatch.setattr("sc2tools_agent.ui.tray.sys.platform", "linux")
    TrayUI.show_quiet_notice(tray, "Mic muted", title="Guardian")
    tray.show_notice.assert_called_once_with("Mic muted", title="Guardian")
    tray.show_notice.reset_mock()
    muted = SimpleNamespace(_notifications_enabled=lambda: False, _icon=icon, show_notice=Mock())
    TrayUI.show_quiet_notice(muted, "x")
    muted.show_notice.assert_not_called()
