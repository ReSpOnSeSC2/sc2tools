import asyncio
from types import SimpleNamespace as NS

import numpy as np
import pytest
from sc2.data import Result
from s2clientprotocol import sc2api_pb2 as api

from pluto_sc2.human_match import _drive_bot
from pluto_sc2.rewards import RewardConfig
from pluto_sc2.sc2_adapter import NeuralBot
from pluto_sc2.schema import ACTION_NAMES, OBSERVATION_SIZE


def driver_rig(monkeypatch, leave_result):
    """Real NeuralBot resignation/finalization with only the SC2 transport faked."""
    from sc2 import game_state

    async def nothing(*args):
        return None

    class Policy:
        def act(self, *args, **kwargs):
            pytest.fail("An economically forfeiting bot must not choose another action")

        def value(self, obs):
            pytest.fail("A genuine terminal defeat must not bootstrap")

    class Client:
        _player_id, game_step, _game_result = 2, 8, None

        def __init__(self):
            self.leaves, self.observations = 0, 0

        async def get_game_data(self):
            return None

        async def get_game_info(self):
            return None

        async def ping(self):
            return api.Response(ping=api.ResponsePing(base_build=97563))

        async def _execute(self, **kwargs):
            assert set(kwargs) == {"game_info"}

        async def observation(self, requested):
            self.observations += 1
            return response(requested)

        async def leave(self):
            self.leaves += 1
            if leave_result is not None:
                self._game_result = {2: leave_result}

        async def step(self, *args):
            pytest.fail("The realtime driver must not advance the engine manually")

    def response(loop):
        return api.Response(observation=api.ResponseObservation(observation=api.Observation(game_loop=loop)))

    bot = NeuralBot(Policy(), reward_config=RewardConfig())
    bot.state = NS(game_loop=0)
    bot._economic_forfeit_candidate = {"reason": "economic_forfeit_no_probes_or_recovery"}
    observation = np.zeros(OBSERVATION_SIZE, dtype=np.float32)
    bot._pending_transition = (observation, np.ones(len(ACTION_NAMES), dtype=bool), 0, -.1, .2, 0.)
    bot.fairplay = NS(sync_camera=lambda _: None)

    def observe():
        bot._last_observation = observation
        return observation

    client = Client()
    monkeypatch.setattr(game_state, "GameState", lambda value: NS(game_loop=value.observation.game_loop))
    monkeypatch.setattr(bot, "_initialize_variables", lambda: None)
    monkeypatch.setattr(bot, "_prepare_start", lambda connection, *args, **kwargs: setattr(bot, "client", connection))
    monkeypatch.setattr(bot, "_prepare_step", lambda state, _: setattr(bot, "state", state))
    monkeypatch.setattr(bot, "_prepare_first_step", lambda: None)
    monkeypatch.setattr(bot, "on_before_start", nothing)
    monkeypatch.setattr(bot, "on_start", nothing)
    monkeypatch.setattr(bot, "issue_events", nothing)
    monkeypatch.setattr(bot, "_after_step", nothing)
    monkeypatch.setattr(bot, "_observe", observe)
    return bot, client, response(0)


def test_human_driver_confirmed_resignation_is_terminal_defeat_and_human_victory(monkeypatch):
    bot, client, initial = driver_rig(monkeypatch, Result.Defeat)
    result = asyncio.run(_drive_bot(bot, client, initial, lambda *args, **kwargs: None,
                                    lambda: None, 3600))
    assert client.leaves == 1 and client.observations == 1
    assert result == ("finished", {2: Result.Defeat, 1: Result.Victory},
                      "Bot resigned: no recoverable Probe economy")
    assert bot.result == Result.Defeat and bot._episode_finished
    assert len(bot.transitions) == 1
    transition = bot.transitions[0]
    assert transition.reward == -10 and transition.next_value == 0
    assert transition.terminated and not transition.truncated


def test_human_driver_does_not_invent_result_for_unconfirmed_resignation(monkeypatch):
    bot, client, initial = driver_rig(monkeypatch, None)
    def closed():
        return "Closed before result confirmation" if client.leaves else None

    result = asyncio.run(_drive_bot(bot, client, initial, lambda *args, **kwargs: None, closed, 3600))
    assert result == ("closed", None, "Closed before result confirmation")
    assert client.leaves == 1
    assert bot.result is None and not bot._episode_finished and not bot.transitions


@pytest.mark.parametrize("unexpected", [Result.Victory, Result.Tie])
def test_human_driver_rejects_nondefeat_result_after_resignation(monkeypatch, unexpected):
    bot, client, initial = driver_rig(monkeypatch, unexpected)
    with pytest.raises(RuntimeError, match="did not receive its defeat"):
        asyncio.run(_drive_bot(bot, client, initial, lambda *args, **kwargs: None, lambda: None, 3600))
    assert not bot.transitions and not bot._episode_finished
