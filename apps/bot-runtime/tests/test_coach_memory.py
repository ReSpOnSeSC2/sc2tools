import json
from types import SimpleNamespace as NS

import pytest
from sc2.ids.ability_id import AbilityId
from sc2.ids.unit_typeid import UnitTypeId
from sc2.position import Point2
from s2clientprotocol import common_pb2 as common
from s2clientprotocol import raw_pb2 as raw

from pluto_sc2.coach_memory import CoachMemory


class RestrictedBot:
    def __init__(self):
        self.time = 0.0
        self.state = NS(game_loop=0, dead_units=set())
        self.camera = Point2((10, 10))
        self.visible = True
        self.fairplay = NS(camera_center=self.camera, on_screen=self.on_screen)
        self.minerals, self.vespene = 50, 0
        self.supply_used, self.supply_cap, self.supply_left = 8, 15, 7
        self.supply_workers, self.supply_army = 8, 0

    def __getattr__(self, name):
        raise AssertionError(f"Forbidden global/unknown bot attribute read: {name}")

    def on_screen(self, point):
        return abs(point.x - self.camera.x) < 6 and abs(point.y - self.camera.y) < 6

    def is_visible(self, point):
        assert self.on_screen(point), "Off-screen visibility must not be queried"
        return self.visible


def unit(tag, kind="PROBE", position=(10, 10), orders=(), **changes):
    kind = UnitTypeId[kind]
    fields = dict(tag=tag, type_id=kind, position=Point2(position),
                  is_structure=kind in {UnitTypeId.NEXUS, UnitTypeId.PYLON, UnitTypeId.CYBERNETICSCORE},
                  is_flying=False, is_cloaked=False, is_burrowed=False, is_ready=True,
                  build_progress=1.0, health=20, health_max=20, shield=20, shield_max=20,
                  energy=0, can_attack=True, can_attack_air=False, can_attack_ground=True,
                  _proto=NS(orders=list(orders)))
    fields.update(changes)
    return NS(**fields)


def advance(bot, loop=8, *, camera=None, visible=True, dead=()):
    bot.state.game_loop, bot.time = loop, loop / 22.4
    bot.state.dead_units = set(dead)
    bot.visible = visible
    if camera is not None:
        bot.camera = Point2(camera)
        bot.fairplay.camera_center = bot.camera


def test_report_contains_only_screen_sightings_and_hud_with_detached_json():
    bot, memory = RestrictedBot(), CoachMemory()
    memory.observe(bot, [unit(1), unit(2, "NEXUS", assigned_harvesters=8, ideal_harvesters=16)],
                   [unit(3, "MARINE")])
    report = memory.report(bot)
    json.dumps(report, allow_nan=False)
    assert report["own_seen_counts"] == {"NEXUS": 1, "PROBE": 1}
    assert report["own_ready_seen_counts"] == report["own_seen_counts"]
    assert report["own_unfinished_seen_counts"] == {}
    assert report["hud"]["supply_workers"] == 8  # HUD does not invent seven known Probe locations.
    assert report["camera"] == [10, 10]
    assert [record["tag"] for record in report["current_enemies"]] == [3]
    assert "orders" not in report["enemy_memory"][0]
    report["own_memory"][0]["position"][0] = 999
    assert memory.own[1]["position"] == [10, 10]


def test_hidden_state_and_unobserved_deaths_do_not_change_reports():
    left, right = RestrictedBot(), RestrictedBot()
    a, b = CoachMemory(), CoachMemory()
    for bot, memory in ((left, a), (right, b)):
        memory.observe(bot, [unit(1)], [unit(2, "MARINE")])
        advance(bot, camera=(50, 50))
    right.state.dead_units = {1, 2, 999999}
    for bot, memory in ((left, a), (right, b)):
        memory.observe(bot, [], [])
    assert a.report(left) == b.report(right)
    assert a.own[1]["status"] == "last_seen"
    assert a.enemies[2]["last_seen_loop"] == 0
    assert not a.current_own and not a.current_enemies


def test_mobile_absence_is_not_death_even_when_old_position_visible():
    bot, memory = RestrictedBot(), CoachMemory()
    memory.observe(bot, [unit(1)], [unit(2, "MARINE")])
    advance(bot)
    memory.observe(bot, [], [])
    assert set(memory.own) == {1} and set(memory.enemies) == {2}


def test_empty_visible_static_position_removed_without_fog_or_mobile_inference():
    bot, memory = RestrictedBot(), CoachMemory()
    memory.observe(bot, [unit(1, "NEXUS")], [unit(2, "PYLON")])
    advance(bot, visible=False)
    memory.observe(bot, [], [])
    assert 1 in memory.own and 2 in memory.enemies
    advance(bot, 16)
    memory.observe(bot, [], [])
    assert not memory.own and not memory.enemies


@pytest.mark.parametrize("hidden_property", ["is_flying", "is_cloaked", "is_burrowed"])
def test_disappeared_nonstatic_or_concealed_structure_remains_unknown(hidden_property):
    bot, memory = RestrictedBot(), CoachMemory()
    memory.observe(bot, [], [unit(2, "PYLON", **{hidden_property: True})])
    advance(bot)
    memory.observe(bot, [], [])
    assert 2 in memory.enemies


def test_only_fresh_preceding_camera_sighting_can_confirm_mobile_death():
    bot, memory = RestrictedBot(), CoachMemory()
    memory.observe(bot, [unit(1)], [unit(2, "MARINE")])
    advance(bot, dead=(1, 2))
    memory.observe(bot, [], [])
    assert not memory.own and not memory.enemies


@pytest.mark.parametrize("loop,intermediate", [(40, False), (16, True)])
def test_old_sighting_cannot_reveal_mobile_death(loop, intermediate):
    bot, memory = RestrictedBot(), CoachMemory()
    memory.observe(bot, [unit(1)], [])
    if intermediate:
        advance(bot, 8)
        memory.observe(bot, [], [])
    advance(bot, loop, dead=(1,))
    memory.observe(bot, [], [])
    assert 1 in memory.own


def test_sightings_update_type_completion_health_and_queue_without_duplicate_counts():
    bot, memory = RestrictedBot(), CoachMemory()
    memory.observe(bot, [unit(1, "PYLON", is_ready=False, build_progress=.5)], [])
    assert memory.report(bot)["own_unfinished_seen_counts"] == {"PYLON": 1}
    advance(bot)
    memory.observe(bot, [unit(1, "PYLON", health=50)], [])
    report = memory.report(bot)
    assert report["own_seen_counts"] == {"PYLON": 1}
    assert report["own_unfinished_seen_counts"] == {}
    assert memory.own[1]["first_seen_loop"] == 0
    assert memory.own[1]["last_seen_loop"] == 8
    assert memory.own[1]["health"] == 50


def test_own_queue_uses_public_static_names_and_permitted_targets_only():
    bot, memory = RestrictedBot(), CoachMemory()
    build = raw.UnitOrder(ability_id=AbilityId.PROTOSSBUILD_PYLON.value, progress=.25,
                          target_world_space_pos=common.Point(x=12, y=10))
    hidden_point = raw.UnitOrder(ability_id=AbilityId.MOVE_MOVE.value,
                                 target_world_space_pos=common.Point(x=90, y=90))
    known_unit = raw.UnitOrder(ability_id=AbilityId.ATTACK_ATTACK.value, target_unit_tag=9)
    hidden_unit = raw.UnitOrder(ability_id=AbilityId.ATTACK_ATTACK.value, target_unit_tag=999)
    probe_queue = raw.UnitOrder(ability_id=AbilityId.NEXUSTRAIN_PROBE.value, progress=.5)
    research = raw.UnitOrder(ability_id=AbilityId.RESEARCH_WARPGATE.value, progress=.1)
    unknown = raw.UnitOrder(ability_id=987654, progress=0)
    memory.observe(bot, [unit(1, orders=[build, hidden_point, known_unit, hidden_unit, unknown]),
                         unit(2, "NEXUS", orders=[probe_queue]),
                         unit(3, "CYBERNETICSCORE", orders=[research])],
                   [unit(9, "MARINE", orders=[hidden_unit])])
    orders = memory.own[1]["orders"]
    assert orders[0]["produces"] == "PYLON"
    assert orders[0]["target"] == {"kind": "point", "position": [12, 10]}
    assert orders[2]["target"] == {"kind": "unit", "tag": 9}
    assert "target" not in orders[1] and "target" not in orders[3]
    assert orders[4]["ability_name"] == "UNKNOWN"
    assert memory.own[2]["orders"][0]["produces"] == "PROBE"
    assert memory.own[3]["orders"][0]["researches"] == "WARPGATERESEARCH"
    assert "orders" not in memory.enemies[9]


def test_stale_queues_are_marked_last_seen_and_not_advanced_by_clock():
    bot, memory = RestrictedBot(), CoachMemory()
    memory.observe(bot, [unit(2, "NEXUS", orders=[raw.UnitOrder(
        ability_id=AbilityId.NEXUSTRAIN_PROBE.value, progress=.5)])], [])
    advance(bot, 200, camera=(50, 50))
    memory.observe(bot, [], [])
    assert memory.own[2]["status"] == "last_seen"
    assert memory.own[2]["orders"][0]["progress"] == .5
    assert memory.report(bot)["own_seen_counts"] == {"NEXUS": 1}


def test_memory_bound_prunes_oldest_mobile_before_structure_and_preserves_current():
    bot, memory = RestrictedBot(), CoachMemory(max_records=3)
    memory.observe(bot, [unit(1, "NEXUS"), unit(2)], [unit(3, "MARINE")])
    advance(bot, camera=(50, 50))
    memory.observe(bot, [unit(4, position=(50, 50))], [])
    assert set(memory.own) == {1, 4} and set(memory.enemies) == {3}
    advance(bot, 16, camera=(80, 80))
    memory.observe(bot, [unit(5, position=(80, 80))], [])
    assert set(memory.own) == {1, 4, 5} and not memory.enemies
    assert memory.current_own[0]["tag"] == 5


def test_ownership_change_has_one_current_record():
    bot, memory = RestrictedBot(), CoachMemory()
    memory.observe(bot, [], [unit(1, "MARINE")])
    advance(bot)
    memory.observe(bot, [unit(1, "MARINE")], [])
    assert set(memory.own) == {1} and not memory.enemies


def test_repeated_loop_is_idempotent_and_reports_require_current_observation():
    bot, memory = RestrictedBot(), CoachMemory()
    with pytest.raises(ValueError, match="Observe"):
        memory.report(bot)
    memory.observe(bot, [unit(1)], [])
    memory.observe(bot, [], [])
    assert memory.current_own[0]["tag"] == 1
    advance(bot)
    with pytest.raises(ValueError, match="Observe"):
        memory.report(bot)
    memory.observe(bot, [], [])
    advance(bot, 0)
    with pytest.raises(ValueError, match="backwards"):
        memory.observe(bot, [], [])


@pytest.mark.parametrize("limit", [0, 1025, True, 1.5])
def test_memory_limit_validation(limit):
    with pytest.raises(ValueError, match="max_records"):
        CoachMemory(limit)


def test_duplicate_tags_and_excess_current_screen_are_rejected():
    bot = RestrictedBot()
    with pytest.raises(ValueError, match="unique"):
        CoachMemory().observe(bot, [unit(1)], [unit(1, "MARINE")])
    with pytest.raises(ValueError, match="exceeds"):
        CoachMemory(max_records=1).observe(bot, [unit(1), unit(2)], [])
