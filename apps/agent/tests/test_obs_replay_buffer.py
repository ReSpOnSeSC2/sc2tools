"""The replay-buffer save: it asks only while the buffer runs, waits for the new file, never raises."""
from types import SimpleNamespace

import pytest

from sc2tools_agent.streaming.obs_replay_buffer import OFF, SAVED, SLOW, UNAVAILABLE, ReplayBufferSaver


class FakeObs:
    def __init__(self, running=True, paths=("clip-1.mkv",), last=None):
        self.running, self.paths, self.last = running, list(paths), last
        self.sent, self.disconnected = [], False

    def send(self, request, data=None):
        self.sent.append(request)
        if request == "GetReplayBufferStatus":
            return SimpleNamespace(output_active=self.running)
        if request == "SaveReplayBuffer":
            return None
        if self.last is None and not self.sent.count("SaveReplayBuffer"):
            raise RuntimeError("no replay yet")
        if self.sent.count("SaveReplayBuffer") and self.paths:
            self.last = self.paths.pop(0)
        return SimpleNamespace(saved_replay_path=self.last)

    def disconnect(self):
        self.disconnected = True


def saver_for(fake, naps=None):
    return ReplayBufferSaver(lambda: {}, factory=lambda **_: fake, sleep=(naps if naps is not None else []).append)


def test_a_running_buffer_is_saved_and_the_new_file_is_reported():
    fake = FakeObs()
    assert saver_for(fake)() == (SAVED, "clip-1.mkv")
    assert fake.sent.index("SaveReplayBuffer") < len(fake.sent) - 1


def test_the_previous_clip_is_not_mistaken_for_the_new_one():
    fake = FakeObs(paths=("clip-2.mkv",), last="clip-1.mkv")
    assert saver_for(fake)() == (SAVED, "clip-2.mkv")


def test_a_stopped_buffer_is_off_and_nothing_is_saved():
    fake = FakeObs(running=False)
    assert saver_for(fake)() == (OFF, None)
    assert "SaveReplayBuffer" not in fake.sent
    assert saver_for(FakeObs(running=False)).running() is False


def test_a_save_obs_never_names_is_slow_not_unreachable_after_a_bounded_wait():
    naps = []
    fake = FakeObs(paths=(), last="clip-1.mkv")
    assert saver_for(fake, naps)() == (SLOW, None)
    assert 0 < len(naps) <= 40


def test_an_unreachable_obs_is_unavailable_and_reconnects_next_time():
    def refuse(**_):
        raise ConnectionRefusedError()
    assert ReplayBufferSaver(lambda: {}, factory=refuse)() == (UNAVAILABLE, None)
    assert ReplayBufferSaver(lambda: {}, factory=refuse).running() is None
    assert ReplayBufferSaver(lambda: {}, disabled=True)() == (UNAVAILABLE, None)


def test_a_connection_lost_mid_save_is_closed():
    class Dropping(FakeObs):
        def send(self, request, data=None):
            if request == "SaveReplayBuffer":
                raise OSError("gone")
            return super().send(request, data)
    fake = Dropping(paths=())
    saver = saver_for(fake)
    assert saver() == (UNAVAILABLE, None)
    assert fake.disconnected and saver.raw is None


@pytest.mark.parametrize("value", [None, "yes", 1])
def test_a_status_that_is_not_a_boolean_is_unknown(value):
    class Odd(FakeObs):
        def send(self, request, data=None):
            return SimpleNamespace(output_active=value)
    assert saver_for(Odd()).running() is None
