import asyncio
import json

from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U

from pluto_sc2.schema import ACTION_TO_INDEX
from test_coach_bot import Unit, world, order


def scout_world(tmp_path):
    bot = world(tmp_path)
    bot._pluto_action_context = {}

    async def abilities(units, **kwargs):
        return [[A.MOVE_MOVE] for _ in units]

    bot.get_available_abilities = abilities
    return bot


def test_no_probe_scout_before_gateway_foundation_even_after_build_click(tmp_path):
    bot = scout_world(tmp_path)
    legal = {"no_op", "scout"}
    assert not asyncio.run(bot._opening_probe_scout_intent([Unit()], order(scout=True), legal))
    assert "scout" not in legal
    bot._gateway_scout_builder = dict(tag=1, position=[53, 50], foundation_observed=False)
    assert not asyncio.run(bot._opening_probe_scout_intent([Unit()], order(scout=True), legal))
    assert not bot._gateway_scout_builder["foundation_observed"]


def test_gateway_builder_scouts_after_observed_start_not_first_worker(tmp_path):
    bot = scout_world(tmp_path)
    bot._gateway_scout_builder = dict(tag=8, position=[53, 50], foundation_observed=False)
    bot.memory.own[10] = dict(type="GATEWAY", position=[53, 50], is_ready=False)
    units = [Unit(tag=1), Unit(tag=8)]
    legal = {"no_op"}
    assert asyncio.run(bot._opening_probe_scout_intent(units, order(scout=True), legal))
    intent = bot._pluto_action_context[ACTION_TO_INDEX["scout"]]
    assert [unit.tag for unit in intent.sources] == [8]
    assert intent.ability == A.MOVE_MOVE and intent.minimap
    assert bot._gateway_scout_builder["foundation_observed"]


def test_hidden_or_absent_gateway_builder_is_not_replaced_by_another_probe(tmp_path):
    bot = scout_world(tmp_path)
    bot._gateway_scout_builder = dict(tag=8, position=[53, 50], foundation_observed=True)
    assert not asyncio.run(bot._opening_probe_scout_intent([Unit(tag=1)], order(scout=True), {"scout"}))
    assert not asyncio.run(bot._opening_probe_scout_intent(
        [Unit(tag=8, position=(150, 150))], order(scout=True), {"scout"}))


def test_confirmed_gateway_command_records_builder_but_not_foundation(tmp_path):
    bot = scout_world(tmp_path)
    bot.fairplay.audit.append(dict(kind="selection", source_tags=[8], command_confirmation="accepted",
                                  effective_target=[53.02, 50.03]))
    bot._selected_actions[0] = dict(name="build_gateway", position=[53, 50], revision=1)
    bot._confirm_commands([Unit(U.PROBE, tag=8)])
    assert bot._gateway_scout_builder == dict(tag=8, position=[53.02, 50.03],
        accepted_at=bot.time, foundation_observed=False)


def test_returned_scout_becomes_available_to_mining_without_permitting_another_trip(tmp_path):
    bot = scout_world(tmp_path)
    bot._worker_scout_lease.designated_worker_tag = 8
    bot.probe_route.start(8, (50, 50), (150, 150), bot.time, position=(50, 50))
    bot.probe_route.mission.update(return_reason="observed_probe_damage", status="returning")
    bot.in_pathing_grid = lambda _: True
    probe = Unit(tag=8, health=10, health_max=20, shield=0, shield_max=20)
    assert not asyncio.run(bot._probe_route_step([probe], [], order(scout=True)))
    assert bot._reserved_scout_worker() is None
    assert bot.probe_route.mission["observed_home"]
    assert bot.probe_route.designated_tag == 8
    assert not bot.probe_route.start(9, (50, 50), (150, 150), bot.time, position=(50, 50))


def test_probe_local_inspection_uses_spatial_input_and_actual_confirmation(tmp_path):
    bot = scout_world(tmp_path)
    bot.probe_route.start(8, (10, 10), (55, 50), bot.time, position=(50, 50))
    bot.in_pathing_grid = lambda _: True
    probe = Unit(tag=8, health=20, health_max=20, shield=20, shield_max=20)
    assert asyncio.run(bot._probe_route_step([probe], [], order(scout=True)))
    assert bot.probe_route.mission["looks"] == 0
    bot.fairplay.audit[0].update(command_confirmation="accepted", command_source_tags=[8])
    bot._confirm_commands([probe])
    assert bot.probe_route.mission["looks"] == 1
    assert not bot.client.requests[0].actions[0].HasField("action_raw")


def test_explicit_supply_override_is_opt_in_and_keeps_its_source_label(tmp_path):
    assert world(tmp_path).opening is None
    (tmp_path / "supply-opening.json").write_text(json.dumps({"schema": 1, "profile": "user-supply-opening-v1"}))
    bot = world(tmp_path)
    assert bot.executor.opening is bot.opening
    assert bot.opening.summary()["source"] == "explicit_user_instruction"
    assert [step["supply"] for step in bot.opening.summary()["sequence"]] == [12, 14, 17, 17, 17, 17, 17]
