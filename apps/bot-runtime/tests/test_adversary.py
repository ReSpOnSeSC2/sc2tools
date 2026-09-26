import asyncio
from copy import deepcopy
from types import SimpleNamespace as NS

import numpy as np
import pytest
from s2clientprotocol import sc2api_pb2 as api, query_pb2 as query
from sc2.data import Race, Result
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2

from pluto_sc2.adversary import (
    AdversaryBot, AdversaryBudget, Intent, _army, encode_observation,
    legal_action_mask, placement, validate_adversary_audit,
)
from pluto_sc2.adversary_schema import get_spec, metadata, validate_metadata


class Unit(NS):
    def __init__(self, kind=U.SCV, tag=1, position=(50, 50), **values):
        fields = dict(type_id=kind, tag=tag, position=Point2(position), is_structure=False,
                      is_ready=True, is_idle=True, is_visible=True, is_snapshot=False, is_cloaked=False,
                      is_revealed=False, is_enemy=False, is_mine=True, health=100, health_max=100,
                      shield=0, build_progress=1, is_flying=False, is_detector=False, ground_dps=10,
                      air_dps=0, can_attack=True, can_attack_air=False, can_attack_ground=True,
                      can_be_attacked=True, abilities=[], add_on_tag=0, is_carrying_vespene=False,
                      is_carrying_minerals=False, is_carrying_resource=False, is_mechanical=True,
                      is_biological=True, vespene_contents=2250, mineral_contents=1800,
                      assigned_harvesters=0, ideal_harvesters=3, _proto=NS(orders=[]))
        fields.update(values)
        super().__init__(**fields)

    def distance_to(self, value):
        return self.position.distance_to(value.position if hasattr(value, "position") else value)

    def has_buff(self, buff):
        return False


class Client:
    def __init__(self):
        self.requests = []
        self.codes = [1]

    async def _execute(self, **request):
        self.requests.append(request)
        if "query" in request:
            return api.Response(query=query.ResponseQuery(placements=[
                query.ResponseQueryBuildingPlacement(result=1)]))
        return api.Response(action=api.ResponseAction(result=self.codes))


def scene(race="Terran"):
    bot = NS(spec=get_spec(race), units=[], structures=[], enemy_units=[], enemy_structures=[],
             mineral_field=[], vespene_geyser=[], time=0.0, minerals=500, vespene=500,
             supply_used=8, supply_cap=15, supply_workers=8, supply_army=0, supply_left=7,
             start_location=Point2((50, 50)), enemy_start_locations=[Point2((150, 150))],
             game_info=NS(playable_area=NS(x=0, y=0, width=200, height=200), map_center=Point2((100, 100))),
             game_data=NS(units={}, abilities={}), state=NS(upgrades=set(), game_loop=0),
             fairplay=AdversaryBudget(), client=Client(), can_afford=lambda _: False,
             can_feed=lambda _: True, is_visible=lambda _: True, queried=[])

    async def abilities(units, **kwargs):
        bot.queried.extend(units)
        return [u.abilities for u in units]

    async def can_place(ability, points):
        return [True] * len(points)

    async def can_place_single(ability, point):
        return True

    bot.get_available_abilities = abilities
    bot.can_place, bot.can_place_single = can_place, can_place_single
    return bot


@pytest.mark.parametrize("race", ["Terran", "Zerg"])
def test_race_contract_shapes_and_hidden_enemy_invariance(race):
    bot = scene(race)
    expected = encode_observation(bot)
    assert expected.shape == (bot.spec.base_dim,)
    bot.enemy_units = [Unit(U.MARINE, is_visible=False, health=float("nan")),
                       Unit(U.MARINE, is_snapshot=True, health=float("nan")),
                       Unit(U.GHOST, is_cloaked=True, health=float("nan"))]
    np.testing.assert_array_equal(expected, encode_observation(bot))
    bot.enemy_units.append(Unit(U.MARINE, tag=4, position=(150, 150)))
    assert not np.array_equal(expected, encode_observation(bot))
    bot.units = [Unit(U[bot.spec.worker], position=(160, 160))]
    assert not np.array_equal(expected, encode_observation(bot))  # Own off-camera state is explicitly allowed.
    assert asyncio.run(legal_action_mask(bot)).shape == (bot.spec.action_dim,)
    assert bot.queried == bot.units  # Never ask hidden enemy ability state.
    validate_metadata(metadata(race), race)
    with pytest.raises(ValueError, match="contract mismatch"):
        validate_metadata(metadata(race), "Zerg" if race == "Terran" else "Terran")
    with pytest.raises(ValueError, match="override"):
        metadata(race, fog_of_war=False)


def test_six_hundred_apm_budget_and_group_commands_are_auditable():
    async def run():
        bot = scene()
        bot.units = [Unit(U.MARINE, tag=1), Unit(U.MARAUDER, tag=2)]
        intent = Intent(tuple(bot.units), A.ATTACK_ATTACK, Point2((150, 150)))
        for index in range(602):
            bot.time = index * .1
            assert await bot.fairplay.issue(bot, intent)
            assert not await bot.fairplay.issue(bot, intent)
        assert len(bot.client.requests) == 602
        command = bot.client.requests[0]["action"].actions[0].action_raw.unit_command
        assert list(command.unit_tags) == [1, 2]
        assert bot.fairplay.peak == 600
        data = dict(summary=bot.fairplay.summary(), actions=bot.fairplay.audit)
        assert validate_adversary_audit(data)["max_apm"] == 600
        bad = deepcopy(data)
        bad["actions"][1]["time"] = .01
        with pytest.raises(ValueError, match="pacing"):
            validate_adversary_audit(bad)
    asyncio.run(run())


def test_budget_rejects_foreign_sources_and_hidden_enemy_targets_before_input():
    async def run():
        bot = scene()
        bot.units = [Unit()]
        with pytest.raises(ValueError, match="not owned"):
            await bot.fairplay.issue(bot, Intent((Unit(tag=99),), A.MOVE_MOVE))
        with pytest.raises(ValueError, match="fogged"):
            await bot.fairplay.issue(bot, Intent(tuple(bot.units), A.ATTACK_ATTACK,
                                                 Unit(tag=99, is_enemy=True, is_visible=False)))
        assert not bot.client.requests and not bot.fairplay.audit
    asyncio.run(run())


def test_placement_never_queries_fogged_footprints():
    bot = scene()
    checked = []
    bot.is_visible = lambda p: p.x < 50

    async def query(ability, points):
        checked.extend(points)
        half_width = 1 if ability == A.TERRANBUILD_SUPPLYDEPOT else 1.5
        assert all(p.x + half_width <= 50 for p in points)
        return [True] * len(points)

    bot.can_place = query
    assert asyncio.run(placement(bot, A.TERRANBUILD_BARRACKS, U.BARRACKS, Point2((50, 50)))) is not None
    assert checked
    bot.is_visible = lambda _: False
    checked.clear()
    assert asyncio.run(placement(bot, A.TERRANBUILD_BARRACKS, U.BARRACKS, Point2((50, 50)))) is None
    assert not checked


def test_terran_reactor_second_slot_and_addon_clearance():
    bot = scene()
    reactor = Unit(U.BARRACKSREACTOR, tag=9, is_structure=True)
    producer = Unit(U.BARRACKS, tag=1, is_structure=True, add_on_tag=9,
                    abilities=[A.BARRACKSTRAIN_MARINE], _proto=NS(orders=[NS(ability_id=560)]))
    bot.structures = [producer, reactor]
    bot.can_afford = lambda kind: kind == U.MARINE
    mask = asyncio.run(legal_action_mask(bot))
    index = bot.spec.action_names.index("train_marine")
    assert mask[index]
    producer._proto.orders.append(NS(ability_id=560))
    assert not asyncio.run(legal_action_mask(bot))[index]
    producer._proto.orders.clear()
    producer.add_on_tag = 0
    producer.abilities = [A.BUILD_TECHLAB_BARRACKS]
    bot.can_afford = lambda kind: kind == U.BARRACKSTECHLAB
    queries = []

    async def blocked(ability, point):
        queries.append((ability, point))
        return False

    bot.can_place_single = blocked
    index = bot.spec.action_names.index("build_techlab_barracks")
    assert not asyncio.run(legal_action_mask(bot))[index]
    assert queries == [(A.TERRANBUILD_SUPPLYDEPOT, Point2((52.5, 49.5)))]
    bot.is_visible = lambda _: False
    queries.clear()
    assert not asyncio.run(legal_action_mask(bot))[index]
    assert not queries


@pytest.mark.parametrize("building", ["BARRACKS", "FACTORY", "STARPORT"])
@pytest.mark.parametrize("addon", ["TECHLAB", "REACTOR"])
def test_addon_waits_two_seconds_only_after_observed_landing(building, addon):
    bot = scene()
    ability = A[f"BUILD_{addon}_{building}"]
    producer = Unit(U[building], tag=1, is_structure=True, abilities=[ability])
    bot.structures = [producer]
    bot.can_afford = lambda kind: kind == U[building + addon]
    index = bot.spec.action_names.index(f"build_{addon.lower()}_{building.lower()}")
    assert asyncio.run(legal_action_mask(bot))[index]  # Ordinary grounded producer is unaffected.
    assert bot._action_context[index].ability == ability
    bot.time = 10
    producer.type_id, producer.is_flying = U[building + "FLYING"], True
    assert not asyncio.run(legal_action_mask(bot))[index]
    bot.time = 11
    producer.type_id, producer.is_flying = U[building], False
    assert not asyncio.run(legal_action_mask(bot))[index]
    bot.time = 12.99
    assert not asyncio.run(legal_action_mask(bot))[index]
    bot.time = 13
    assert asyncio.run(legal_action_mask(bot))[index]
    assert bot._action_context[index].ability == ability
    assert bot.fairplay.max_apm == 600
    assert bot._landing_guard.summary()["observed_landings"] == 1


def test_landing_one_factory_does_not_block_other_grounded_factory():
    bot = scene()
    producer = Unit(U.FACTORYFLYING, tag=1, is_structure=True, is_flying=True,
                    abilities=[A.BUILD_TECHLAB_FACTORY])
    other = Unit(U.FACTORY, tag=2, is_structure=True, abilities=[A.BUILD_TECHLAB_FACTORY])
    bot.structures = [producer, other]
    bot.can_afford = lambda kind: kind == U.FACTORYTECHLAB
    index = bot.spec.action_names.index("build_techlab_factory")
    assert asyncio.run(legal_action_mask(bot))[index]
    bot.time = 1
    producer.type_id, producer.is_flying = U.FACTORY, False
    assert asyncio.run(legal_action_mask(bot))[index]
    assert bot._action_context[index].sources == (other,)


def test_landing_guard_is_reported_only_for_terran():
    terran = AdversaryBot(None, "Terran")
    zerg = AdversaryBot(None, "Zerg")
    assert terran.control_summary["addon_landing"] == {
        "version": "observed-landing-addon-settle-v1", "settle_seconds": 2.0, "observed_landings": 0}
    assert zerg.control_summary["addon_landing"] is None
    assert zerg.fairplay.max_apm == terran.fairplay.max_apm == 600


@pytest.mark.parametrize("query_id", [A.BUILD_TECHLAB_FACTORY, A.BUILD_TECHLAB])
def test_addon_target_requirement_uses_verified_point_for_exact_or_generic_query(query_id):
    bot = scene()
    producer = Unit(U.FACTORY, tag=1, is_structure=True, abilities=[A.BUILD_TECHLAB_FACTORY])
    bot.structures = [producer]
    bot.game_data.abilities[A.BUILD_TECHLAB_FACTORY.value] = NS(id=A.BUILD_TECHLAB, _proto=NS(target=5))
    bot.can_afford = lambda kind: kind == U.FACTORYTECHLAB
    bot.client.available_ability_details = {1: {query_id.value: True}}
    index = bot.spec.action_names.index("build_techlab_factory")
    assert asyncio.run(legal_action_mask(bot))[index]
    assert bot._action_context[index].target == producer.position
    request = bot.client.requests[-1]["query"].placements[0]
    assert request.ability_id == A.BUILD_TECHLAB_FACTORY.value
    assert request.placing_unit_tag == producer.tag
    assert Point2.from_proto(request.target_pos) == producer.position
    bot.client.available_ability_details[1][query_id.value] = False
    assert asyncio.run(legal_action_mask(bot))[index]
    assert bot._action_context[index].ability is A.BUILD_TECHLAB_FACTORY
    assert bot._action_context[index].target is None


def test_orphan_addon_is_reused_by_land_instead_of_recreated():
    bot = scene()
    producer = Unit(U.FACTORY, tag=1, is_structure=True,
                    abilities=[A.BUILD_TECHLAB_FACTORY, A.LIFT_FACTORY])
    addon = Unit(U.TECHLAB, tag=2, position=(80, 50), is_structure=True)
    bot.structures = [producer, addon]
    bot.can_afford = lambda kind: kind == U.FACTORYTECHLAB
    build = bot.spec.action_names.index("build_techlab_factory")
    mask = asyncio.run(legal_action_mask(bot))
    assert not mask[build]
    assert mask[bot.spec.action_names.index("lift_factory")]
    producer.type_id, producer.is_flying = U.FACTORYFLYING, True
    producer.abilities = [A.LAND_FACTORY]
    bot.time = 1
    land = bot.spec.action_names.index("land_factory")
    assert asyncio.run(legal_action_mask(bot))[land]
    assert bot._action_context[land].target == Point2((77.5, 50.5))
    assert bot._action_context[land].ability is A.LAND_FACTORY
    producer.is_idle = False
    bot.time = 2
    assert not asyncio.run(legal_action_mask(bot))[land]


def test_addon_of_other_family_or_attached_to_another_producer_does_not_block_build():
    bot = scene()
    producer = Unit(U.FACTORY, tag=1, is_structure=True, abilities=[A.BUILD_TECHLAB_FACTORY])
    reactor = Unit(U.REACTOR, tag=2, position=(80, 50), is_structure=True)
    bot.structures = [producer, reactor]
    bot.can_afford = lambda kind: kind == U.FACTORYTECHLAB
    build = bot.spec.action_names.index("build_techlab_factory")
    assert asyncio.run(legal_action_mask(bot))[build]
    reactor.type_id = U.TECHLAB
    bot.structures.append(Unit(U.BARRACKS, tag=3, position=(77.5, 50.5), is_structure=True, add_on_tag=2))
    assert asyncio.run(legal_action_mask(bot))[build]


def test_idle_barracks_keeps_marine_production_without_pointless_lift():
    bot = scene()
    producer = Unit(U.BARRACKS, tag=1, is_structure=True,
                    abilities=[A.BARRACKSTRAIN_MARINE, A.LIFT_BARRACKS])
    bot.structures = [producer]
    bot.can_afford = lambda kind: kind == U.MARINE
    mask = asyncio.run(legal_action_mask(bot))
    assert mask[bot.spec.action_names.index("train_marine")]
    assert not mask[bot.spec.action_names.index("lift_barracks")]


def test_diagnostic_lift_override_is_explicit_and_only_changes_lift_purpose_mask():
    bot = scene()
    producer = Unit(U.FACTORY, tag=1, is_structure=True, abilities=[A.LIFT_FACTORY])
    bot.structures = [producer]
    lift = bot.spec.action_names.index("lift_factory")
    assert not asyncio.run(legal_action_mask(bot))[lift]
    bot._diagnostic_allow_unpurposeful_lift = True
    assert asyncio.run(legal_action_mask(bot))[lift]
    producer.abilities = []
    assert not asyncio.run(legal_action_mask(bot))[lift]


def test_production_destination_commits_only_after_engine_accepts_selected_lift():
    bot = scene()
    factory = Unit(U.FACTORY, tag=1, is_structure=True, abilities=[A.LIFT_FACTORY])
    lab = Unit(U.TECHLAB, tag=2, position=(80, 50), is_structure=True)
    bot.structures = [factory, lab]
    index = bot.spec.action_names.index("lift_factory")
    assert asyncio.run(legal_action_mask(bot))[index]
    bot.client.codes = [2]
    assert not asyncio.run(bot.fairplay.issue(bot, bot._action_context[index]))
    assert not bot._production_control.pending and not bot._production_control.reservations
    bot.time = 1
    bot.client.codes = [1]
    assert asyncio.run(legal_action_mask(bot))[index]
    assert asyncio.run(bot.fairplay.issue(bot, bot._action_context[index]))
    assert bot._production_control.pending[factory.tag].addon_tag == lab.tag
    assert bot._production_control.reservations[lab.tag][0] == factory.tag
    event = bot.fairplay.audit[-1]
    assert event["production_relocation"]["reason"] == "reuse_owned_addon"
    assert event["ability"] == A.LIFT_FACTORY.value
    assert not event["diagnostic_lift_override"]


def test_zerg_uses_larva_not_hatchery_for_drones_and_injects_owned_base():
    bot = scene("Zerg")
    larva = Unit(U.LARVA, tag=1, abilities=[A.LARVATRAIN_DRONE])
    queen = Unit(U.QUEEN, tag=2, abilities=[A.EFFECT_INJECTLARVA])
    base = Unit(U.HATCHERY, tag=3, is_structure=True)
    bot.units, bot.structures = [larva, queen], [base]
    bot.can_afford = lambda kind: kind == U.DRONE
    mask = asyncio.run(legal_action_mask(bot))
    train = bot.spec.action_names.index("train_drone")
    inject = bot.spec.action_names.index("inject_larva")
    assert mask[train] and bot._action_context[train].sources == (larva,)
    assert mask[inject] and bot._action_context[inject].target is base
    assert not _army(larva, bot.spec) and not _army(Unit(U.EGG), bot.spec)
    assert _army(queen, bot.spec)
    base.has_buff = lambda _: True
    assert not asyncio.run(legal_action_mask(bot))[inject]


class Policy:
    def value(self, observation):
        return .75

    def act(self, observation, mask, deterministic=False):
        return 0, 0.0, .75


@pytest.mark.parametrize("policy,record,teacher", [(Policy(), False, None), (None, True, None),
                                                  (None, False, lambda *_: 0)])
def test_diagnostic_lift_override_cannot_enter_learned_or_teacher_rollout(policy, record, teacher):
    bot = AdversaryBot(policy, "Terran", record=record, teacher=teacher)
    bot._diagnostic_allow_unpurposeful_lift = True
    with pytest.raises(ValueError, match="Diagnostic lift override"):
        asyncio.run(bot.on_start())


@pytest.mark.parametrize("race", ["Terran", "Zerg"])
def test_adversary_checks_exact_eight_worker_start(race):
    bot = AdversaryBot(Policy(), race)
    bot.race = Race[race]
    bot.workers, bot.townhalls = [object()] * 8, [object()]
    bot.client = Client()
    asyncio.run(bot.on_start())
    assert bot.client.game_step == 2
    bot.workers.append(object())
    with pytest.raises(ValueError, match="eight"):
        asyncio.run(bot.on_start())
    assert bot.error


@pytest.mark.parametrize("result,terminated,reward,next_value", [(Result.Victory, True, 1, 0), (Result.Tie, False, 0, .75)])
def test_terminal_finalization_and_timeout_bootstrap(result, terminated, reward, next_value):
    bot = AdversaryBot(Policy(), "Terran")
    bot.supply_workers, bot.supply_army = 8, 0
    obs = np.zeros(bot.spec.input_dim, dtype=np.float32)
    bot._last_observation = obs
    bot._pending_transition = (obs, np.ones(bot.spec.action_dim, dtype=bool), 0, 0.0, .75, 0.1)
    asyncio.run(bot.on_end(result))
    asyncio.run(bot.on_end(result))
    assert len(bot.transitions) == 1
    t = bot.transitions[0]
    assert t.terminated == terminated and t.truncated != terminated
    assert t.reward == reward and t.next_value == next_value


def test_teacher_decisions_never_become_ppo_transitions(monkeypatch):
    def teacher(bot, obs, mask):
        return 0

    results = []
    teacher.on_action_result = lambda action, accepted: results.append((action, accepted))
    bot = AdversaryBot(Policy(), "Zerg", teacher=teacher)
    bot.state = NS(game_loop=0)
    monkeypatch.setattr("pluto_sc2.adversary.encode_observation", lambda _: np.zeros(bot.spec.base_dim, dtype=np.float32))

    async def mask(_):
        result = np.zeros(bot.spec.action_dim, dtype=bool)
        result[0] = True
        return result

    monkeypatch.setattr("pluto_sc2.adversary.legal_action_mask", mask)
    asyncio.run(bot.on_step(0))
    asyncio.run(bot.on_end(Result.Tie))
    assert len(bot.decisions) == 1 and bot.decisions[0]["teacher"] and bot.decisions[0]["accepted"]
    assert results == [(0, True)]
    assert not bot.transitions


@pytest.mark.parametrize("settings", [{"max_game_seconds": float("nan")}, {"max_game_seconds": True},
                                      {"reward_shaping": float("inf")}, {"expected_start_workers": 8.0},
                                      {"step_mul": 0}, {"max_apm": True}])
def test_invalid_adversary_configuration_rejected(settings):
    with pytest.raises(ValueError):
        AdversaryBot(Policy(), "Zerg", **settings)


def test_step_error_is_preserved_for_runner_and_does_not_make_rollout(monkeypatch):
    bot = AdversaryBot(Policy(), "Terran")

    def fail():
        raise RuntimeError("malformed observation")

    monkeypatch.setattr(bot, "_observe", fail)
    with pytest.raises(RuntimeError, match="malformed"):
        asyncio.run(bot.on_step(0))
    assert bot.error == "RuntimeError: malformed observation"
    asyncio.run(bot.on_end(Result.Defeat))
    assert not bot.transitions
