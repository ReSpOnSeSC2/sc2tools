"""Actual collector/engine feedback through the new neural driver boundary."""
import asyncio
from copy import deepcopy
import json
from types import SimpleNamespace as NS

import pytest
from sc2.data import Race, Result
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2

from pluto_sc2 import neural_reward_feedback_v1 as module
from pluto_sc2.fairplay import FairPlayController


def unit(tag, kind=U.SCV, *, x=10, health=40, visible=True):
    return NS(tag=tag, type_id=kind, position=Point2((x, 10)), is_ready=True,
              is_hallucination=False, is_structure=False, health=health, health_max=40,
              shield=0, shield_max=0, is_idle=False, is_visible=visible, is_on_screen=True,
              is_snapshot=False, is_cloaked=False, is_revealed=False)


def world():
    cost = NS(_proto=NS(mineral_cost=50, vespene_cost=0, food_required=1, attributes=[], weapons=[]))
    return NS(state=NS(game_loop=0, upgrades=set(), dead_units=set(),
                       score=NS(collected_minerals=0, collected_vespene=0)),
              units=[], structures=[], enemy_units=[], enemy_structures=[], mineral_field=[],
              game_data=NS(units={U.SCV.value: cost, U.PROBE.value: cost}, upgrades={}),
              fairplay=FairPlayController(camera_center=(10, 10)), is_visible=lambda p: p.x < 30,
              supply_left=7, supply_cap=15, supply_workers=8, supply_army=0, supply_used=8,
              minerals=50, vespene=0, race=Race.Protoss, time=0, player_id=1)


def frame(bot, loop):
    bot.state.game_loop = loop
    bot.time = loop / 22.4
    return {"game_loop": loop, "hud": {"player_id": 1}}


def feedback():
    return module.NeuralRewardFeedback(session_id="fixture", checkpoint_sha256="a" * 64)


def test_visible_worker_damage_then_kill_is_credited_once_without_score_or_input_changes():
    bot, rewards = world(), feedback()
    enemy = unit(9)
    bot.enemy_units = [enemy]
    assert rewards.observe(bot, frame(bot, 0))["reward"] == 0
    enemy.health = 20
    damage = rewards.observe(bot, frame(bot, 8))
    assert damage["components"]["enemy_economic_damage"] == pytest.approx(.03125)
    bot.enemy_units = []
    bot.state.dead_units = {9}
    kill = rewards.observe(bot, frame(bot, 16))
    assert kill["components"]["enemy_economic_damage"] == pytest.approx(.03125)
    assert rewards.observe(bot, frame(bot, 24))["reward"] == 0
    assert bot.fairplay.audit == []
    assert rewards.finish("victory", replay_verified=True) == 10
    report = rewards.report()
    assert report["summary"]["total"] == pytest.approx(10.0625)
    assert not report["eligible_for_policy_optimization"]


@pytest.mark.parametrize("mode", ["offscreen", "native_offscreen", "fog", "unrevealed_cloak", "snapshot", "hallucination"])
def test_unpermitted_enemy_cannot_generate_damage_or_death_reward(mode):
    bot, rewards = world(), feedback()
    enemy = unit(9)
    if mode == "offscreen":
        enemy.position = Point2((90, 10))
    elif mode == "native_offscreen":
        enemy.is_on_screen = False
    elif mode == "fog":
        enemy.is_visible = False
    elif mode == "unrevealed_cloak":
        enemy.is_cloaked = True
    elif mode == "snapshot":
        enemy.is_snapshot = True
    else:
        enemy.is_hallucination = True
    bot.enemy_units = [enemy]
    rewards.observe(bot, frame(bot, 0))
    enemy.health = 1
    assert rewards.observe(bot, frame(bot, 8))["reward"] == 0
    bot.enemy_units = []
    bot.state.dead_units = {9}
    assert rewards.observe(bot, frame(bot, 16))["reward"] == 0


def test_healing_then_repeated_damage_and_disappearance_do_not_farm_reward():
    bot, rewards = world(), feedback()
    enemy = unit(9)
    bot.enemy_units = [enemy]
    rewards.observe(bot, frame(bot, 0))
    enemy.health = 20
    rewards.observe(bot, frame(bot, 8))
    enemy.health = 40
    assert rewards.observe(bot, frame(bot, 16))["reward"] == 0
    enemy.health = 20
    assert rewards.observe(bot, frame(bot, 24))["reward"] == 0
    bot.enemy_units = []
    assert rewards.observe(bot, frame(bot, 32))["reward"] == 0


@pytest.mark.parametrize("outcome,limited,failed,verified,expected", [
    ("victory", False, None, True, 10), ("defeat", False, None, True, -10),
    ("victory", True, None, True, 0), ("defeat", True, None, True, 0),
    ("tie", False, None, True, 0), ("victory", False, "transport failed", True, 0),
    ("defeat", False, None, False, 0), ("unknown", False, None, True, 0),
])
def test_terminal_feedback_requires_valid_native_evidence_and_times_out_neutrally(
        outcome, limited, failed, verified, expected):
    rewards = feedback()
    assert rewards.finish(outcome, time_limited=limited, failure=failed, replay_verified=verified) == expected
    with pytest.raises(RuntimeError, match="already recorded"):
        rewards.finish(outcome, replay_verified=True)
    assert rewards.report()["optimizer_updates"] == 0


def test_stale_wrong_player_and_duplicate_frames_fail_before_reward_state_changes():
    bot, rewards = world(), feedback()
    current = frame(bot, 8)
    for wrong in ({"game_loop": 0, "hud": {"player_id": 1}},
                  {"game_loop": 8, "hud": {"player_id": 2}}):
        with pytest.raises(ValueError, match="observation"):
            rewards.observe(bot, wrong)
    assert rewards.collector.last_loop is None
    rewards.observe(bot, current)
    with pytest.raises(ValueError, match="increasing"):
        rewards.observe(bot, current)


def test_driver_records_feedback_without_altering_actor_frame_or_bypassing_parent(monkeypatch):
    bot, rewards, events, called = world(), feedback(), [], []
    async def parent_step(self, native_bot, observed):
        called.append((native_bot, deepcopy(observed)))
        return "unchanged-parent"
    monkeypatch.setattr(module.PredictionDriver, "step", parent_step)
    driver = module.RewardedPredictionDriver(None, session_id="fixture", checkpoint_sha256="a" * 64,
                emit=lambda *a, **k: events.append((a, k)), feedback=rewards)
    current = frame(bot, 0)
    original = deepcopy(current)
    assert asyncio.run(driver.step(bot, current)) == "unchanged-parent"
    assert current == original and called == [(bot, original)]
    assert events[0][0] == ("neural_reward_observed",)
    assert bot.fairplay.audit == []


def test_opt_in_bot_closes_feedback_after_native_replay_verification(tmp_path, monkeypatch):
    config = {"max_game_seconds": 300, "session_id": "fixture", "checkpoint_sha256": "a" * 64}
    bot = module.RewardedAlphaStarLiveBot(tmp_path, config, None)
    assert isinstance(bot.driver, module.RewardedPredictionDriver)
    async def parent_end(self, outcome):
        self._time_limited = False
        self.replay_validation = {"verified": True, "replay_sha256": "b" * 64}
    monkeypatch.setattr(module.AlphaStarLiveBot, "on_end", parent_end)
    asyncio.run(bot.on_end(Result.Victory))
    report = json.loads((tmp_path / "neural-rewards.json").read_text())
    assert report["terminal_reward_delta"] == 10
    assert report["terminal_callback_accepted"] is True
    assert report["receipt_status"] == "provisional"
    assert report["native_reward_evidence_accepted"] is False
    assert report["host_final_integrity_verified"] is False
    assert report["optimizer_updates"] == 0 and not report["actor_input_modified"]
    before = (tmp_path / "neural-rewards.json").read_bytes()
    asyncio.run(bot.on_end(Result.Victory))
    assert (tmp_path / "neural-rewards.json").read_bytes() == before


def test_runtime_error_cannot_be_recorded_as_a_normal_defeat(tmp_path, monkeypatch):
    config = {"max_game_seconds": 300, "session_id": "fixture", "checkpoint_sha256": "a" * 64}
    bot = module.RewardedAlphaStarLiveBot(tmp_path, config, None)
    bot.error = "native adapter setup failed"
    async def parent_end(self, outcome):
        self._time_limited = False
        self.replay_validation = {"verified": True, "replay_sha256": "b" * 64}
    monkeypatch.setattr(module.AlphaStarLiveBot, "on_end", parent_end)
    asyncio.run(bot.on_end(Result.Defeat))
    report = json.loads((tmp_path / "neural-rewards.json").read_text())
    assert report["terminal_reward_delta"] == 0
    assert report["receipt_status"] == "rejected"
    assert report["rejection"] == "native adapter setup failed"
    assert report["terminal_callback_accepted"] is False
