"""Prepare a bounded balanced corpus from saved public-library candidate pages.

This downloads originals and inspects archives only. It never starts StarCraft,
changes sharing, or claims that archive eligibility proves extraction success.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
from urllib.parse import quote

from filelock import FileLock

from pluto_sc2.remote import (
    MAX_REPLAY_BYTES, RemoteSyncError, _api_json, _atomic_write, _https_url,
    _read_url, _validate_replay,
)
from pluto_sc2.replays import ReplayError, _player_name, inspect_replay, select_player


def write_json(path: Path, payload: dict) -> None:
    """Publish progress atomically; existing originals are never overwritten."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.corpus-', suffix='.json', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(payload, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def replay_ratings(path: Path, build: int, names: list[str]) -> dict:
    """Read version-exact initData ratings, uniquely matched to participant names."""
    import mpyq
    import s2protocol

    module_path = Path(s2protocol.__file__).parent / 'versions' / f'protocol{build}.py'
    if not module_path.is_file():
        return {'source': 'replay.initData', 'available': False,
                'reason': 'No exact protocol decoder installed for this replay build.'}
    spec = importlib.util.spec_from_file_location(f'_corpus_protocol_{build}', module_path)
    protocol = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(protocol)
    archive = mpyq.MPQArchive(str(path))
    records = protocol.decode_replay_initdata(archive.read_file('replay.initData'))[
        'm_syncLobbyState']['m_userInitialData']
    participants = []
    for name in names:
        matches = [entry for entry in records
                   if _player_name(entry.get('m_name', b'')).casefold() == name.casefold()]
        entry = matches[0] if len(matches) == 1 else {}
        participants.append({'name': name, 'unique_name_match': len(matches) == 1,
                             'scaled_rating': entry.get('m_scaledRating'),
                             'highest_league_enum': entry.get('m_highestLeague')})
    return {'source': 'original replay.initData m_userInitialData', 'available': True,
            'protocol_build': build, 'participants': participants,
            'league_caveat': 'm_highestLeague is the replay-reported highest league, not verified current rank.'}


def eligible_record(info: dict, item: dict, *, player_name: str, build: int) -> tuple[dict, str, str]:
    player = select_player(info, player_name=player_name)
    if len(info['players']) != 2:
        raise ReplayError('Not an exact two-player replay.')
    if player.get('starting_workers') != 8:
        raise ReplayError(f"Selected player starts with {player.get('starting_workers')} workers; eight required.")
    if info['base_build'] != build:
        raise ReplayError(f"Replay Base{info['base_build']} differs from required installed Base{build}.")
    if info['game_speed'] != 'Faster':
        raise ReplayError('Only Faster game speed is supported by this corpus.')
    if info.get('duration_seconds') is None or info['duration_seconds'] < 60:
        raise ReplayError('Aborted or short replay: fewer than 60 actual game seconds.')
    opponent = next(p for p in info['players'] if p['player_id'] != player['player_id'])
    matchup = 'Pv' + {'Terran': 'T', 'Protoss': 'P', 'Zerg': 'Z'}.get(opponent['race'], '?')
    if matchup != item['matchup']:
        raise ReplayError('Archive opponent race disagrees with the candidate matchup.')
    result = {'Win': 'Victory', 'Loss': 'Defeat'}.get(player['result'])
    if result is None or result != item['result']:
        raise ReplayError('Archive player result disagrees with the candidate outcome.')
    return player, matchup, result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate-dir', type=Path, default=Path('runs'))
    parser.add_argument('--output', type=Path, default=Path('runs/response-90-manifest.json'))
    parser.add_argument('--replay-dir', type=Path, default=Path('replays/remote'))
    parser.add_argument('--per-outcome', type=int, default=15)
    parser.add_argument('--base-build', type=int, default=97563)
    parser.add_argument('--player-name', default='ReSpOnSe')
    parser.add_argument('--public-handle', default='response-b80b2b9cf3')
    parser.add_argument('--api-url', default='https://sc2tools-api.onrender.com/v1')
    args = parser.parse_args()
    if not 1 <= args.per_outcome <= 50:
        parser.error('--per-outcome must be between 1 and 50')
    api = _https_url(args.api_url, api=True)
    endpoint = api + '/public/replays/' + quote(args.public_handle, safe='')
    destination = args.replay_dir.resolve()
    destination.mkdir(parents=True, exist_ok=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    candidates = []
    for matchup in ('PvT', 'PvP', 'PvZ'):
        page = json.loads((args.candidate_dir / f'replay-candidates-{matchup}.json').read_text(encoding='utf-8'))
        if page.get('profile', {}).get('handle') != args.public_handle:
            raise ReplayError('Candidate profile does not match the selected public archive.')
        candidates.extend(item for item in page['items'] if item['matchup'] == matchup)
    known_hashes = {}
    for path in destination.glob('sync-*.json'):
        for record in json.loads(path.read_text(encoding='utf-8')).get('replays', []):
            known_hashes[record['file']] = record['sha256']
    selected, excluded = [], []
    counts = Counter()
    seen_hashes = set()
    last_download = -float('inf')
    attempts = downloaded = reused = 0
    progress = args.output.with_suffix('.progress.json')

    def report(complete: bool) -> dict:
        return {'created_at': datetime.now(timezone.utc).isoformat(), 'complete': complete,
                'source': endpoint, 'player_name': args.player_name,
                'selection': {'per_matchup_per_result': args.per_outcome, 'min_duration_seconds': 60,
                              'starting_workers': 8, 'base_build': args.base_build,
                              'order': 'Newest eligible within each matchup and outcome from saved candidate pages'},
                'verification': 'Original archive inspected; SC2 observation extraction still required.',
                'target_extractor_version': 'causal-screen-projection-v8',
                'counts': {f'{m}/{r}': counts[m, r] for m in ('PvT', 'PvP', 'PvZ')
                           for r in ('Victory', 'Defeat')},
                'attempted': attempts, 'downloaded': downloaded, 'reused': reused,
                'replays': selected, 'excluded_records': excluded}

    with FileLock(str(destination / '.replay-sync.lock'), timeout=1):
        for item in candidates:
            key = item['matchup'], item['result']
            if key[1] not in ('Victory', 'Defeat') or counts[key] >= args.per_outcome:
                continue
            game_id = item['gameId']
            filename = 'sc2tools-' + hashlib.sha256(game_id.encode()).hexdigest()[:24] + '.SC2Replay'
            path = destination / filename
            attempts += 1
            info = None
            try:
                if item.get('replayAvailable') is not True:
                    raise ReplayError('Original replay unavailable in public archive.')
                if path.is_symlink():
                    raise ReplayError('Refusing replay symbolic link.')
                expected_hash = known_hashes.get(filename)
                if path.exists():
                    if not path.is_file() or path.stat().st_size > MAX_REPLAY_BYTES:
                        raise ReplayError('Existing replay is not a bounded regular file.')
                    data = path.read_bytes()
                    reused += 1
                else:
                    delay = 3.1 - (time.monotonic() - last_download)
                    if delay > 0:
                        time.sleep(delay)
                    last_download = time.monotonic()
                    signed = _api_json(endpoint + '/' + quote(game_id, safe='') + '/download', None, 30, 2)
                    expected_hash = signed.get('sha256', item.get('sha256'))
                    data = _read_url(_https_url(signed.get('url')), token=None, maximum=MAX_REPLAY_BYTES,
                                     timeout=30, retries=2, purpose='Replay download')
                digest = _validate_replay(data, expected_size=item.get('replaySizeBytes'), expected_hash=expected_hash)
                if not path.exists():
                    _atomic_write(path, data)
                    downloaded += 1
                info = inspect_replay(path)
                player, matchup, result = eligible_record(info, item, player_name=args.player_name,
                                                          build=args.base_build)
                if digest in seen_hashes:
                    raise ReplayError('Duplicate original replay content.')
                ratings = replay_ratings(path, info['base_build'], [p['name'] for p in info['players']])
                entry = {key: info[key] for key in ('replay_id', 'map_name', 'game_version', 'base_build',
                                                    'data_version', 'duration_seconds', 'game_loops')}
                entry.update(path=str(path), sha256=digest, player_id=player['player_id'],
                             starting_workers=player['starting_workers'], matchup=matchup, result=result,
                             source_game_id=game_id, date=item['date'], size_bytes=len(data),
                             archive_ratings=ratings,
                             api_ratings={'source': 'SC2TOOLS public replay-list API; underlying provenance not exposed',
                                          'my_mmr': item.get('myMmr'),
                                          'opponent_mmr': item.get('opponent', {}).get('mmr')})
                selected.append(entry)
                seen_hashes.add(digest)
                counts[matchup, result] += 1
                print(f'Qualified {len(selected)}/{6 * args.per_outcome}: {matchup} {result}, '
                      f'{info["duration_seconds"]:.1f}s, Base{info["base_build"]}', flush=True)
            except (RemoteSyncError, ReplayError, ValueError, OSError) as error:
                entry = {'source_game_id': game_id, 'path': str(path), 'reason': str(error)}
                if info is not None:
                    entry.update({key: info.get(key) for key in ('replay_id', 'duration_seconds', 'base_build')})
                excluded.append(entry)
                print(f'Excluded candidate {attempts}: {error}', flush=True)
            write_json(progress, report(False))
        complete = len(selected) == 6 * args.per_outcome
        payload = report(complete)
        write_json(progress, payload)
        if complete:
            write_json(args.output, payload)
        print(json.dumps({'complete': complete, 'qualified': len(selected), 'excluded': len(excluded),
                          'downloaded': downloaded, 'reused': reused, 'output': str(args.output)}), flush=True)
        return 0 if complete else 2


if __name__ == '__main__':
    raise SystemExit(main())
