"""Archive-only corpus eligibility tests; no network or StarCraft process."""
from copy import deepcopy

import pytest

from pluto_sc2.replays import ReplayError
from scripts.prepare_balanced_replays import eligible_record


def records():
    info = {'players': [
        {'player_id': 1, 'name': 'ReSpOnSe', 'race': 'Protoss', 'result': 'Win', 'starting_workers': 8},
        {'player_id': 2, 'name': 'Opponent', 'race': 'Protoss', 'result': 'Loss', 'starting_workers': 8},
    ], 'base_build': 97563, 'game_speed': 'Faster', 'duration_seconds': 600.0}
    return info, {'matchup': 'PvP', 'result': 'Victory'}


def test_balanced_corpus_verifies_exact_player_race_result_and_worker_count():
    info, item = records()
    player, matchup, result = eligible_record(info, item, player_name='response', build=97563)
    assert player['player_id'] == 1
    assert (matchup, result) == ('PvP', 'Victory')


@pytest.mark.parametrize(('field', 'value'), [
    ('starting_workers', 12), ('starting_workers', None), ('race', 'Terran'), ('result', 'Loss'),
])
def test_wrong_player_demonstrations_are_excluded(field, value):
    info, item = records()
    info['players'][0][field] = value
    with pytest.raises(ReplayError):
        eligible_record(info, item, player_name='ReSpOnSe', build=97563)


@pytest.mark.parametrize(('field', 'value'), [
    ('base_build', 97425), ('game_speed', 'Normal'), ('duration_seconds', 1.875), ('duration_seconds', None),
])
def test_incompatible_build_speed_and_aborted_games_are_excluded(field, value):
    info, item = records()
    info[field] = value
    with pytest.raises(ReplayError):
        eligible_record(info, item, player_name='ReSpOnSe', build=97563)


def test_duplicate_identity_and_mismatched_matchup_fail_closed():
    info, item = records()
    original = deepcopy(info)
    info['players'][1]['name'] = 'ReSpOnSe'
    with pytest.raises(ReplayError, match='exactly one'):
        eligible_record(info, item, player_name='ReSpOnSe', build=97563)
    original['players'][1]['race'] = 'Zerg'
    with pytest.raises(ReplayError, match='matchup'):
        eligible_record(original, item, player_name='ReSpOnSe', build=97563)
