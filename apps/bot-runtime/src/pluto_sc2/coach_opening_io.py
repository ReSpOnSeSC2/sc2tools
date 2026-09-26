"""Freeze an explicitly selected verified TRAIN build for one coach session."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import random
import secrets


def _sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def opening_snapshot(library_path, replay_prefix, opponent_race, horizon=240.0, *, selection_seed=None):
    library_path = Path(library_path).resolve()
    library = json.loads(library_path.read_text())
    matchup = 'Pv' + {'Terran': 'T', 'Protoss': 'P', 'Zerg': 'Z'}[opponent_race]
    sources = {}
    for basename in ('response90-replay-split.json', 'response-90-manifest.json'):
        rows = [row for row in library['sources'] if Path(row['path']).name == basename]
        if len(rows) != 1 or _sha(rows[0]['path']) != rows[0]['sha256']:
            raise ValueError('Opening source provenance changed: ' + basename)
        sources[basename] = json.loads(Path(rows[0]['path']).read_text())
    split = sources['response90-replay-split.json']
    train = [row['replay_id'] for row in split['train_replay_ids']]
    validation = [row['replay_id'] for row in split['validation_replay_ids']]
    selection = {'method': 'explicit_replay'}
    if replay_prefix == 'random':
        if selection_seed is not None and (type(selection_seed) is not int or not 0 <= selection_seed < 2**32):
            raise ValueError('Opening selection seed must be a 32-bit nonnegative integer')
        seed = selection_seed if selection_seed is not None else secrets.randbits(32)
        eligible = [row for row in library['protoss_candidates']
                    if row.get('matchup') == matchup and row.get('partition') == 'train'
                    and row.get('starting_workers') == 8 and row.get('result') == 'Victory'
                    and row.get('replay_id') in train and row.get('replay_id') not in validation]
        families = {}
        for row in eligible:
            families.setdefault(row.get('site_build_label') or row['replay_id'], []).append(row)
        if len(families) < 2:
            raise ValueError('Random opening selection needs at least two verified build families for this matchup')
        generator = random.Random(seed)
        family = generator.choice(sorted(families))
        candidate = generator.choice(sorted(families[family], key=lambda row: row['replay_id']))
        selection = {'method': 'uniform_build_family_then_replay', 'seed': seed,
                     'eligible_families': sorted(families), 'selected_family': family,
                     'eligible_replay_ids': sorted(row['replay_id'] for row in eligible)}
    else:
        candidates = [row for row in library['protoss_candidates']
                      if row['replay_id'].startswith(replay_prefix)]
        if len(replay_prefix) < 12 or len(candidates) != 1:
            raise ValueError('Opening replay must uniquely identify a candidate with at least 12 hash characters')
        candidate = candidates[0]
    if (candidate['partition'] != 'train' or candidate['starting_workers'] != 8
            or candidate['result'] != 'Victory' or candidate['matchup'] != matchup):
        raise ValueError('Opening must be a winning eight-worker TRAIN replay for this matchup')
    replay_id = candidate['replay_id']
    if replay_id not in train or replay_id in validation or set(train).intersection(validation):
        raise ValueError('Opening TRAIN/validation membership is invalid')
    verified = [row for row in sources['response-90-manifest.json']['replays'] if row['replay_id'] == replay_id]
    if (len(verified) != 1 or verified[0]['starting_workers'] != 8
            or verified[0]['matchup'] != matchup or verified[0]['result'] != 'Victory'
            or verified[0]['sha256'] != replay_id or _sha(verified[0]['path']) != replay_id
            or candidate['source_sha256'] != replay_id):
        raise ValueError('Opening replay hash or verified metadata does not match')
    return {'schema': 1, 'candidate': candidate, 'train_ids': train, 'validation_ids': validation,
            'matchup': matchup, 'horizon_seconds': float(horizon),
            'selection': selection,
            'source_library': str(library_path), 'source_library_sha256': _sha(library_path),
            'scope': 'Separate coached opening; no active learner/corpus mutation'}


def load_opening(session, metadata):
    if metadata is None:
        return None
    path = Path(session) / 'opening.json'
    if _sha(path) != metadata['sha256']:
        raise ValueError('Frozen opening changed after initialization')
    data = json.loads(path.read_text())
    from .coach_opening import OpeningPlan
    return OpeningPlan.from_candidate(data['candidate'], data['train_ids'], data['validation_ids'],
                                      data['matchup'], horizon_seconds=data['horizon_seconds'])
