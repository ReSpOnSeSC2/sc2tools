"""OBS recording chapter markers: version and state guards, the switch, the game-start flow."""
from types import SimpleNamespace

import pytest

from sc2tools_agent.streaming.obs_chapters import RecordChapterMarker, obs_version
from sc2tools_agent.streaming.title_record_chapter import chapter_name
from sc2tools_agent.streaming.title_settings import configure_title_settings, load_title_settings
from tests.test_stream_title_channel import MATCH, PLATFORMS, service, start_game  # noqa: F401
from tests.test_stream_title_controller import deny_network  # noqa: F401


class FakeObs:
    def __init__(self, version="30.2.0", recording=True, reject=False):
        self.version, self.recording, self.reject = version, recording, reject
        self.sent, self.disconnected = [], False

    def get_version(self):
        return SimpleNamespace(obs_version=self.version)

    def get_record_status(self):
        return SimpleNamespace(output_active=self.recording)

    def send(self, request, data=None):
        if self.reject:
            raise RuntimeError("Hybrid MP4 is required")
        self.sent.append((request, data))

    def disconnect(self):
        self.disconnected = True


def marker_for(fake):
    return RecordChapterMarker(lambda: {}, factory=lambda **_: fake)


@pytest.mark.parametrize("text,expected", [("30.2.1", (30, 2)), ("31.0", (31, 0)), ("30", None), ("x.y", None), (None, None)])
def test_the_obs_version_is_read_from_its_first_two_numbers(text, expected):
    assert obs_version(text) == expected


def test_a_recording_on_a_new_enough_obs_gets_the_chapter():
    fake = FakeObs()
    assert marker_for(fake)("Game 2 · PvZ") is True
    assert fake.sent == [("CreateRecordChapter", {"chapterName": "Game 2 · PvZ"})]


@pytest.mark.parametrize("fake", [FakeObs(version="30.1.2"), FakeObs(version="not a version"), FakeObs(recording=False)])
def test_an_older_obs_or_no_recording_does_nothing_quietly(fake):
    assert marker_for(fake)("Game 1") is False
    assert fake.sent == []


def test_a_rejected_request_does_nothing_quietly_and_reconnects_next_time():
    fake = FakeObs(reject=True)
    marker = marker_for(fake)
    assert marker("Game 1") is False
    assert fake.disconnected is True and marker.raw is None


def test_a_missing_obs_does_nothing_quietly():
    def refuse(**_):
        raise ConnectionRefusedError()
    assert RecordChapterMarker(lambda: {}, factory=refuse)("Game 1") is False
    assert RecordChapterMarker(lambda: {}, disabled=True)("Game 1") is False


def test_a_long_name_is_cut_to_the_chapter_limit():
    fake = FakeObs()
    marker_for(fake)("x" * 300)
    assert len(fake.sent[0][1]["chapterName"]) == 100


def test_the_chapter_is_named_by_game_number_and_matchup():
    stats = {"session": {"wins": 2, "losses": 1}, "currentMatch": MATCH}
    assert chapter_name(stats) == "Game 4 · PvZ"
    assert chapter_name({"session": {"wins": 0, "losses": 0}, "currentMatch": {**MATCH, "opponentRace": "Random"}}) == "Game 1"
    assert chapter_name({"session": {"wins": True, "losses": -3}}) == "Game 1"
    assert chapter_name(None) == "Game 1"


def test_the_switch_starts_off_needs_a_boolean_and_an_account():
    assert load_title_settings({}, "owner")["record_chapters"] is False
    base = {"enabled": False, "template": "", "platforms": PLATFORMS}
    saved = configure_title_settings(load_title_settings({}, "owner"), {**base, "record_chapters": True}, "owner")
    assert saved["record_chapters"] is True and saved["channel_tags"] is False
    with pytest.raises(ValueError):
        configure_title_settings(saved, {**base, "record_chapters": 1}, "owner")
    with pytest.raises(ValueError):
        configure_title_settings(saved, {**base, "record_chapters": True}, "")
    kept = configure_title_settings(saved, base, "owner")
    assert kept["record_chapters"] is True


def test_the_marker_receipt_survives_a_reload_and_drops_junk():
    loaded = load_title_settings({"owner": "owner", "record_chapters": True, "last_record_game": "game-one"}, "owner")
    assert loaded["record_chapters"] is True and loaded["last_record_game"] == "game-one"
    assert load_title_settings({"owner": "owner", "last_record_game": "x" * 400}, "owner")["last_record_game"] == ""


class Recorder:
    def __init__(self, result=True):
        self.names, self.result = [], result

    def __call__(self, name):
        self.names.append(name)
        return self.result

    def close(self):
        pass


def test_one_marker_goes_in_at_game_start_and_no_title_or_tag_is_sent(service):
    instance, calls, _ = service
    instance.chapter_marker = marker = Recorder()
    start_game(instance, record_chapters=True)
    assert instance.titles.worker.run_once() is True
    assert marker.names == ["Game 2 · PvZ"]
    assert not [call for call in calls if call[0] == "POST"]
    assert instance.titles.settings["last_record_game"] == "game-one"
    instance.titles.worker.run_once()
    assert marker.names == ["Game 2 · PvZ"]


def test_a_failed_marker_never_holds_up_the_title_and_is_not_repeated(service):
    instance, calls, _ = service
    instance.chapter_marker = marker = Recorder(result=False)
    start_game(instance, record_chapters=True, on_game_start=True, template="SC2 | v {opp}")
    instance.titles.worker.run_once()
    assert [call[2]["platforms"] for call in calls if call[0] == "POST" and call[1].endswith("/title")] == [["twitch"], ["kick"]]
    assert len(marker.names) == 1
    instance.titles.worker.run_once()
    assert len(marker.names) == 1


def test_nothing_is_marked_with_the_switch_off(service):
    instance, _, _ = service
    instance.chapter_marker = marker = Recorder()
    start_game(instance, channel_tags=True)
    instance.titles.worker.run_once()
    assert marker.names == []
