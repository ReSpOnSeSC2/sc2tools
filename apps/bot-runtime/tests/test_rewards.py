"""Behavioral reward checks: verified progress, bounded shaping and no click farming."""
from dataclasses import replace

import pytest

from pluto_sc2.rewards import RewardAsset, RewardConfig, RewardEngine, RewardSnapshot


def army(tag=1, *, health=100, shields=0, **kwargs):
    values = dict(tag=tag, mineral_cost=100, gas_cost=0, category="army",
                  health=health, health_max=100, shields=shields)
    values.update(kwargs)
    return RewardAsset(**values)


def snap(time=0, **kwargs):
    return RewardSnapshot(game_time=time, **kwargs)


def bank_config():
    return RewardConfig(version="tactical-economy-v2", completion_budget=.8, intel_budget=.35,
                        macro_budget=.2, bank_budget=.7, unspent_resources_per_second=.002)


def test_prolonged_excess_bank_is_penalized_after_saving_grace_and_capped():
    engine = RewardEngine(bank_config())
    values = dict(minerals=3000, vespene=1500, supply_used=70)
    assert engine.update(snap(0, **values)).total == 0
    assert engine.update(snap(20, **values)).total == 0
    assert engine.update(snap(30, **values)).components["unspent_resources"] == pytest.approx(-.04)
    engine.update(snap(10000, **values))
    assert engine.summary()["components"]["unspent_resources"] == pytest.approx(-.7)
    assert engine.auxiliary_used <= 4


def test_spending_or_refunding_does_not_earn_bank_reward_and_resets_grace():
    engine = RewardEngine(bank_config())
    high = dict(minerals=3000, vespene=1500, supply_used=70)
    low = dict(minerals=350, vespene=150, supply_used=70)
    engine.update(snap(0, **high))
    engine.update(snap(10, **low))
    engine.update(snap(11, **high))  # Refund is not mined income or positive shaping.
    assert engine.update(snap(30, **high)).total == 0
    assert engine.update(snap(32, **high)).total == pytest.approx(-.004)


@pytest.mark.parametrize("values", [{}, {"minerals": 3000},
    {"minerals": 3000, "vespene": 1500, "supply_used": 190},
    {"minerals": 400, "vespene": 200, "supply_used": 50}])
def test_bank_unknown_hud_reasonable_reserve_and_near_max_army_are_exempt(values):
    engine = RewardEngine(bank_config())
    engine.update(snap(0, **values))
    assert engine.update(snap(600, **values)).total == 0


def test_legacy_bank_behavior_is_preserved_and_outcomes_still_dominate():
    engine = RewardEngine()
    values = dict(minerals=3000, vespene=1500, supply_used=70)
    engine.update(snap(0, **values))
    assert engine.update(snap(600, **values)).total == 0
    config = bank_config()
    assert config.terminal_win - config.auxiliary_budget > config.terminal_draw + config.auxiliary_budget


def test_initial_own_assets_and_resource_balances_are_not_rewards():
    engine = RewardEngine()
    result = engine.update(snap(own_assets=(army(),), collected_minerals=50, collected_gas=10))
    assert result.total == 0
    assert engine.update(snap(1, own_assets=(army(),), collected_minerals=50, collected_gas=10)).total == 0


def test_mining_uses_cumulative_high_water_not_stockpile_refunds_or_counter_reset():
    engine = RewardEngine()
    engine.update(snap(collected_minerals=50, collected_gas=0))
    mined = engine.update(snap(1, collected_minerals=150, collected_gas=25))
    assert mined.components == pytest.approx({"mined_minerals": 0.004, "mined_gas": 0.0015})
    assert engine.update(snap(2, collected_minerals=10, collected_gas=0)).total == 0
    assert engine.update(snap(3, collected_minerals=150, collected_gas=25)).total == 0
    assert engine.update(snap(4, collected_minerals=151, collected_gas=26)).total == pytest.approx(0.0001)


def test_missing_resource_counters_never_invent_income():
    engine = RewardEngine()
    engine.update(snap())
    assert engine.update(snap(1, collected_minerals=1000)).total == 0
    assert engine.update(snap(2)).total == 0
    assert engine.update(snap(3, collected_minerals=1010)).total == pytest.approx(0.0004)


@pytest.mark.parametrize("category", ["worker", "army", "structure", "expansion", "upgrade"])
def test_actual_completed_asset_is_awarded_once(category):
    engine = RewardEngine()
    engine.update(snap())
    building = army(category=category, completed=False)
    assert engine.update(snap(1, own_assets=(building,))).total == 0
    completed = replace(building, completed=True)
    result = engine.update(snap(2, own_assets=(completed,)))
    assert result.components[f"completed_{category}"] > 0
    assert engine.update(snap(3, own_assets=(completed,))).total == 0
    engine.update(snap(4))
    assert engine.update(snap(5, own_assets=(completed,))).total == 0


def test_initial_incomplete_asset_gets_credit_only_when_it_finishes():
    engine = RewardEngine()
    engine.update(snap(own_assets=(army(completed=False),)))
    assert engine.update(snap(1, own_assets=(army(),))).components["completed_army"] == pytest.approx(0.06)


def test_repeated_morph_type_cannot_farm_full_unit_cost():
    engine = RewardEngine()
    engine.update(snap(own_assets=(army(type_id="GATEWAY"),)))
    assert engine.update(snap(1, own_assets=(army(type_id="WARPGATE"),))).total == 0
    assert engine.update(snap(2, own_assets=(army(type_id="GATEWAY"),))).total == 0


def test_only_actual_new_counter_unit_gets_the_counter_bonus():
    engine = RewardEngine()
    engine.update(snap(own_assets=(army(counter_match=True),)))
    unit = army(2, counter_match=True)
    result = engine.update(snap(1, own_assets=(unit,)))
    assert result.components == pytest.approx({"completed_army": 0.06, "completed_counter_army": 0.02})
    assert engine.update(snap(2, own_assets=(unit,))).total == 0
    assert "completed_counter_army" not in engine.update(
        snap(3, own_assets=(army(3, category="worker", counter_match=True),))
    ).components


def test_enemy_damage_and_remaining_kill_share_one_lifetime_value():
    engine = RewardEngine()
    engine.update(snap(visible_enemies=(army(9),)))
    damage = engine.update(snap(1, visible_enemies=(army(9, health=70),)))
    killed = engine.update(snap(2, confirmed_dead_tags=frozenset({9})))
    assert damage.components["enemy_combat_damage"] == pytest.approx(0.03)
    assert killed.components["enemy_combat_damage"] == pytest.approx(0.07)
    assert engine.update(snap(3, confirmed_dead_tags=frozenset({9}))).total == 0
    assert engine.update(snap(4, visible_enemies=(army(9, health=10),))).total == 0


def test_healing_and_shield_regeneration_cannot_farm_damage():
    engine = RewardEngine()
    full = army(9, shields=100, shields_max=100)
    damaged = replace(full, shields=0)
    engine.update(snap(visible_enemies=(full,)))
    assert engine.update(snap(1, visible_enemies=(damaged,))).total == pytest.approx(0.05)
    assert engine.update(snap(2, visible_enemies=(full,))).total == 0
    assert engine.update(snap(3, visible_enemies=(damaged,))).total == 0
    assert engine.update(snap(4, visible_enemies=(replace(damaged, health=50),))).total == pytest.approx(0.025)


def test_first_observation_does_not_credit_preexisting_damage():
    engine = RewardEngine()
    assert engine.update(snap(visible_enemies=(army(9, health=20),))).total == 0
    assert engine.update(snap(1, visible_enemies=(army(9, health=10),))).total == pytest.approx(0.01)


def test_disappearance_and_unknown_death_do_not_imply_kills_or_own_losses():
    engine = RewardEngine()
    engine.update(snap(own_assets=(army(1),), visible_enemies=(army(9),)))
    assert engine.update(snap(1)).total == 0
    assert engine.update(snap(2, confirmed_dead_tags=frozenset({999}))).total == 0
    assert engine.update(snap(3, own_assets=(army(1),), visible_enemies=(army(9),))).total == 0


def test_own_losses_are_confirmed_once_and_efficient_trades_use_net_cost():
    engine = RewardEngine()
    engine.update(snap(own_assets=(army(1),), visible_enemies=(army(9, mineral_cost=300),)))
    result = engine.update(snap(1, confirmed_dead_tags=frozenset({1, 9})))
    assert result.components == pytest.approx({"own_losses": -0.1, "enemy_combat_damage": 0.3})
    assert result.total == pytest.approx(0.2)
    assert result.auxiliary_used == pytest.approx(0.4)
    assert engine.update(snap(2, confirmed_dead_tags=frozenset({1, 9}))).total == 0


def test_equal_cost_trade_is_not_positive_combat_reward():
    engine = RewardEngine()
    engine.update(snap(own_assets=(army(1),), visible_enemies=(army(9),)))
    assert engine.update(snap(1, confirmed_dead_tags=frozenset({1, 9}))).total == pytest.approx(0)


def test_enemy_worker_economic_damage_has_explicit_weight():
    engine = RewardEngine()
    worker = army(9, category="worker", mineral_cost=50)
    engine.update(snap(visible_enemies=(worker,)))
    result = engine.update(snap(1, confirmed_dead_tags=frozenset({9})))
    assert result.components == pytest.approx({"enemy_economic_damage": 0.0625})


def test_morph_or_maximum_health_change_is_not_a_damage_event():
    engine = RewardEngine()
    engine.update(snap(visible_enemies=(army(9, type_id="ROACH"),)))
    result = engine.update(snap(1, visible_enemies=(army(9, health=50, health_max=200, type_id="RAVAGER"),)))
    assert "enemy_combat_damage" not in result.components
    assert result.components == {"new_enemy_type": 0.04}


def test_discovery_rewards_new_information_once_and_never_repeated_camera_visits():
    engine = RewardEngine()
    base = army(9, category="expansion", type_id="HATCHERY")
    first = engine.update(snap(visible_enemies=(base,)))
    assert first.components == pytest.approx({"first_enemy_base": 0.35})
    assert engine.update(snap(1)).total == 0
    assert engine.update(snap(2, visible_enemies=(base,))).total == 0
    assert engine.update(snap(3, visible_enemies=(replace(base, tag=10),))).total == 0
    tech = army(11, category="structure", type_id="SPIRE")
    assert engine.update(snap(4, visible_enemies=(tech,))).components == pytest.approx({"new_enemy_type": 0.04})


def test_base_discovery_leaves_room_for_six_distinct_army_or_tech_sightings():
    engine = RewardEngine()
    base = army(100, category="expansion", type_id="HATCHERY")
    assert engine.update(snap(visible_enemies=(base,))).components == {"first_enemy_base": 0.35}
    # A later townhall/morph cannot consume the army/tech novelty allowance.
    assert engine.update(snap(1, visible_enemies=(replace(base, type_id="LAIR"),))).total == 0
    for index in range(6):
        discovered = army(index, type_id=f"ARMY_OR_TECH_{index}", category="army" if index % 2 else "structure")
        result = engine.update(snap(index + 2, visible_enemies=(discovered,)))
        assert result.components == pytest.approx({"new_enemy_type": 0.04})
    assert engine.summary()["absolute_budget_used"]["intel"] == pytest.approx(0.59)


def test_intel_budget_caps_a_flood_of_novel_types():
    engine = RewardEngine()
    enemies = tuple(army(tag, type_id=f"TYPE_{tag}") for tag in range(100))
    result = engine.update(snap(visible_enemies=enemies))
    assert result.total == pytest.approx(0.6)
    assert result.raw_components["new_enemy_type"] == pytest.approx(4.0)


def test_time_penalties_integrate_elapsed_game_time_independent_of_sampling_rate():
    def accumulate(times):
        engine = RewardEngine()
        return sum(engine.update(snap(t, supply_blocked=True, idle_workers=3, idle_production=2)).total
                   for t in times)
    assert accumulate([0, 10]) == pytest.approx(accumulate([0, 1, 3, 3.5, 9, 10]))
    assert accumulate([0, 10]) == pytest.approx(-0.0024)


def test_time_penalty_uses_previous_state_and_zero_elapsed_time_is_free():
    engine = RewardEngine()
    engine.update(snap(0, supply_blocked=True))
    assert engine.update(snap(0, supply_blocked=True)).total == 0
    assert engine.update(snap(10, supply_blocked=False)).total == pytest.approx(-0.001)
    assert engine.update(snap(20, supply_blocked=False)).total == 0


def test_raw_action_selection_camera_and_command_spam_have_no_reward_surface():
    engine = RewardEngine()
    engine.update(snap())
    # Identical world state after any number of camera/selection/order actions.
    assert all(engine.update(snap(i)).total == 0 for i in range(100))


def test_separate_budgets_preserve_combat_after_extreme_mining_and_production():
    engine = RewardEngine()
    engine.update(snap(collected_minerals=0))
    result = engine.update(snap(1, collected_minerals=10**9, own_assets=(army(1, mineral_cost=10**9),),
                                visible_enemies=(army(9),)))
    assert result.components["mined_minerals"] == pytest.approx(0.35)
    assert result.components["completed_army"] == pytest.approx(1.2)
    combat = engine.update(snap(2, confirmed_dead_tags=frozenset({9})))
    assert combat.total == pytest.approx(0.1)


def test_total_auxiliary_absolute_budget_and_undiscounted_outcome_dominance():
    engine = RewardEngine()
    engine.update(snap(collected_minerals=0, supply_blocked=True, replay_similarity=0,
                       visible_enemies=tuple(army(1000 + i, mineral_cost=10**8, type_id=str(i)) for i in range(20))))
    engine.update(snap(10**8, collected_minerals=10**9, own_assets=(army(1, mineral_cost=10**9),), replay_progress=1,
                       confirmed_dead_tags=frozenset({1000})))
    assert engine.auxiliary_used == pytest.approx(4.0)
    assert sum(abs(v) for v in engine.summary()["components"].values()) <= 4.0 + 1e-12
    assert engine.finish("victory").total == 10
    config = engine.config
    assert config.terminal_win - 4 > config.terminal_draw + 4
    assert config.terminal_draw - 4 > config.terminal_loss + 4


def test_replay_progress_requires_new_completion_and_explicit_same_frame_delta():
    engine = RewardEngine()
    engine.update(snap(replay_similarity=0.2))
    result = engine.update(snap(1, own_assets=(army(1),), replay_similarity=0.5, replay_progress=0.3))
    assert result.components["replay_composition_progress"] == pytest.approx(0.09)
    assert engine.update(snap(2, own_assets=(army(1),), replay_similarity=0.7, replay_progress=0.3)).total == 0
    result = engine.update(snap(3, own_assets=(army(1), army(2)), replay_similarity=0.8, replay_progress=0.1))
    assert result.components["replay_composition_progress"] == pytest.approx(0.03)
    result = engine.update(snap(4, own_assets=(army(3),), replay_similarity=0.4))
    assert "replay_composition_progress" not in result.components
    result = engine.update(snap(5, own_assets=(army(4),), replay_similarity=0.8))
    assert "replay_composition_progress" not in result.components
    assert engine.summary()["replay_similarity_high_water"] == pytest.approx(0.8)


def test_replay_start_at_full_coverage_does_not_suppress_later_production_progress():
    engine = RewardEngine()
    engine.update(snap(own_assets=(army(1),), replay_similarity=1))
    # Target phase advances, lowering coverage; the unchanged player earns zero.
    assert engine.update(snap(10, own_assets=(army(1),), replay_similarity=0.2)).total == 0
    # Against that SAME new target, this completed unit improves coverage 0.2 -> 0.4.
    result = engine.update(snap(11, own_assets=(army(1), army(2)), replay_similarity=0.4, replay_progress=0.2))
    assert result.components["replay_composition_progress"] == pytest.approx(0.06)
    assert engine.summary()["replay_similarity_high_water"] == 1
    # Repeated camera/observation changes cannot repay a completion's delta.
    assert engine.update(snap(12, own_assets=(army(1), army(2)), replay_progress=0.2)).total == 0


def test_audit_counts_record_actual_events_even_after_reward_budgets_exhausted():
    engine = RewardEngine()
    engine.update(snap(collected_minerals=0))
    engine.update(snap(1, collected_minerals=10**9, own_assets=(army(1, mineral_cost=10**9),)))
    engine.update(snap(2, collected_minerals=10**9 + 1, own_assets=(army(2),)))
    summary = engine.summary()
    assert summary["event_counts"]["completed_army"] == 2
    assert summary["signal_totals"]["completed_army"] == 10**9 + 100
    assert summary["signal_totals"]["mined_minerals"] == 10**9 + 1
    assert summary["components"]["completed_army"] == pytest.approx(1.2)


@pytest.mark.parametrize("outcome,expected", [("victory", 10), ("defeat", -10), ("tie", 0),
                                             ("draw", 0), ("time_limit", 0)])
def test_outcomes_and_repeated_terminal_calls(outcome, expected):
    engine = RewardEngine()
    assert engine.finish(outcome).total == expected
    with pytest.raises(RuntimeError, match="already"):
        engine.finish(outcome)
    with pytest.raises(RuntimeError, match="after finish"):
        engine.update(snap())


def test_time_limit_correction_preserves_dense_feedback_and_is_idempotent():
    engine = RewardEngine()
    engine.update(snap())
    dense = engine.update(snap(1, own_assets=(army(),))).total
    terminal = engine.finish("defeat").total
    correction = engine.correct_timeout()
    assert correction.total == 10
    assert dense + terminal + correction.total == pytest.approx(dense)
    assert engine.correct_timeout().total == 0
    assert engine.summary()["total"] == pytest.approx(dense)
    assert engine.summary()["terminal_reward"] == 0
    assert engine.summary()["terminal_correction"] == 10


def test_config_round_trip_and_validation():
    config = RewardConfig()
    assert RewardConfig.from_dict(config.to_dict()) == config
    for values in ({"mining_budget": 1}, {"terminal_win": 7}, {"version": "unknown"},
                   {"combat_coefficient": float("nan")}, {"gas_value": -1}, {"terminal_loss": 1}):
        with pytest.raises(ValueError):
            RewardConfig(**values)


def test_invalid_input_does_not_mutate_reward_time_or_accept_duplicate_tags():
    engine = RewardEngine()
    engine.update(snap(5))
    with pytest.raises(ValueError, match="monotonic"):
        engine.update(snap(4))
    assert engine.update(snap(6)).total == 0
    with pytest.raises(ValueError, match="unique"):
        snap(own_assets=(army(), army()))
    with pytest.raises(ValueError, match="both"):
        snap(own_assets=(army(),), visible_enemies=(army(),))
    with pytest.raises(ValueError):
        army(mineral_cost=float("inf"))
    with pytest.raises(ValueError):
        snap(idle_workers=-1)
    with pytest.raises(ValueError):
        snap(replay_similarity=1.01)
    with pytest.raises(ValueError):
        snap(replay_progress=1.01)
    with pytest.raises(RuntimeError):
        RewardEngine().correct_timeout()
