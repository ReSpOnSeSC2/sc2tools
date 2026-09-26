"""Offline opponent build-command provenance; never exports policy observations.

Commands preserve their real replay loop. Construction-init events corroborate
building attempts spatially. Production, morph and research remain unconfirmed
attempts: births and completed upgrades do not prove which queued input caused
them. These schedules never claim that every attempted command succeeded.
"""
from __future__ import annotations

from collections import Counter, defaultdict
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile

import numpy as np

from .adversary_schema import get_spec
from .replays import ReplayError, _metadata_protocol, _text, grouped_split, inspect_replay, select_player


def _normalized(value: str) -> str:
    return re.sub('[^a-z0-9]', '', value.lower())


def command_action(name: str, race: str) -> str | None:
    """Whitelist aliases against the race's actual supported action vocabulary."""
    spec = get_spec(race)
    aliases = {}
    for kind, units in (('build', spec.buildings), ('train', spec.train), ('morph', spec.morphs)):
        for unit in units:
            prefixes = {'build': ('Build',), 'train': ('Train', 'Build', 'Morph'),
                        'morph': ('MorphTo', 'UpgradeTo', 'Morph')}[kind]
            for prefix in prefixes:
                aliases[_normalized(prefix + unit)] = kind + '_' + unit.lower()
    for upgrade in spec.upgrades:
        for prefix in ('Research', 'Evolve', 'Upgrade'):
            aliases[_normalized(prefix + upgrade)] = 'research_' + upgrade.lower()
    custom = {
        'TrainViking': 'train_vikingfighter', 'BuildHellbat': 'train_helliontank',
        'MorphSwarmHost': 'train_swarmhostmp', 'MorphToLurker': 'morph_lurkermp',
        'ResearchCombatShield': 'research_shieldwall', 'ResearchConcussiveShells': 'research_punishergrenades',
        'ResearchCloakingField': 'research_bansheecloak', 'EvolveMetabolicBoost': 'research_zerglingmovementspeed',
        'EvolveAdrenalGlands': 'research_zerglingattackspeed', 'EvolveCentrifugalHooks': 'research_centrificalhooks',
        'EvolveGroovedSpines': 'research_evolvegroovedspines',
        'EvolveMuscularAugments': 'research_evolvemuscularaugments',
    }
    for producer in ('barracks', 'factory', 'starport'):
        for addon in ('techlab', 'reactor'):
            custom['Build' + producer + addon] = 'build_' + addon + '_' + producer
            custom['Build' + addon + producer] = 'build_' + addon + '_' + producer
    for level in (1, 2, 3):
        for source, target in (
            ('TerranInfantryWeapons', 'terraninfantryweapons'),
            ('TerranInfantryArmor', 'terraninfantryarmors'),
            ('VehicleWeapons', 'terranvehicleweapons'), ('ShipWeapons', 'terranshipweapons'),
        ):
            custom[f'Upgrade{source}{level}'] = f'research_{target}level{level}'
    aliases.update({_normalized(key): value for key, value in custom.items() if value in spec.action_names})
    result = aliases.get(_normalized(name))
    return result if result in spec.action_names else None


def _tracker_action(type_name: str, event_name: str, race: str) -> str | None:
    spec = get_spec(race)
    normalized = _normalized(type_name)
    if event_name == 'SUpgradeEvent':
        return next(('research_' + unit.lower() for unit in spec.upgrades
                     if _normalized(unit) == normalized), None)
    if event_name == 'SUnitInitEvent':
        action = next(('build_' + unit.lower() for unit in spec.buildings
                       if _normalized(unit) == normalized), None)
        if action:
            return action
        for producer in ('barracks', 'factory', 'starport'):
            for addon in ('techlab', 'reactor'):
                if normalized == producer + addon:
                    return 'build_' + addon + '_' + producer
    if event_name == 'SUnitBornEvent':
        return next(('train_' + unit.lower() for unit in spec.train
                     if _normalized(unit) == normalized), None)
    if event_name == 'SUnitTypeChangeEvent':
        return next(('morph_' + unit.lower() for unit in spec.morphs
                     if _normalized(unit) == normalized), None)
    return None


def tracker_evidence(path: Path, player_id: int, race: str) -> list[dict]:
    """Track ownership at each event, never a unit object's final owner."""
    import mpyq

    archive = mpyq.MPQArchive(str(path))
    owners = {}
    evidence = []
    for event in _metadata_protocol().decode_replay_tracker_events(archive.read_file('replay.tracker.events')):
        event_name = event['_event'].rsplit('.', 1)[-1]
        tag = (event.get('m_unitTagIndex'), event.get('m_unitTagRecycle'))
        if event_name in ('SUnitBornEvent', 'SUnitInitEvent', 'SUnitOwnerChangeEvent'):
            owners[tag] = event.get('m_upkeepPlayerId')
        if event_name == 'SUnitDiedEvent':
            owners.pop(tag, None)
        owner = event.get('m_playerId') if event_name == 'SUpgradeEvent' else owners.get(tag)
        if owner != player_id or event['_gameloop'] <= 0:
            continue
        type_name = _text(event.get('m_upgradeTypeName', event.get('m_unitTypeName', '')))
        action = _tracker_action(type_name, event_name, race)
        if action:
            evidence.append({'action': action, 'game_loop': event['_gameloop'],
                             'game_seconds': event['_gameloop'] / 22.4,
                             'source_event_type': event_name, 'source_type_name': type_name,
                             'unit_tag': list(tag) if tag[0] is not None else None,
                             'creator_tag': [event['m_creatorUnitTagIndex'], event.get('m_creatorUnitTagRecycle')]
                             if 'm_creatorUnitTagIndex' in event else None,
                             'creator_ability': _text(event['m_creatorAbilityName'])
                             if event.get('m_creatorAbilityName') else None,
                             'position': [event['m_x'], event['m_y']] if 'm_x' in event else None})
    return evidence


def teacher_orders_from_intents(orders: list[dict], evidence: list[dict], *, max_delay_seconds: float = 180) -> tuple[list[dict], int]:
    """Deduplicate only construction starts; other exact commands stay unconfirmed.

    Births and upgrade completions cannot resolve a producer's queue without its
    selection history, current build times and cancellations. Do not invent a
    causal pairing, generic latency, production start time or Zergling pair.
    """
    by_action = defaultdict(list)
    for index, order in enumerate(orders):
        by_action[order['action']].append(index)
    matches = defaultdict(list)
    unmatched = 0
    for event in evidence:
        if event['source_event_type'] != 'SUnitInitEvent' or not event['action'].startswith('build_'):
            continue
        candidates = []
        for index in by_action[event['action']]:
            command = orders[index]
            delay = event['game_loop'] - command['game_loop']
            if delay < 0 or delay > max_delay_seconds * 22.4 or matches[index]:
                continue
            target, position = command.get('target_point'), event.get('position')
            if command['action'].startswith('build_') and target and position:
                # SC2 addon command points denote the parent building; the
                # actual addon center is (+2.5, -0.5) from that point.
                target = ([target[0] + 2.5, target[1] - .5]
                          if command['action'].startswith(('build_techlab_', 'build_reactor_')) else target)
                if math.dist(target, position) > 2:
                    continue
            candidates.append(index)
        if candidates:
            nearest = max(candidates, key=lambda index: (orders[index]['game_loop'], index))
            matches[nearest].append(event)
        else:
            unmatched += 1
    planned = []
    for index, order in enumerate(orders):
        if matches[index]:
            planned.append({**order, 'confirmed_output_count': len(matches[index]),
                            'tracker_evidence': matches[index],
                            'confirmation_kind': 'construction_init_spatial_time_correspondence'})
        elif not order['action'].startswith('build_'):
            planned.append({**order, 'confirmed_output_count': None, 'tracker_evidence': [],
                            'confirmation_kind': 'unconfirmed_exact_command_intent'})
    return planned, unmatched


def _atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.opponent-builds-', suffix='.json', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def extract_opponent_builds(
    manifest_path: str | Path, output_path: str | Path, *, validation_fraction: float = .2,
    seed: int = 1, user_loss_weight: float = 2.0, stratify_outcomes: bool = False,
) -> dict:
    import sc2reader

    if not math.isfinite(user_loss_weight) or user_loss_weight <= 0:
        raise ReplayError('User-loss sampling weight must be positive and finite.')
    manifest_path = Path(manifest_path)
    raw_manifest = manifest_path.read_bytes()
    manifest = json.loads(raw_manifest)
    entries = manifest['replays']
    replay_ids = np.asarray([entry['replay_id'] for entry in entries])
    if len(set(replay_ids)) != len(replay_ids):
        raise ReplayError('Opponent build manifest must contain unique original replay hashes.')
    strata = {entry['replay_id']: entry['matchup'] for entry in entries}
    if stratify_outcomes:
        normalized_results = {'Victory': 'Win', 'Defeat': 'Loss', 'Win': 'Win', 'Loss': 'Loss'}
        if any(entry.get('result') not in normalized_results for entry in entries):
            raise ReplayError('Outcome stratification requires a declared original result for every replay.')
        strata = {entry['replay_id']: entry['matchup'] + '|' + normalized_results[entry['result']]
                  for entry in entries}
    train_indices, validation_indices = grouped_split(replay_ids, validation_fraction, seed, strata=strata)
    validation_ids = set(replay_ids[validation_indices].tolist())
    result = {
        'format_version': 1, 'source_manifest': str(manifest_path.resolve()),
        'source_manifest_sha256': hashlib.sha256(raw_manifest).hexdigest(),
        'timing': 'Exact original command game_loop / 22.4 Faster seconds; command intents are not success claims.',
        'decoder': {'library': 'sc2reader', 'version': sc2reader.__version__,
                    'ability_mapping_caveat': 'Library selects its legacy LotV ability table; explicit race whitelist used. Only construction is tracker-corroborated; production/morph/research remain unconfirmed intents.'},
        'teacher_deduplication': {'method': 'Construction only: nearest preceding supported building command within180s and2 tiles of UnitInit, after addon parent-center offset. Other exact command attempts are retained unconfirmed.',
                                 'limitation': 'Construction correspondence is not proof of individual command causality. Births, morph type-changes and upgrades are not matched to production/research commands; no build-time or queue-success claims are inferred.'},
        'sampler': {'user_loss_weight': user_loss_weight, 'user_win_weight': 1.0,
                    'weights_apply_to': 'Opponent training build selection only; held-out metrics must remain unweighted.'},
        'protoss_split': {'strategy': ('whole_replay_stratified_by_matchup_and_outcome' if stratify_outcomes else 'whole_replay_stratified_by_matchup'), 'seed': seed,
                          'stratify_outcomes': stratify_outcomes,
                          'validation_fraction': validation_fraction,
                          'train_replay_ids': sorted(replay_ids[train_indices].tolist()),
                          'validation_replay_ids': sorted(validation_ids)},
        'partitions': {'train': [], 'validation': []}, 'omitted_matchups': Counter(),
    }
    for entry in entries:
        path = Path(entry['path'])
        info = inspect_replay(path)
        if info['replay_id'] != entry['replay_id'] or info['replay_id'] != entry.get('sha256', info['replay_id']):
            raise ReplayError('Original replay SHA256 differs from the frozen build-order manifest.')
        selected = select_player(info, player_name=manifest['player_name'])
        expected_result = {'Victory': 'Win', 'Defeat': 'Loss', 'Win': 'Win', 'Loss': 'Loss'}.get(entry.get('result'))
        if selected['result'] != expected_result:
            raise ReplayError('Actual selected-player result disagrees with the frozen split manifest.')
        if len(info['players']) != 2 or info['game_speed'] != 'Faster' or selected['starting_workers'] != 8:
            raise ReplayError('Build orders require an exact two-player eight-worker Faster replay.')
        opponent = next(player for player in info['players'] if player['player_id'] != selected['player_id'])
        if opponent['starting_workers'] != 8:
            raise ReplayError('Opponent does not start with eight workers.')
        matchup = 'Pv' + {'Terran': 'T', 'Protoss': 'P', 'Zerg': 'Z'}.get(opponent['race'], '?')
        if matchup != entry['matchup']:
            raise ReplayError('Original opponent race disagrees with the frozen manifest.')
        if opponent['race'] == 'Protoss':
            result['omitted_matchups']['PvP'] += 1
            continue
        if selected['result'] not in ('Win', 'Loss') or opponent['result'] != {'Win': 'Loss', 'Loss': 'Win'}[selected['result']]:
            raise ReplayError('Ambiguous player/opponent result; cannot safely weight this build.')
        replay = sc2reader.load_replay(str(path), load_level=4)
        if int(replay.base_build) != info['base_build']:
            raise ReplayError('Replay decoders disagree on the base build.')
        identities = [player for player in replay.players if player.pid == opponent['player_id']
                      and player.name.casefold() == opponent['name'].casefold() and player.play_race == opponent['race']]
        if len(identities) != 1:
            raise ReplayError('Command decoder opponent identity disagrees with archive metadata.')
        decoded_opponent = identities[0]
        raw_orders, orders, cancellations, unsupported = [], [], [], Counter()
        unresolved = ignored = 0
        for event_index, event in enumerate(replay.game_events):
            if getattr(event, 'player', None) is not decoded_opponent or not getattr(event, 'has_ability', False):
                continue
            name = event.ability_name
            if not name:
                unresolved += 1
                continue
            if not name.startswith(('Build', 'Train', 'Morph', 'Research', 'Upgrade', 'Evolve', 'Cancel')):
                ignored += 1
                continue
            action = command_action(name, opponent['race'])
            order = {'action': action, 'game_loop': event.frame, 'game_seconds': event.frame / 22.4,
                     'source_event_type': event.name, 'source_ability_name': name,
                     'ability_link': event.ability_link, 'command_index': event.command_index,
                     'source_event_index': event_index, 'command_flags': event.flags,
                     'decoded_command_flags': event.flag,
                     'target_point': [event.x, event.y] if hasattr(event, 'x') and hasattr(event, 'y') else None}
            raw_orders.append(order)
            if name.startswith('Cancel'):
                cancellations.append(order)
            elif action:
                orders.append(order)
            else:
                unsupported[name] += 1
        evidence = tracker_evidence(path, opponent['player_id'], opponent['race'])
        teacher_orders, unmatched = teacher_orders_from_intents(orders, evidence)
        if not teacher_orders:
            raise ReplayError(f'No supported tracker-corresponding teacher commands for {path.name}.')
        partition = 'validation' if info['replay_id'] in validation_ids else 'train'
        record = {
            'race': opponent['race'], 'replay_id': info['replay_id'], 'path': str(path.resolve()),
            'map_name': info['map_name'], 'date': entry.get('date'), 'game_version': info['game_version'],
            'base_build': info['base_build'], 'opponent_player_id': opponent['player_id'],
            'opponent_name': opponent['name'], 'user_player_id': selected['player_id'],
            'user_result': selected['result'], 'opponent_result': opponent['result'],
            'bootstrap_weight': user_loss_weight if selected['result'] == 'Loss' else 1.0,
            'weight_reason': 'User lost to this opponent build.' if selected['result'] == 'Loss' else 'User won; retain opponent-build variety.',
            'decoder_ability_table': str(replay.datapack.id), 'raw_orders': raw_orders, 'orders': orders,
            'teacher_orders': teacher_orders, 'unsupported_command_counts': dict(unsupported),
            'cancellation_intents': cancellations, 'tracker_outputs': evidence,
            'unresolved_ability_commands': unresolved, 'ignored_non_build_commands': ignored,
            'unmatched_construction_inits': unmatched,
            'observed_output_counts': dict(Counter(event['action'] for event in evidence)),
            'omitted_uncorroborated_construction_intents': len(orders) - len(teacher_orders),
            'unconfirmed_teacher_attempts': sum(order['confirmation_kind'] == 'unconfirmed_exact_command_intent'
                                                for order in teacher_orders),
        }
        result['partitions'][partition].append(record)
    result['omitted_matchups'] = dict(result['omitted_matchups'])
    result['summary'] = {partition: {race: {
        'replays': sum(record['race'] == race for record in records),
        'supported_command_intents': sum(len(record['orders']) for record in records if record['race'] == race),
        'teacher_orders': sum(len(record['teacher_orders']) for record in records if record['race'] == race),
    } for race in ('Terran', 'Zerg')} for partition, records in result['partitions'].items()}
    _atomic_json(Path(output_path), result)
    return result


def load_build_orders(path: str | Path, race: str, *, partition: str = 'train') -> list[dict]:
    """Explicit partition access prevents accidentally using held-out builds as teachers."""
    get_spec(race)
    if partition not in ('train', 'validation'):
        raise ReplayError('Build partition must be train or validation.')
    data = json.loads(Path(path).read_text(encoding='utf-8'))
    if data.get('format_version') != 1:
        raise ReplayError('Unsupported opponent build-order artifact format.')
    split = data['protoss_split']
    if set(split['train_replay_ids']) & set(split['validation_replay_ids']):
        raise ReplayError('Opponent build artifact leaks replays across train and validation.')
    expected_ids = set(split['train_replay_ids' if partition == 'train' else 'validation_replay_ids'])
    records = data['partitions'][partition]
    if any(record['replay_id'] not in expected_ids for record in records):
        raise ReplayError('Opponent build is stored in the wrong replay partition.')
    if len({record['replay_id'] for record in records}) != len(records):
        raise ReplayError('Duplicate opponent builds would silently change sampling weights.')
    for record in records:
        spec = get_spec(record['race'])
        weight = record.get('bootstrap_weight')
        if isinstance(weight, bool) or not isinstance(weight, (int, float)) or not math.isfinite(weight) or weight <= 0:
            raise ReplayError('Opponent build has an invalid sampling weight.')
        previous = -1
        for order in record['teacher_orders']:
            loop = order.get('game_loop')
            if (order.get('action') not in spec.action_names or type(loop) is not int or loop < previous
                    or not math.isclose(order.get('game_seconds', -1), loop / 22.4)):
                raise ReplayError('Opponent teacher order has invalid action or original command timing.')
            previous = loop
    return [{**record, 'partition': partition, 'command_intents': record.get('orders', []),
             'orders': record['teacher_orders'],
             'orders_source': 'construction_deduplicated_schedule_with_unconfirmed_production_research_intents'}
            for record in records if record['race'] == race]
