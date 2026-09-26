import asyncio
from types import SimpleNamespace as NS

import numpy as np
import pytest
from sc2.data import Result

from pluto_sc2.adversary import AdversaryBot
from pluto_sc2.adversary_schema import get_spec
from pluto_sc2.learning import Policy


def test_two_decisions_use_two_network_forwards_and_preserve_transition_bootstrap(monkeypatch):
    spec = get_spec("Terran")
    policy = Policy(spec.input_dim, spec.action_dim, hidden_dim=16)
    bot = AdversaryBot(policy, "Terran", gamma=.97, reward_shaping=.4)
    bot.state = NS(game_loop=0)
    bot.supply_workers, bot.supply_army = 8, 0
    observations = [np.zeros(spec.input_dim, dtype=np.float32), np.full(spec.input_dim, .2, dtype=np.float32)]
    expected_values = [policy.value(obs) for obs in observations]
    calls = []
    original = policy.forward

    def counted(obs):
        calls.append(obs.detach().cpu().numpy().copy())
        return original(obs)

    monkeypatch.setattr(policy, "forward", counted)

    def observe():
        bot._last_observation = observations[bool(bot.state.game_loop)]
        return bot._last_observation

    async def mask(_):
        result = np.zeros(spec.action_dim, dtype=bool)
        result[0] = True
        return result

    monkeypatch.setattr(bot, "_observe", observe)
    monkeypatch.setattr("pluto_sc2.adversary.legal_action_mask", mask)
    asyncio.run(bot.on_step(0))
    bot.state.game_loop = 8
    bot.supply_army = 4
    asyncio.run(bot.on_step(1))
    assert len(calls) == 2
    assert len(bot.transitions) == 1
    transition = bot.transitions[0]
    np.testing.assert_array_equal(transition.observation, observations[0])
    assert transition.action == 0 and transition.log_prob == pytest.approx(0)
    assert transition.value == pytest.approx(expected_values[0])
    assert transition.next_value == pytest.approx(expected_values[1])
    assert transition.reward == pytest.approx(.4 * (.97 * (8 / 80 + 4 / 200) - 8 / 80))
    assert not transition.terminated and not transition.truncated
    asyncio.run(bot.on_end(Result.Victory))
    assert len(calls) == 2  # True terminal bootstrap remains zero without a network call.
    assert bot.transitions[-1].next_value == 0
    assert bot.transitions[-1].reward == pytest.approx(1 - .4 * (8 / 80 + 4 / 200))


def pending_bot():
    policy = NS(value=lambda observation: .75)
    bot = AdversaryBot(policy, "Terran", reward_shaping=.1)
    bot.supply_workers, bot.supply_army = 8, 0
    obs = np.zeros(bot.spec.input_dim, dtype=np.float32)
    bot._pending_transition = (obs, np.ones(bot.spec.action_dim, dtype=bool), 0, -.2, .5, .1)
    return bot, obs


def test_truncation_without_cached_value_still_evaluates_final_observation():
    bot, obs = pending_bot()
    calls = []
    bot.policy.value = lambda observation: calls.append(observation) or .75
    bot._finish(obs, truncated=True)
    assert len(calls) == 1
    assert bot.transitions[-1].next_value == .75
    assert bot.transitions[-1].truncated


def test_cached_value_preserves_dense_reward_and_avoids_value_call():
    bot, obs = pending_bot()
    bot.policy.value = lambda _: pytest.fail("An available cached value must avoid a duplicate forward")
    bot._reward_collector = NS(take=lambda: .125)
    bot._finish(obs, next_value=.25)
    assert bot.transitions[-1].next_value == .25
    assert bot.transitions[-1].reward == .125


@pytest.mark.parametrize("value", [True, float("nan"), float("inf")])
def test_invalid_cached_value_is_rejected(value):
    bot, obs = pending_bot()
    with pytest.raises(ValueError, match="finite"):
        bot._finish(obs, next_value=value)
    assert not bot.transitions
