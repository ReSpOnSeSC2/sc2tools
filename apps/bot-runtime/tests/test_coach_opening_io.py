import hashlib
import json

import pytest

from pluto_sc2.coach_opening_io import opening_snapshot, load_opening


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def library(tmp_path):
    replay = tmp_path / 'source.SC2Replay'
    replay.write_bytes(b'fixture archive')
    replay_id = sha(replay)
    candidate = dict(replay_id=replay_id, source_sha256=replay_id, partition='train', starting_workers=8,
                     result='Victory', matchup='PvT', site_build_label='test opening',
                     milestone_events_first_10_minutes=[dict(name='Pylon', seconds=30, meaning='construction_started')])
    split = tmp_path / 'response90-replay-split.json'
    split.write_text(json.dumps(dict(train_replay_ids=[dict(replay_id=replay_id)], validation_replay_ids=[])))
    manifest = tmp_path / 'response-90-manifest.json'
    manifest.write_text(json.dumps(dict(replays=[dict(replay_id=replay_id, path=str(replay), sha256=replay_id,
                                                    starting_workers=8, matchup='PvT', result='Victory')])))
    path = tmp_path / 'library.json'
    path.write_text(json.dumps(dict(protoss_candidates=[candidate],
                                   sources=[dict(path=str(p), sha256=sha(p)) for p in [split, manifest]])))
    return path, candidate


def test_snapshot_keeps_verified_split_and_replay_identity(tmp_path):
    path, candidate = library(tmp_path)
    snapshot = opening_snapshot(path, candidate['replay_id'][:12], 'Terran')
    assert snapshot['train_ids'] == [candidate['replay_id']]
    assert snapshot['validation_ids'] == []
    assert snapshot['candidate'] == candidate
    assert snapshot['source_library_sha256'] == sha(path)


def test_rejects_changed_replay_or_provenance(tmp_path):
    path, candidate = library(tmp_path)
    (tmp_path / 'source.SC2Replay').write_bytes(b'changed')
    with pytest.raises(ValueError, match='hash'):
        opening_snapshot(path, candidate['replay_id'], 'Terran')
    (tmp_path / 'response90-replay-split.json').write_text('{}')
    with pytest.raises(ValueError, match='provenance'):
        opening_snapshot(path, candidate['replay_id'], 'Terran')


@pytest.mark.parametrize('field,value', [('starting_workers', 12), ('partition', 'validation'),
                                        ('result', 'Defeat'), ('matchup', 'PvZ')])
def test_rejects_ineligible_candidate(tmp_path, field, value):
    path, candidate = library(tmp_path)
    data = json.loads(path.read_text())
    data['protoss_candidates'][0][field] = value
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError, match='winning eight-worker TRAIN'):
        opening_snapshot(path, candidate['replay_id'], 'Terran')


def test_heldout_overlap_is_rejected_even_with_updated_source_hash(tmp_path):
    path, candidate = library(tmp_path)
    split = tmp_path / 'response90-replay-split.json'
    data = json.loads(split.read_text())
    data['validation_replay_ids'] = data['train_replay_ids']
    split.write_text(json.dumps(data))
    data = json.loads(path.read_text())
    data['sources'][0]['sha256'] = sha(split)
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError, match='membership'):
        opening_snapshot(path, candidate['replay_id'], 'Terran')


def test_frozen_opening_loaded_and_tampering_rejected(tmp_path):
    path, candidate = library(tmp_path)
    snapshot = opening_snapshot(path, candidate['replay_id'], 'Terran')
    frozen = tmp_path / 'opening.json'
    frozen.write_text(json.dumps(snapshot))
    metadata = {'sha256': sha(frozen)}
    plan = load_opening(tmp_path, metadata)
    assert plan.replay_id == candidate['replay_id']
    frozen.write_text('{}')
    with pytest.raises(ValueError, match='Frozen opening'):
        load_opening(tmp_path, metadata)


def test_unselected_session_has_no_opening(tmp_path):
    assert load_opening(tmp_path, None) is None


def multiple_library(tmp_path):
    path, candidate = library(tmp_path)
    data = json.loads(path.read_text())
    split_path = tmp_path / 'response90-replay-split.json'
    manifest_path = tmp_path / 'response-90-manifest.json'
    split = json.loads(split_path.read_text())
    manifest = json.loads(manifest_path.read_text())
    for matchup in ['PvT', 'PvP', 'PvZ']:
        for index in range(2):
            archive = tmp_path / (matchup + str(index) + '.SC2Replay')
            archive.write_bytes((matchup + str(index)).encode())
            replay_id = sha(archive)
            data['protoss_candidates'].append(dict(candidate, replay_id=replay_id, source_sha256=replay_id,
                                                  matchup=matchup, site_build_label=f'{matchup} build {index}'))
            split['train_replay_ids'].append(dict(replay_id=replay_id))
            manifest['replays'].append(dict(replay_id=replay_id, path=str(archive), sha256=replay_id,
                                           starting_workers=8, matchup=matchup, result='Victory'))
    split_path.write_text(json.dumps(split))
    manifest_path.write_text(json.dumps(manifest))
    data['sources'] = [dict(path=str(p), sha256=sha(p)) for p in [split_path, manifest_path]]
    path.write_text(json.dumps(data))
    return path


@pytest.mark.parametrize('race,matchup', [('Terran', 'PvT'), ('Protoss', 'PvP'), ('Zerg', 'PvZ')])
def test_random_builds_are_reproducible_and_matchup_specific(tmp_path, race, matchup):
    path = multiple_library(tmp_path)
    picks = [opening_snapshot(path, 'random', race, selection_seed=seed) for seed in range(12)]
    assert len({p['candidate']['site_build_label'] for p in picks}) >= 2
    assert all(p['matchup'] == matchup and p['candidate']['matchup'] == matchup for p in picks)
    again = opening_snapshot(path, 'random', race, selection_seed=4)
    assert picks[4]['candidate'] == again['candidate']
    assert again['selection']['seed'] == 4
    assert again['selection']['method'] == 'uniform_build_family_then_replay'


def test_random_rejects_single_family(tmp_path):
    path, _ = library(tmp_path)
    with pytest.raises(ValueError, match='at least two'):
        opening_snapshot(path, 'random', 'Terran', selection_seed=1)
