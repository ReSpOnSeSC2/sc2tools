"""Pure command provenance/partition tests; never starts the game engine."""
import json
from types import SimpleNamespace

import pytest

from pluto_sc2.opponent_builds import command_action, teacher_orders_from_intents, load_build_orders, tracker_evidence
from pluto_sc2.replays import ReplayError


@pytest.mark.parametrize(('name', 'race', 'action'), [
    ('BuildBarracks', 'Terran', 'build_barracks'),
    ('BuildBarracksTechLab', 'Terran', 'build_techlab_barracks'),
    ('BuildTechLabFactory', 'Terran', 'build_techlab_factory'),
    ('BuildWidowMine', 'Terran', 'train_widowmine'),
    ('TrainViking', 'Terran', 'train_vikingfighter'),
    ('ResearchCombatShield', 'Terran', 'research_shieldwall'),
    ('UpgradeTerranInfantryArmor2', 'Terran', 'research_terraninfantryarmorslevel2'),
    ('MorphDrone', 'Zerg', 'train_drone'),
    ('MorphToRavager', 'Zerg', 'morph_ravager'),
    ('UpgradeToLair', 'Zerg', 'morph_lair'),
    ('ResearchZergMeleeWeaponsLevel1', 'Zerg', 'research_zergmeleeweaponslevel1'),
    ('EvolveMetabolicBoost', 'Zerg', 'research_zerglingmovementspeed'),
    ('TrainMarine', 'Zerg', None), ('BuildAutoTurret', 'Terran', None),
    ('UnknownFutureAbility', 'Terran', None),
])
def test_command_mapping_is_explicit_and_race_scoped(name, race, action):
    assert command_action(name, race) == action


def test_repeated_build_attempts_have_one_teacher_record_at_real_command_time():
    orders = [{'action': 'build_supplydepot', 'game_loop': loop, 'target_point': [10, 10]}
              for loop in (100, 110, 200)]
    evidence = [{'action': 'build_supplydepot', 'game_loop': 120, 'position': [10, 10],
                 'source_event_type': 'SUnitInitEvent'}]
    teacher, unmatched = teacher_orders_from_intents(orders, evidence)
    assert len(teacher) == 1 and teacher[0]['game_loop'] == 110
    assert teacher[0]['tracker_evidence'][0]['game_loop'] == 120
    assert teacher[0]['confirmed_output_count'] == 1 and unmatched == 0
    assert len(orders) == 3  # Raw attempts remain intact.


def test_build_confirmation_requires_matching_target_and_addon_offset():
    orders = [
        {'action': 'build_supplydepot', 'game_loop': 10, 'target_point': [40, 40]},
        {'action': 'build_techlab_barracks', 'game_loop': 20, 'target_point': [10.5, 10.5]},
    ]
    evidence = [
        {'action': 'build_supplydepot', 'game_loop': 30, 'position': [10, 10], 'source_event_type': 'SUnitInitEvent'},
        {'action': 'build_techlab_barracks', 'game_loop': 30, 'position': [13, 10], 'source_event_type': 'SUnitInitEvent'},
    ]
    teacher, unmatched = teacher_orders_from_intents(orders, evidence)
    assert len(teacher) == 1 and teacher[0]['action'] == 'build_techlab_barracks'
    assert unmatched == 1


def test_zergling_pairs_and_late_births_do_not_fabricate_start_times():
    orders = [{'action': 'train_zergling', 'game_loop': 10, 'game_seconds': 10 / 22.4}]
    evidence = [{'action': 'train_zergling', 'game_loop': 500, 'source_event_type': 'SUnitBornEvent'}] * 3
    teacher, unmatched = teacher_orders_from_intents(orders, evidence)
    assert teacher[0]['game_loop'] == 10
    assert teacher[0]['confirmed_output_count'] is None and unmatched == 0
    assert teacher[0]['tracker_evidence'] == []
    assert teacher[0]['confirmation_kind'] == 'unconfirmed_exact_command_intent'


def test_actual_scv_command_pattern_keeps_first_input_and_does_not_claim_late_input_caused_birth():
    commands = [{'action': 'train_scv', 'game_loop': loop} for loop in (10, 236, 239)]
    evidence = [{'action': 'train_scv', 'game_loop': 282, 'source_event_type': 'SUnitBornEvent'}]
    teacher, _ = teacher_orders_from_intents(commands, evidence)
    assert [order['game_loop'] for order in teacher] == [10, 236, 239]
    assert all(order['confirmation_kind'] == 'unconfirmed_exact_command_intent' for order in teacher)
    assert all(order['confirmed_output_count'] is None and not order['tracker_evidence'] for order in teacher)


def test_tracker_ownership_uses_event_time_and_does_not_reassign_history(tmp_path, monkeypatch):
    import mpyq
    import pluto_sc2.opponent_builds as module

    events = [
        {'_event': 'SUnitBornEvent', '_gameloop': 10, 'm_unitTagIndex': 1, 'm_unitTagRecycle': 1,
         'm_upkeepPlayerId': 1, 'm_unitTypeName': b'Drone', 'm_creatorUnitTagIndex': 8,
         'm_creatorUnitTagRecycle': 2, 'm_creatorAbilityName': b'LarvaTrain'},
        {'_event': 'SUnitOwnerChangeEvent', '_gameloop': 20, 'm_unitTagIndex': 1, 'm_unitTagRecycle': 1,
         'm_upkeepPlayerId': 2},
        {'_event': 'SUnitTypeChangeEvent', '_gameloop': 30, 'm_unitTagIndex': 1, 'm_unitTagRecycle': 1,
         'm_unitTypeName': b'Lair'},
    ]
    monkeypatch.setattr(mpyq, 'MPQArchive', lambda path: SimpleNamespace(read_file=lambda name: b'fixture'))
    monkeypatch.setattr(module, '_metadata_protocol', lambda: SimpleNamespace(decode_replay_tracker_events=lambda raw: iter(events)))
    former = tracker_evidence(tmp_path / 'fake.SC2Replay', 1, 'Zerg')
    current = tracker_evidence(tmp_path / 'fake.SC2Replay', 2, 'Zerg')
    assert [record['action'] for record in former] == ['train_drone']
    assert [record['action'] for record in current] == ['morph_lair']
    assert former[0]['creator_tag'] == [8, 2]
    assert former[0]['creator_ability'] == 'LarvaTrain'


def artifact():
    return {'format_version': 1,
            'protoss_split': {'train_replay_ids': ['a' * 64], 'validation_replay_ids': ['b' * 64]},
            'partitions': {'train': [{'race': 'Terran', 'replay_id': 'a' * 64, 'bootstrap_weight': 2,
                                      'teacher_orders': [{'action': 'train_scv', 'game_loop': 16,
                                                          'game_seconds': 16 / 22.4}]}],
                           'validation': []}}


def test_build_loader_defaults_to_training_and_rejects_partition_leakage(tmp_path):
    path = tmp_path / 'artificial-build-orders.json'
    data = artifact()
    path.write_text(json.dumps(data))
    loaded = load_build_orders(path, 'Terran')
    assert len(loaded) == 1
    assert loaded[0]['partition'] == 'train'
    assert loaded[0]['orders'] == data['partitions']['train'][0]['teacher_orders']
    assert load_build_orders(path, 'Terran', partition='validation') == []
    data['partitions']['train'][0]['replay_id'] = 'b' * 64
    path.write_text(json.dumps(data))
    with pytest.raises(ReplayError, match='wrong replay partition'):
        load_build_orders(path, 'Terran')


@pytest.mark.parametrize('mutation', ['overlap', 'bad_action', 'bad_weight', 'bad_time'])
def test_build_loader_rejects_invalid_contract(tmp_path, mutation):
    data = artifact()
    record = data['partitions']['train'][0]
    if mutation == 'overlap':
        data['protoss_split']['validation_replay_ids'] = ['a' * 64]
    elif mutation == 'bad_action':
        record['teacher_orders'][0]['action'] = 'train_drone'
    elif mutation == 'bad_time':
        record['teacher_orders'][0]['game_seconds'] = 500
    else:
        record['bootstrap_weight'] = float('inf')
    path = tmp_path / 'artificial.json'
    path.write_text(json.dumps(data))
    with pytest.raises(ReplayError):
        load_build_orders(path, 'Terran')
