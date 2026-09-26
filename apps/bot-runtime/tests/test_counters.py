from types import SimpleNamespace as NS

import pytest
from sc2.ids.unit_typeid import UnitTypeId as U
from s2clientprotocol import data_pb2 as data

from pluto_sc2.counters import counter_match


def weapon(target=data.Weapon.Ground, *, bonus=None, damage=10):
    value = data.Weapon(type=target, damage=damage, attacks=1, speed=1)
    if bonus:
        value.damage_bonus.add(attribute=bonus[0], bonus=bonus[1])
    return value


def unit(kind, *, attributes=(), weapons=(), cost=100, alias=None):
    value = data.UnitTypeData(unit_id=kind.value, attributes=attributes, mineral_cost=cost, weapons=weapons)
    if alias is not None:
        value.unit_alias = alias.value
    return NS(_proto=value)


def scene():
    return NS(units={
        U.MARINE.value: unit(U.MARINE, attributes=(data.Light, data.Biological),
                             weapons=(weapon(data.Weapon.Any),), cost=50),
        U.MARAUDER.value: unit(U.MARAUDER, attributes=(data.Armored, data.Biological),
                               weapons=(weapon(bonus=(data.Armored, 10)),)),
        U.IMMORTAL.value: unit(U.IMMORTAL, attributes=(data.Armored, data.Mechanical),
                               weapons=(weapon(bonus=(data.Armored, 30)),), cost=275),
        U.ROACH.value: unit(U.ROACH, attributes=(data.Armored, data.Biological), weapons=(weapon(),)),
        U.ZERGLING.value: unit(U.ZERGLING, attributes=(data.Light, data.Biological), weapons=(weapon(),)),
        U.PHOENIX.value: unit(U.PHOENIX, attributes=(data.Light, data.Mechanical),
                              weapons=(weapon(data.Weapon.Air, bonus=(data.Light, 5)),)),
        U.VOIDRAY.value: unit(U.VOIDRAY, attributes=(data.Armored, data.Mechanical),
                              weapons=(weapon(data.Weapon.Any, bonus=(data.Armored, 4)),)),
        U.MUTALISK.value: unit(U.MUTALISK, attributes=(data.Light, data.Biological),
                               weapons=(weapon(data.Weapon.Any),)),
        U.OVERLORD.value: unit(U.OVERLORD, attributes=(data.Armored, data.Biological)),
        U.SCV.value: unit(U.SCV, attributes=(data.Light, data.Biological, data.Mechanical), weapons=(weapon(),)),
    })


def test_requires_previously_known_threat():
    game = scene()
    assert not counter_match(U.IMMORTAL.value, [], game)
    assert counter_match(U.IMMORTAL.value, [U.ROACH.value], game)


def test_attribute_bonus_must_match_and_generic_ground_weapon_is_not_counter():
    game = scene()
    assert counter_match(U.MARAUDER.value, [U.ROACH.value], game)
    assert not counter_match(U.MARAUDER.value, [U.ZERGLING.value], game)
    assert not counter_match(U.MARINE.value, [U.ZERGLING.value, U.ROACH.value], game)


def test_weapon_must_hit_the_threat_plane():
    game = scene()
    assert not counter_match(U.IMMORTAL.value, [U.VOIDRAY.value], game)
    assert not counter_match(U.PHOENIX.value, [U.ZERGLING.value], game)
    assert counter_match(U.PHOENIX.value, [U.MUTALISK.value], game)
    assert counter_match(U.MARINE.value, [U.MUTALISK.value], game)


def test_unarmed_air_units_and_worker_scouts_are_not_combat_counter_triggers():
    game = scene()
    assert not counter_match(U.MARINE.value, [U.OVERLORD.value], game)
    assert not counter_match(U.MARAUDER.value, [U.SCV.value], game)


def test_exact_flight_form_and_no_alias_weapon_inheritance():
    game = scene()
    game.units[U.VIKINGFIGHTER.value] = unit(U.VIKINGFIGHTER, attributes=(data.Armored,),
                                            weapons=(weapon(data.Weapon.Air),))
    game.units[U.VIKINGASSAULT.value] = unit(U.VIKINGASSAULT, attributes=(data.Armored,),
                                            weapons=(weapon(),), alias=U.VIKINGFIGHTER)
    assert counter_match(U.MARINE.value, [U.VIKINGFIGHTER.value], game)
    assert not counter_match(U.MARINE.value, [U.VIKINGASSAULT.value], game)
    assert not counter_match(U.VIKINGASSAULT.value, [U.MUTALISK.value], game)
    assert counter_match(U.IMMORTAL.value, [U.VIKINGASSAULT.value], game)


def test_liberator_ground_attack_mode_still_flies():
    game = scene()
    game.units[U.LIBERATORAG.value] = unit(U.LIBERATORAG, attributes=(data.Armored,), weapons=(weapon(),))
    assert counter_match(U.MARINE.value, [U.LIBERATORAG.value], game)
    assert not counter_match(U.IMMORTAL.value, [U.LIBERATORAG.value], game)


def test_hover_attribute_does_not_make_ground_unit_fly():
    game = scene()
    game.units[U.SENTRY.value] = unit(U.SENTRY, attributes=(data.Light, data.Hover), weapons=(weapon(),))
    assert not counter_match(U.PHOENIX.value, [U.SENTRY.value], game)
    assert not counter_match(U.MARINE.value, [U.SENTRY.value], game)


def test_colossus_is_both_targetable_but_not_generic_air_threat():
    game = scene()
    game.units[U.COLOSSUS.value] = unit(U.COLOSSUS, attributes=(data.Armored, data.Massive), weapons=(weapon(),))
    game.units[U.CORRUPTOR.value] = unit(U.CORRUPTOR, weapons=(weapon(data.Weapon.Air, bonus=(data.Massive, 6)),))
    assert counter_match(U.CORRUPTOR.value, [U.COLOSSUS.value], game)
    assert not counter_match(U.MARINE.value, [U.COLOSSUS.value], game)


@pytest.mark.parametrize("kind", [U.CARRIER, U.BATTLECRUISER, U.ORACLE])
def test_known_indirect_weapon_air_threats_without_fabricating_own_weapons(kind):
    game = scene()
    game.units[kind.value] = unit(kind, attributes=(data.Armored,))
    assert counter_match(U.MARINE.value, [kind.value], game)
    assert not counter_match(kind.value, [U.MUTALISK.value], game)


@pytest.mark.parametrize("kind, attributes, cost", [
    (U.SCV, (), 50), (U.MARINE, (data.Summoned,), 50),
    (U.MARINE, (), 0), (U.PHOTONCANNON, (data.Structure,), 150),
])
def test_worker_summon_free_unit_and_structure_cannot_earn_army_counter_reward(kind, attributes, cost):
    game = scene()
    game.units[kind.value] = unit(kind, attributes=attributes, cost=cost, weapons=(weapon(data.Weapon.Any),))
    assert not counter_match(kind.value, [U.MUTALISK.value], game)


@pytest.mark.parametrize("bonus", [0, -1, float("nan"), float("inf")])
def test_bonus_must_be_positive_and_finite(bonus):
    game = scene()
    game.units[U.IMMORTAL.value] = unit(U.IMMORTAL, weapons=(weapon(bonus=(data.Armored, bonus)),))
    assert not counter_match(U.IMMORTAL.value, [U.ROACH.value], game)


def test_unknown_missing_and_noninteger_types_fail_closed():
    game = scene()
    assert not counter_match(999999, [U.ROACH.value], game)
    assert not counter_match(U.IMMORTAL.value, [999999], game)
    assert not counter_match(True, [U.ROACH.value], game)
    assert not counter_match(float(U.IMMORTAL.value), [U.ROACH.value], game)
    assert not counter_match(U.IMMORTAL.value, [float(U.ROACH.value)], game)
    assert not counter_match(U.IMMORTAL.value, [U.ROACH.value], NS(units={}))


def test_int_or_enum_types_are_supported_and_no_live_state_access_is_needed():
    game = scene()
    assert counter_match(U.IMMORTAL, (U.ROACH,), game)
    before = {key: value._proto.SerializeToString() for key, value in game.units.items()}
    assert counter_match(U.IMMORTAL.value, {U.ROACH.value, U.ROACH.value}, game)
    assert before == {key: value._proto.SerializeToString() for key, value in game.units.items()}
