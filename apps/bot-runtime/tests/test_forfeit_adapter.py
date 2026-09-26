import asyncio
from types import SimpleNamespace as NS

import numpy as np
import pytest
from sc2.data import Race, Result
from sc2.ids.unit_typeid import UnitTypeId

from pluto_sc2.economic_forfeit import EconomicForfeitGuard
from pluto_sc2.rewards import RewardConfig
from pluto_sc2.sc2_adapter import NeuralBot
from pluto_sc2.schema import ACTION_NAMES, BASE_OBSERVATION_SIZE, OBSERVATION_SIZE


def test_economic_forfeit_uses_engine_leave_and_records_real_terminal_loss_once(monkeypatch):
    class Policy:
        def act(self, *args, **kwargs):
            pytest.fail("A confirmed unrecoverable economy should resign before another policy action")

        def value(self, observation):
            return .75

    bot = NeuralBot(Policy(), reward_config=RewardConfig())
    bot.race = Race.Protoss
    bot.state = NS(game_loop=224, dead_units=set(), upgrades=set(),
                   score=NS(collected_minerals=100, collected_vespene=0))
    bot.units, bot.structures, bot.enemy_units, bot.enemy_structures = [], [], [], []
    bot.mineral_field, bot.vespene_geyser = [], []
    bot.supply_workers, bot.supply_army, bot.supply_left, bot.supply_cap = 0, 0, 21, 21
    bot.minerals, bot.vespene = 35, 0
    bot.game_data = NS(units={UnitTypeId.PROBE.value: NS(_proto=NS(mineral_cost=50))}, upgrades={})
    bot.fairplay = NS(audit=[], sync_camera=lambda _: None, on_screen=lambda _: True)
    bot.is_visible = lambda _: True
    bot._economic_guard = EconomicForfeitGuard()
    bot._pending_transition = (np.zeros(OBSERVATION_SIZE), np.ones(len(ACTION_NAMES), dtype=bool),
                               0, -.1, .2, 0.)
    left = []

    async def leave():
        left.append(True)

    bot.client = NS(leave=leave)
    monkeypatch.setattr("pluto_sc2.sc2_adapter.encode_observation", lambda _: np.zeros(BASE_OBSERVATION_SIZE))
    asyncio.run(bot.on_step(1))
    asyncio.run(bot.on_step(2))
    assert left == [True]
    assert bot.forfeit_reason["reason"] == "economic_forfeit_no_probes_or_recovery"
    assert not bot._episode_finished  # Only the actual engine result closes the trajectory.
    asyncio.run(bot.on_end(Result.Defeat))
    asyncio.run(bot.on_end(Result.Defeat))
    assert len(bot.transitions) == 1
    assert bot.transitions[0].reward == -10
    assert bot.transitions[0].terminated and not bot.transitions[0].truncated
    assert bot.transitions[0].next_value == 0
