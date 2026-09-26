"""Verify reward observations cannot bypass the player's information contract."""
import asyncio
from types import SimpleNamespace as NS

import numpy as np
import pytest
from sc2.data import Race, Result
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2

from pluto_sc2.adversary import AdversaryBot
from pluto_sc2.reward_observation import RewardCollector
from pluto_sc2.rewards import RewardConfig
from pluto_sc2.sc2_adapter import NeuralBot
from pluto_sc2.schema import ACTION_NAMES, BASE_OBSERVATION_SIZE, OBSERVATION_SIZE


class Policy:
    def value(self, _):
        return .75

    def act(self, *_args, **_kwargs):
        return 0, -.1, .75


class Fairplay:
    def on_screen(self, unit):
        return getattr(unit, "position", unit).x < 50

    def sync_camera(self, _):
        pass

    async def advance(self, _):
        return True

    def can_issue(self, _):
        return False


def unit(tag, kind=U.PROBE, *, x=10, ready=True, hallucination=False, health=40):
    return NS(tag=tag, type_id=kind, position=Point2((x, 10)), is_ready=ready,
              is_hallucination=hallucination, is_structure=kind in {U.NEXUS, U.HATCHERY, U.GATEWAY},
              health=health, health_max=40, shield=0, shield_max=0, is_idle=False,
              is_visible=True, is_snapshot=False, is_cloaked=False, is_revealed=False)


def data(kind, *, minerals=50, gas=0, food=1):
    return NS(_proto=NS(mineral_cost=minerals, vespene_cost=gas, food_required=food,
                         attributes=[8] if kind in {U.NEXUS, U.HATCHERY, U.GATEWAY} else [], weapons=[]))


def world(bot=None):
    bot = bot or NS()
    bot.state = NS(game_loop=0, upgrades=set(), dead_units=set(),
                   score=NS(collected_minerals=0, collected_vespene=0))
    bot.units, bot.structures, bot.enemy_units, bot.enemy_structures = [], [], [], []
    bot.game_data = NS(units={kind.value: data(kind) for kind in U}, upgrades={})
    bot.fairplay = Fairplay()
    bot.is_visible = lambda point: point.y < 50
    bot.supply_left, bot.supply_cap, bot.supply_workers, bot.supply_army = 7, 15, 8, 0
    bot.minerals, bot.vespene = 50, 0
    bot.race = Race.Protoss
    if type(bot) is NS:
        bot.time = 0
    return bot


def test_resource_bank_feedback_uses_own_hud_even_when_camera_is_empty():
    bot = world()
    bot.minerals, bot.vespene, bot.supply_used = 3000, 1500, 70
    collector = RewardCollector(RewardConfig(version="tactical-economy-v2", completion_budget=.8,
                                intel_budget=.35, macro_budget=.2, bank_budget=.7,
                                unspent_resources_per_second=.002))
    collector.observe(bot, [], [], camera_restricted=True)
    bot.time, bot.state.game_loop = 30, 672
    collector.observe(bot, [], [], camera_restricted=True)
    assert collector.engine.summary()["components"]["unspent_resources"] == pytest.approx(-.04)
    assert collector.engine._previous.own_assets == ()


def step_world(bot, loop, *, minerals=None):
    bot.state.game_loop = loop
    if type(bot) is NS:
        bot.time = loop / 22.4
    if minerals is not None:
        bot.state.score.collected_minerals = minerals


def test_camera_and_fog_filter_actual_reward_inputs(monkeypatch):
    bot = world(NeuralBot(Policy(), reward_config=RewardConfig()))
    monkeypatch.setattr("pluto_sc2.sc2_adapter.encode_observation", lambda _: np.zeros(BASE_OBSERVATION_SIZE))
    bot.units = [unit(1), unit(2, x=80)]
    bot.enemy_units = [unit(3, U.MARINE), unit(4, U.MARINE, x=80), unit(5, U.MARINE)]
    bot.enemy_units[-1].is_visible = False
    bot._observe()
    snapshot = bot._reward_collector.engine._previous
    assert [asset.tag for asset in snapshot.own_assets] == [1]
    assert [asset.tag for asset in snapshot.visible_enemies] == [3]


def test_adversary_uses_global_own_units_but_current_visible_enemies(monkeypatch):
    bot = world(AdversaryBot(Policy(), "Terran", reward_config=RewardConfig()))
    monkeypatch.setattr("pluto_sc2.adversary.encode_observation", lambda _: np.zeros(bot.spec.base_dim))
    bot.units = [unit(1, U.SCV, x=80)]
    bot.enemy_units = [unit(2, U.STALKER, x=80), unit(3, U.STALKER)]
    bot.enemy_units[-1].is_snapshot = True
    bot._observe()
    snapshot = bot._reward_collector.engine._previous
    assert [asset.tag for asset in snapshot.own_assets] == [1]
    assert [asset.tag for asset in snapshot.visible_enemies] == [2]


def test_frame_deduplication_and_accrual_during_selection_wait(monkeypatch):
    bot = world(NeuralBot(Policy(), reward_config=RewardConfig()))
    monkeypatch.setattr("pluto_sc2.sc2_adapter.encode_observation", lambda _: np.zeros(BASE_OBSERVATION_SIZE))
    obs = bot._observe()
    bot._pending_transition = (obs, np.ones(len(ACTION_NAMES), dtype=bool), 0, -.1, .75, 0)
    step_world(bot, 8, minerals=100)
    asyncio.run(bot.on_step(0))  # Fairplay selection advance consumes this step.
    assert not bot.transitions
    accrued = bot._reward_collector.pending
    assert accrued == pytest.approx(100 * RewardConfig().mined_mineral_coefficient)
    bot._observe()
    assert bot._reward_collector.pending == accrued
    bot._finish_transition(obs, terminated=False, truncated=False)
    assert bot.transitions[0].reward == accrued
    assert bot._reward_collector.pending == 0


def test_dead_tags_need_previous_eligible_sight_and_current_visibility():
    bot = world()
    collector = RewardCollector(RewardConfig())
    visible, offscreen, fogged = unit(1, U.MARINE), unit(2, U.MARINE, x=80), unit(3, U.MARINE)
    collector.observe(bot, [], [visible, offscreen, fogged], camera_restricted=False)
    collector._positions[3] = Point2((10, 80))
    step_world(bot, 8)
    bot.state.dead_units = {1, 2, 3, 999}
    collector.observe(bot, [], [], camera_restricted=True)
    assert collector.engine._previous.confirmed_dead_tags == frozenset({1})
    assert collector.engine.summary()["components"]["enemy_combat_damage"] > 0


def test_disappearing_units_and_transforms_do_not_award_kills_or_repeated_completion():
    bot = world()
    collector = RewardCollector(RewardConfig())
    collector.observe(bot, [], [unit(9, U.MARINE)], camera_restricted=True)
    step_world(bot, 8)
    collector.observe(bot, [unit(1, U.WARPPRISM)], [], camera_restricted=True)
    first = collector.engine.summary()["components"]["completed_army"]
    step_world(bot, 16)
    collector.observe(bot, [unit(1, U.WARPPRISMPHASING)], [], camera_restricted=True)
    assert collector.engine.summary()["components"]["completed_army"] == first
    assert not any("damage" in key for key in collector.engine.summary()["components"])


@pytest.mark.parametrize("kind,hallucination", [(U.LARVA, False), (U.EGG, False), (U.MULE, False),
                                                (U.BROODLING, False), (U.STALKER, True)])
def test_temporary_and_hallucinated_assets_are_excluded(kind, hallucination):
    bot = world()
    collector = RewardCollector(RewardConfig())
    collector.observe(bot, [unit(1, kind, hallucination=hallucination)], [], camera_restricted=True)
    assert not collector.engine._previous.own_assets


@pytest.mark.parametrize("race", ["Protoss", "Terran", "Zerg"])
@pytest.mark.parametrize("result,expected", [(Result.Victory, 10), (Result.Defeat, -10), (Result.Tie, 0)])
def test_dense_terminal_rewards_and_timeouts_preserve_bootstrap(monkeypatch, race, result, expected):
    bot = NeuralBot(Policy(), reward_config=RewardConfig()) if race == "Protoss" else AdversaryBot(Policy(), race, reward_config=RewardConfig())
    world(bot)
    if race == "Protoss":
        monkeypatch.setattr("pluto_sc2.sc2_adapter.encode_observation", lambda _: np.zeros(BASE_OBSERVATION_SIZE))
        size, actions = OBSERVATION_SIZE, len(ACTION_NAMES)
    else:
        monkeypatch.setattr("pluto_sc2.adversary.encode_observation", lambda _: np.zeros(bot.spec.base_dim))
        size, actions = bot.spec.input_dim, bot.spec.action_dim
    bot._observe()
    bot._pending_transition = (np.zeros(size), np.ones(actions, dtype=bool), 0, -.1, .75, 0)
    asyncio.run(bot.on_end(result))
    asyncio.run(bot.on_end(result))
    assert len(bot.transitions) == 1
    transition = bot.transitions[0]
    assert transition.reward == expected
    assert transition.next_value == (.75 if result == Result.Tie else 0)
    assert bot.reward_terminal_outcome == expected
    assert bot.reward_summary["terminal_reward"] == expected


def test_dense_rewards_disabled_for_frozen_opponents_and_teachers():
    config = RewardConfig()
    assert NeuralBot(Policy(), record=False, reward_config=config).reward_config is None
    assert AdversaryBot(Policy(), "Terran", record=False, reward_config=config).reward_config is None
    assert AdversaryBot(Policy(), "Zerg", teacher=lambda *_: 0, reward_config=config).reward_config is None


def test_stale_enemy_death_cannot_reveal_an_offscreen_battle():
    bot = world()
    collector = RewardCollector(RewardConfig())
    collector.observe(bot, [], [unit(1, U.MARINE)], camera_restricted=True)
    step_world(bot, 8)
    collector.observe(bot, [], [], camera_restricted=True)
    step_world(bot, 16)
    bot.state.dead_units = {1}
    collector.observe(bot, [], [], camera_restricted=True)
    assert not collector.engine._previous.confirmed_dead_tags
    assert not any("damage" in name for name in collector.engine.summary()["components"])


def test_idle_production_penalty_requires_resources_and_supply():
    bot = world()
    collector = RewardCollector(RewardConfig())
    nexus = unit(1, U.NEXUS)
    nexus.is_idle = True
    bot.minerals = 0
    collector.observe(bot, [nexus], [], camera_restricted=True)
    assert collector.engine._previous.idle_production == 0
    step_world(bot, 8)
    bot.minerals, bot.supply_left = 50, 0
    collector.observe(bot, [nexus], [], camera_restricted=True)
    assert collector.engine._previous.idle_production == 0
    step_world(bot, 16)
    bot.supply_left = 7
    collector.observe(bot, [nexus], [], camera_restricted=True)
    assert collector.engine._previous.idle_production == 1


def test_counter_candidates_use_only_previously_observed_enemy_types(monkeypatch):
    bot = world()
    seen = []

    def counter(kind, threats, _data):
        seen.append((kind, set(threats)))
        return bool(threats)

    monkeypatch.setattr("pluto_sc2.reward_observation.counter_match", counter)
    collector = RewardCollector(RewardConfig())
    collector.observe(bot, [unit(1, U.STALKER)], [unit(9, U.MARINE)], camera_restricted=True)
    assert seen == [(U.STALKER.value, set())]
    step_world(bot, 8)
    collector.observe(bot, [unit(1, U.STALKER), unit(2, U.STALKER)], [], camera_restricted=True)
    assert seen[-1] == (U.STALKER.value, {U.MARINE.value})
    assert all(asset.counter_match for asset in collector.engine._previous.own_assets)
    assert collector.engine.summary()["components"]["completed_counter_army"] > 0


def test_timeout_correction_removes_terminal_reward_once(monkeypatch):
    bot = world(NeuralBot(Policy(), reward_config=RewardConfig()))
    monkeypatch.setattr("pluto_sc2.sc2_adapter.encode_observation", lambda _: np.zeros(BASE_OBSERVATION_SIZE))
    obs = bot._observe()
    bot._pending_transition = (obs, np.ones(len(ACTION_NAMES), dtype=bool), 0, -.1, .75, 0)
    asyncio.run(bot.on_end(Result.Victory))
    assert bot.correct_reward_timeout() == -10
    assert bot.correct_reward_timeout() == 0
    assert bot.reward_terminal_outcome == 0
    assert bot.reward_summary["terminal_reward"] == 0


def test_collection_reads_own_mining_totals_without_global_kill_or_loss_scores():
    class OwnMiningScore:
        collected_minerals = 120
        collected_vespene = 20

        def __getattr__(self, name):
            raise AssertionError("Forbidden global score field: " + name)

    bot = world()
    bot.state.score = OwnMiningScore()
    collector = RewardCollector(RewardConfig())
    collector.observe(bot, [], [], camera_restricted=True)
    step_world(bot, 8)
    bot.state.score.collected_minerals = 140
    collector.observe(bot, [], [], camera_restricted=True)
    assert collector.engine.summary()["components"]["mined_minerals"] > 0


def test_idle_workers_need_a_currently_visible_harvest_target():
    bot = world()
    worker = unit(1)
    worker.is_idle = True
    mineral = NS(position=Point2((80, 10)), mineral_contents=900)
    bot.mineral_field = [mineral]
    collector = RewardCollector(RewardConfig())
    collector.observe(bot, [worker], [], camera_restricted=True)
    assert collector.engine._previous.idle_workers == 0
    step_world(bot, 8)
    mineral.position = Point2((10, 10))
    collector.observe(bot, [worker], [], camera_restricted=True)
    assert collector.engine._previous.idle_workers == 1
    step_world(bot, 16)
    mineral.position = Point2((10, 80))
    collector.observe(bot, [worker], [], camera_restricted=True)
    assert collector.engine._previous.idle_workers == 0


@pytest.mark.parametrize("kind", [U.WARPGATE, U.GATEWAY, U.HATCHERY])
def test_cooldown_unpowered_and_missing_tech_do_not_count_as_idle_production(kind):
    bot = world()
    bot.minerals, bot.vespene = 2000, 2000
    producer = unit(1, kind)
    producer.is_structure = True
    producer.is_idle, producer.is_powered = True, False
    collector = RewardCollector(RewardConfig())
    collector.observe(bot, [producer], [], camera_restricted=True)
    assert collector.engine._previous.idle_production == 0


def test_replay_phase_changes_alone_do_not_earn_progress_and_initial_full_coverage_does_not_block_it():
    bot = world()
    reference = {"frames": [
        {"seconds": 0, "counts": {"PROBE": 8, "NEXUS": 1}},
        {"seconds": 60, "counts": {"PROBE": 10, "NEXUS": 1, "GATEWAY": 1}},
    ]}
    collector = RewardCollector(RewardConfig(), reference)
    own = [unit(tag) for tag in range(1, 9)] + [unit(20, U.NEXUS)]
    collector.observe(bot, own, [], camera_restricted=True)
    assert collector.engine._previous.replay_similarity == 1
    step_world(bot, 1344)  # New reference phase; same actual army/economy.
    collector.observe(bot, own, [], camera_restricted=True)
    assert collector.engine._previous.replay_progress == 0
    assert "replay_composition_progress" not in collector.engine.summary()["components"]
    step_world(bot, 1352)
    bot.supply_workers = 9
    own.append(unit(9))
    collector.observe(bot, own, [], camera_restricted=True)
    assert collector.engine._previous.replay_progress > 0
    assert collector.engine.summary()["components"]["replay_composition_progress"] > 0
    credited = collector.engine.summary()["components"]["replay_composition_progress"]
    step_world(bot, 1360)
    collector.observe(bot, [], [], camera_restricted=True)
    step_world(bot, 1368)
    collector.observe(bot, own, [], camera_restricted=True)
    assert collector.engine.summary()["components"]["replay_composition_progress"] == credited
