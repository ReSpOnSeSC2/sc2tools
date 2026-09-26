import asyncio
from types import SimpleNamespace as NS

import numpy as np
import pytest
from sc2.data import Result

from pluto_sc2.learning import Policy
from pluto_sc2.sc2_adapter import NeuralBot
from pluto_sc2.schema import ACTION_NAMES, OBSERVATION_SIZE


def test_protoss_reuses_act_critic_before_command_without_second_network_forward(monkeypatch):
    policy = Policy(OBSERVATION_SIZE, len(ACTION_NAMES), hidden_dim=16)
    bot = NeuralBot(policy, gamma=.97, reward_shaping=.4)
    bot.state = NS(game_loop=0)
    bot.supply_workers, bot.supply_army = 8, 0
    observations = [np.zeros(OBSERVATION_SIZE, dtype=np.float32),
                    np.full(OBSERVATION_SIZE, .2, dtype=np.float32)]
    expected_values = [policy.value(obs) for obs in observations]
    calls, executions = [], []
    original_forward = policy.forward

    def counted(obs):
        calls.append(obs.detach().cpu().numpy().copy())
        return original_forward(obs)

    def observe():
        bot._last_observation = observations[bool(bot.state.game_loop)]
        return bot._last_observation

    async def mask(_):
        value = np.zeros(len(ACTION_NAMES), dtype=bool)
        value[0] = True
        return value

    async def advance(_):
        return False

    async def execute(agent, action):
        executions.append((action, len(agent.transitions)))
        if agent.transitions:
            assert agent.transitions[-1].next_value == pytest.approx(expected_values[1])
        return True

    # This test isolates critic reuse; the runtime attention guard sees an
    # ordinary visible empty camera and therefore requests no intervention.
    bot.fairplay = NS(sync_camera=lambda _: None, advance=advance, can_issue=lambda _: True,
                      camera_center=(0, 0))
    bot.is_visible = lambda _: True
    monkeypatch.setattr(policy, "forward", counted)
    monkeypatch.setattr(bot, "_observe", observe)
    monkeypatch.setattr("pluto_sc2.sc2_adapter.legal_action_mask", mask)
    monkeypatch.setattr("pluto_sc2.sc2_adapter.execute_action", execute)
    asyncio.run(bot.on_step(0))
    bot.state.game_loop, bot.supply_army = 8, 4
    asyncio.run(bot.on_step(1))
    assert len(calls) == 2  # One policy forward per decision, not three for two decisions.
    assert executions == [(0, 0), (0, 1)]
    transition = bot.transitions[0]
    np.testing.assert_array_equal(transition.observation, observations[0])
    assert transition.action == 0 and transition.log_prob == pytest.approx(0)
    assert transition.value == pytest.approx(expected_values[0])
    assert transition.next_value == pytest.approx(expected_values[1])
    assert transition.reward == pytest.approx(.4 * (.97 * .12 - .1))
    assert not transition.terminated and not transition.truncated
    asyncio.run(bot.on_end(Result.Defeat))
    assert len(calls) == 2
    assert bot.transitions[-1].terminated and not bot.transitions[-1].truncated
    assert bot.transitions[-1].next_value == 0
    assert bot.transitions[-1].reward == pytest.approx(-1 - .4 * .12)


def test_protoss_uncached_truncation_still_evaluates_final_observation():
    calls = []
    bot = NeuralBot(NS(value=lambda obs: calls.append(obs) or .75))
    bot.supply_workers, bot.supply_army = 8, 0
    observation = np.zeros(OBSERVATION_SIZE, dtype=np.float32)
    bot._pending_transition = (observation, np.ones(len(ACTION_NAMES), dtype=bool), 0, 0., .2, .1)
    bot._finish_transition(observation, terminated=False, truncated=True)
    assert len(calls) == 1
    assert bot.transitions[-1].next_value == .75
    assert bot.transitions[-1].truncated and not bot.transitions[-1].terminated
