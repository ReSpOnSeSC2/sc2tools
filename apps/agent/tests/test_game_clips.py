"""The replay-buffer clip after a game: when it is asked for, how it is named, and what the streamer is told."""
from datetime import datetime, timezone
import threading
from types import SimpleNamespace

import pytest

from sc2tools_agent.live.types import LiveGameState, LiveLifecycleEvent, LiveLifecyclePhase, LivePlayer
from sc2tools_agent.streaming import game_clips
from sc2tools_agent.streaming.cloud_client import CloudStreamingClient
from sc2tools_agent.streaming.game_clips import (CHECK_NOT_RUNNING, CHECK_RUNNING, CHECK_UNREACHABLE, FALLBACK_SECONDS, NOT_RUNNING,
                                                  PROBLEMS, SLOW_SAVE, UNREACHABLE, GameClipSaver)
from sc2tools_agent.streaming.obs_replay_buffer import OFF, SAVED, SLOW, UNAVAILABLE
from sc2tools_agent.streaming.service import StreamService
from sc2tools_agent.streaming.title_settings import configure_title_settings, load_title_settings
from tests.test_stream_title_controller import deny_network, live_event  # noqa: F401

ENDED = datetime(2026, 11, 28, 21, 5, tzinfo=timezone.utc).timestamp()
STAMP = datetime.fromtimestamp(ENDED).strftime("%Y-%m-%d %H-%M")


class FakeBuffer:
    def __init__(self, outcome=(SAVED, "C:/obs/clip.mkv"), running=True):
        self.outcome, self.is_running, self.saves = outcome, running, 0

    def __call__(self):
        self.saves += 1
        return self.outcome

    def running(self):
        return self.is_running

    def close(self):
        pass


class Reports(list):
    def __init__(self):
        super().__init__()
        self.ended = []

    def record(self, name, ended_at):
        self.append(name)
        self.ended.append(ended_at)


class Timers:
    def __init__(self):
        self.jobs = []

    def __call__(self, delay, job):
        entry = SimpleNamespace(delay=delay, job=job, cancelled=False)
        entry.cancel = lambda: setattr(entry, "cancelled", True)
        self.jobs.append(entry)
        return entry


def make(buffer=None, enabled=True, filer=None):
    told, filed, reported, timers = [], [], Reports(), Timers()

    def file(path, name):
        filed.append((path, name))
        return filer(path, name) if filer else "moved"
    saver = GameClipSaver(buffer or FakeBuffer(), enabled=lambda: enabled, announce=told.append, report=reported.record,
                          spawn=lambda job, *args: job(*args), schedule=timers, file=file)
    return saver, told, filed, reported, timers


def ended(key="game-one", result="Victory", **changes):
    players = [LivePlayer("Me", "user", "Protoss", result), LivePlayer("Barcode", "user", "Zerg", "Defeat")]
    return LiveLifecycleEvent(phase=LiveLifecyclePhase("match_ended"), captured_at=ENDED, game_key=key,
                              game_state=LiveGameState(players=players, **changes))


def synced(offset=5, **changes):
    stamp = datetime.fromtimestamp(ENDED + offset, tz=timezone.utc).isoformat()
    fields = dict(date_iso=stamp, result="Victory", my_race="Protoss", map_name="Alcyone LE",
                  opponent={"displayName": "Barcode", "race": "Zerg"})
    return SimpleNamespace(**{**fields, **changes})


def test_a_finished_game_saves_the_buffer_once_and_waits_for_the_synced_game_to_name_it():
    saver, told, filed, reported, timers = make()
    saver.on_event(ended())
    saver.on_event(ended())
    assert saver.buffer.saves == 1 and filed == [] and timers.jobs[0].delay == FALLBACK_SECONDS
    saver.on_accepted(synced())
    assert filed == [("C:/obs/clip.mkv", STAMP + " PvZ Victory vs Barcode on Alcyone LE")]
    assert reported == [filed[0][1]] and reported.ended == [ENDED] and timers.jobs[0].cancelled
    assert told[-1] == "Clip filed in Highlights: " + filed[0][1]


def test_nothing_is_asked_of_obs_while_a_game_is_on_or_before_its_result_is_known():
    saver, _told, _filed, _reported, _timers = make()
    for phase in ("match_loading", "match_started", "match_in_progress", "menu", "idle"):
        saver.on_event(live_event(ENDED, phase=phase))
    undecided = live_event(ENDED, phase="match_ended")
    saver.on_event(undecided)
    assert saver.buffer.saves == 0


@pytest.mark.parametrize("changes", [{"is_replay": True}, {"is_observer": True}])
def test_a_replay_or_an_observed_game_is_never_clipped(changes):
    saver, *_ = make()
    saver.on_event(ended(**changes))
    assert saver.buffer.saves == 0


def test_the_switch_off_asks_nothing_and_remembers_nothing():
    saver, told, *_ = make(enabled=False)
    saver.on_event(ended())
    assert saver.buffer.saves == 0 and told == []


def test_a_game_the_replay_of_which_is_far_from_the_clip_does_not_name_it():
    saver, _told, filed, _reported, _timers = make()
    saver.on_event(ended())
    saver.on_accepted(synced(offset=3600))
    saver.on_accepted(synced(is_history=True))
    saver.on_accepted(synced(is_resumed_from_replay=True))
    saver.on_accepted(synced(), {"isHistory": True})
    saver.on_accepted(SimpleNamespace(date_iso="not a date"))
    assert filed == []


def test_a_replay_that_never_syncs_still_gets_its_clip_filed_with_a_plain_name():
    saver, told, filed, _reported, timers = make()
    saver.on_event(ended())
    timers.jobs[0].job()
    timers.jobs[0].job()
    assert len(filed) == 1 and filed[0][0] == "C:/obs/clip.mkv" and filed[0][1].endswith(" Game")
    saver.on_accepted(synced())
    assert len(filed) == 1 and told[-1].startswith("Clip filed")


def test_a_second_game_files_the_first_clip_it_was_still_waiting_on():
    saver, _told, filed, *_ = make(buffer=FakeBuffer())
    saver.on_event(ended("game-one"))
    saver.buffer.outcome = (SAVED, "C:/obs/clip2.mkv")
    saver.on_event(ended("game-two"))
    assert [path for path, _name in filed] == ["C:/obs/clip.mkv"]


@pytest.mark.parametrize("outcome,message", [((OFF, None), NOT_RUNNING), ((UNAVAILABLE, None), UNREACHABLE),
                                             ((SLOW, None), SLOW_SAVE)])
def test_a_buffer_that_is_off_or_an_obs_that_is_unreachable_is_a_hint_not_a_silent_miss(outcome, message):
    saver, told, filed, _reported, timers = make(buffer=FakeBuffer(outcome))
    saver.on_event(ended())
    assert told == [message] and filed == [] and timers.jobs == []


def test_a_clip_that_cannot_be_moved_says_where_it_stayed_and_reports_nothing():
    saver, told, _filed, reported, _timers = make(filer=lambda *_: None)
    saver.on_event(ended())
    saver.on_accepted(synced())
    assert "where OBS wrote it" in told[-1] and reported == []


def test_a_dock_that_cannot_be_reached_does_not_undo_the_filed_clip():
    saver, told, *_ = make()
    saver.report = lambda name, at: (_ for _ in ()).throw(RuntimeError("offline"))
    saver.on_event(ended())
    saver.on_accepted(synced())
    assert told[-1].startswith("Clip filed")


@pytest.mark.parametrize("running,expected", [(False, CHECK_NOT_RUNNING), (None, CHECK_UNREACHABLE), (True, CHECK_RUNNING)])
def test_checking_the_buffer_tells_the_streamer_without_saving(running, expected):
    saver, told, *_ = make(buffer=FakeBuffer(running=running))
    saver.check()
    assert told == [expected] and saver.buffer.saves == 0


def test_the_hint_after_saving_the_switch_does_not_claim_a_save_failed_or_repeat_the_status_line():
    for message in (CHECK_NOT_RUNNING, CHECK_UNREACHABLE, CHECK_RUNNING):
        assert "no clip was saved" not in message and "each game ends" not in message
    assert {CHECK_NOT_RUNNING, CHECK_UNREACHABLE, NOT_RUNNING, UNREACHABLE, SLOW_SAVE} <= PROBLEMS
    assert CHECK_RUNNING not in PROBLEMS


def test_a_replay_that_synced_before_the_save_finished_still_names_its_clip():
    saver, told, filed, reported, timers = make()
    saver.on_accepted(synced())
    assert filed == [] and reported == []
    saver.on_event(ended())
    assert filed == [("C:/obs/clip.mkv", STAMP + " PvZ Victory vs Barcode on Alcyone LE")]
    assert reported.ended == [ENDED] and timers.jobs == [] and told == ["Clip filed in Highlights: " + filed[0][1]]


def test_an_early_replay_of_another_game_does_not_name_the_clip_and_is_used_once():
    saver, _told, filed, _reported, timers = make()
    saver.on_accepted(synced(offset=3600))
    saver.on_event(ended("game-one"))
    assert filed == [] and len(timers.jobs) == 1
    saver.on_accepted(synced())
    saver.buffer.outcome = (SAVED, "C:/obs/clip2.mkv")
    saver.on_event(ended("game-two"))
    assert [path for path, _ in filed] == ["C:/obs/clip.mkv"]


def test_the_background_work_runs_on_a_named_daemon_thread_and_timer():
    ran = threading.Event()
    seen = []
    def job(label):
        seen.append((label, threading.current_thread()))
        ran.set()
    game_clips._start_thread(job, "save")
    assert ran.wait(5)
    assert seen[0][1].daemon is True and seen[0][1].name == "sc2tools-game-clip"
    timer = game_clips._start_timer(3600, print)
    assert timer.daemon is True
    timer.cancel()


def test_the_switch_is_off_by_default_strict_and_follows_the_account():
    settings = load_title_settings({}, "owner")
    assert settings["save_clips"] is False
    on = configure_title_settings(settings, {"enabled": False, "save_clips": True,
                                             "platforms": {"twitch": True, "kick": True, "youtube": False}}, "owner")
    assert on["save_clips"] is True and load_title_settings(on, "owner")["save_clips"] is True
    assert load_title_settings(on, "someone-else")["save_clips"] is False
    payload = {"enabled": False, "platforms": {"twitch": True, "kick": True, "youtube": False}}
    with pytest.raises(ValueError):
        configure_title_settings(settings, {**payload, "save_clips": "yes"}, "owner")
    with pytest.raises(ValueError, match="Pair this agent"):
        configure_title_settings(settings, {**payload, "save_clips": True}, "")
    assert configure_title_settings(on, payload, "owner")["save_clips"] is True


@pytest.fixture
def stream(tmp_path):
    sent = []

    def transport(method, url, **kwargs):
        sent.append((method, url, kwargs.get("json")))
        return SimpleNamespace(status_code=200, json=lambda: {})
    client = CloudStreamingClient(lambda: ("https://api.sc2tools.com", "fixture-agent-token"), transport=transport)
    buffer = FakeBuffer((SAVED, str(tmp_path / "Replay.mkv")))
    (tmp_path / "Replay.mkv").write_bytes(b"video")
    service = StreamService(tmp_path / "state", lambda: {}, no_obs=True, cloud_client=client, clip_buffer=buffer)
    yield service, sent, buffer, tmp_path
    service.close()


def test_a_paired_streamer_with_the_switch_on_gets_a_filed_clip_and_a_dock_entry(stream):
    service, sent, buffer, folder = stream
    service.action({"action": "configure_title_automation", "enabled": False, "save_clips": True,
                    "template": "", "platforms": {"twitch": True, "kick": True, "youtube": False}})
    assert service.status()["title_automation"]["save_clips"] is True
    clips = service.titles.clips
    clips.spawn = lambda job, *args: job(*args)
    service.on_game_event(ended())
    service.on_game_accepted(str(folder / "x.SC2Replay"), synced(), "game-id", {})
    assert buffer.saves == 1
    assert not (folder / "Replay.mkv").exists()
    filed = list((folder / "Highlights").iterdir())
    assert [path.name for path in filed] == [STAMP + " PvZ Victory vs Barcode on Alcyone LE.mkv"]
    assert sent[-1][:2] == ("POST", "https://api.sc2tools.com/v1/agent/streaming/clip")
    assert sent[-1][2] == {"name": filed[0].stem, "endedAtMs": int(ENDED * 1000)}
    assert service.status()["title_automation"]["clip_message"].startswith("Clip filed in Highlights")


def test_with_the_switch_off_a_finished_game_never_touches_obs(stream):
    service, sent, buffer, _folder = stream
    service.on_game_event(ended())
    assert buffer.saves == 0 and sent == []


def test_turning_the_switch_on_reports_a_stopped_buffer_at_once(stream):
    service, _sent, buffer, _folder = stream
    service.titles.clips.spawn = lambda job, *args: job(*args)
    buffer.is_running = False
    service.action({"action": "configure_title_automation", "enabled": False, "save_clips": True,
                    "template": "", "platforms": {"twitch": True, "kick": True, "youtube": False}})
    assert CHECK_NOT_RUNNING in service.status()["title_automation"]["clip_message"]


def _turn_switch(service, on):
    service.action({"action": "configure_title_automation", "enabled": False, "save_clips": on,
                    "template": "", "platforms": {"twitch": True, "kick": True, "youtube": False}})


def test_turning_the_switch_off_clears_the_hint_and_a_problem_is_flagged(stream):
    service, _sent, buffer, _folder = stream
    service.titles.clips.spawn = lambda job, *args: job(*args)
    buffer.is_running = False
    _turn_switch(service, True)
    shown = service.status()["title_automation"]
    assert shown["clip_message"] == CHECK_NOT_RUNNING and shown["clip_problem"] is True
    _turn_switch(service, False)
    shown = service.status()["title_automation"]
    assert shown["clip_message"] == "" and shown["clip_problem"] is False


def test_an_account_change_does_not_show_the_old_accounts_clip_message(stream):
    service, _sent, _buffer, _folder = stream
    service.titles.announce_clip("Clip filed in Highlights: 2026-11-28 21-05 PvZ Victory vs Barcode on Alcyone LE")
    assert service.titles.snapshot()["clip_message"].startswith("Clip filed")
    service.titles.settings["owner"] = "someone-else"
    shown = service.titles.snapshot()
    assert shown["clip_message"] == "" and shown["clip_problem"] is False
