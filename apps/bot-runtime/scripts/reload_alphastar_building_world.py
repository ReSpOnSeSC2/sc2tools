"""Independent observation-only reload of a completed world-only diagnostic."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'src'))


def require(value, message):
    if not value:
        raise ValueError(message)


def run(args):
    os.environ.setdefault('XLA_PYTHON_CLIENT_PREALLOCATE', 'false')
    os.environ.setdefault('OMP_NUM_THREADS', '4')
    from scripts.infer_alphastar_checkpoint import read_checkpoint_artifacts, structured_prediction, verify_tree_schema
    from scripts.train_alphastar_replay import DEFAULT_UPSTREAM, train_rows, sha256, verify_upstream
    from scripts.preflight_alphastar_curriculum import identity, host_path
    from scripts.fit_alphastar_balanced import RunGuard, verify_adam_count
    from scripts.fit_alphastar_building_world import WORLD_MODULES, PARENT_SHA256, PARENT_UPDATES
    from scripts.alphastar_capacity_bridge import configure_capacity_runtime
    from scripts.alphastar_building_placement_bridge_v1 import build_placement_bridge, WORLD_INPUT, CLASSES_INPUT
    from scripts.alphastar_eligibility_bridge_v2 import FUNCTION_INPUT, SOURCES_INPUT
    from pluto_sc2.action_eligibility_v2 import build_action_eligibility
    from pluto_sc2.building_placement_v1 import build_placement_masks
    from pluto_sc2.alphastar_tensor import tensorize_observation

    output, candidate, origin, dataset = [Path(value).resolve() for value in
                                        (args.output, args.candidate, args.parent, args.dataset)]
    guard = RunGuard(600, [ROOT / 'STOP', candidate / 'STOP', output / 'STOP', dataset / 'STOP', origin / 'STOP'])
    guard.check('reload setup')
    require(not output.exists(), 'Require new immutable reload output')
    result = json.loads((candidate / 'result.json').read_text())
    require(result['schema'] == 'alphastar-building-world-candidate-v1'
            and result.get('checkpoint_restore_verified') and 0 < result['new_optimizer_updates'] <= 256,
            'Candidate checkpoint not completed')
    require(result['checkpoint_parent_sha256'] == PARENT_SHA256, 'Wrong parent')
    evaluations = [item for item in result['evaluations'] if item['new_updates'] == result['new_optimizer_updates']]
    require(evaluations, 'No complete matching evaluation of saved checkpoint')
    expected = {(r['replay_id'], r['player_id'], r['action_ordinal']): r for r in evaluations[-1]['events']}
    require(len(expected) == 1201, 'Matching evaluation incomplete')
    hashes = {str(host_path(path)): digest for path, digest in result['source_and_input_hashes'].items()}
    for path in (Path(__file__).resolve(), candidate / 'result.json', candidate / 'checkpoint.msgpack'):
        hashes[str(path)] = sha256(path)
    require(hashes[str(candidate / 'checkpoint.msgpack')] == result['checkpoint_sha256'], 'Candidate bytes changed')
    require(all(sha256(path) == digest for path, digest in hashes.items()), 'Candidate provenance changed')
    artifacts = read_checkpoint_artifacts(origin, dataset / 'game-data.json')
    require(artifacts['checkpoint_sha256'] == PARENT_SHA256, 'Parent bytes changed')
    verify_upstream(DEFAULT_UPSTREAM)
    sys.path.insert(0, str(DEFAULT_UPSTREAM))
    import jax
    import jax.numpy as jnp
    import haiku as hk
    from flax import serialization
    from alphastar import types
    configure_capacity_runtime(artifacts['result'])
    candidate_bytes = (candidate / 'checkpoint.msgpack').read_bytes()
    parent_bytes = artifacts['checkpoint'].read_bytes()
    require(hashlib.sha256(candidate_bytes).hexdigest() == result['checkpoint_sha256'], 'Candidate changed before decode')
    require(hashlib.sha256(parent_bytes).hexdigest() == PARENT_SHA256, 'Parent changed before decode')
    decoded = serialization.msgpack_restore(candidate_bytes)
    parent = serialization.msgpack_restore(parent_bytes)
    verify_adam_count(decoded, PARENT_UPDATES + result['new_optimizer_updates'])
    verify_tree_schema(parent['params'], decoded['params'], 'params')
    for name in ('mu', 'nu'):
        verify_tree_schema(parent['params'], decoded['optimizer_state']['0'][name], 'Adam/' + name)
    for numerical_tree in (decoded['params'], decoded['optimizer_state']['0']['mu'], decoded['optimizer_state']['0']['nu']):
        require(all(np.all(np.isfinite(leaf)) for leaves in numerical_tree.values() for leaf in leaves.values()),
                'Nonfinite checkpoint parameters or moments')
    checked = 0
    for tree_name in ('params', 'mu', 'nu'):
        left = parent['params'] if tree_name == 'params' else parent['optimizer_state']['0'][tree_name]
        right = decoded['params'] if tree_name == 'params' else decoded['optimizer_state']['0'][tree_name]
        for module, leaves in left.items():
            if module in WORLD_MODULES:
                continue
            for name, value in leaves.items():
                a, b = np.asarray(value), np.asarray(right[module][name])
                require(a.dtype == b.dtype and a.shape == b.shape and a.tobytes() == b.tobytes(), 'Frozen state differs')
                checked += 1
    require(decoded['network_state'] == parent['network_state'] == {}, 'Network state changed')
    rows = {identity(row): row for row in train_rows(dataset) if identity(row) in expected}
    selected = []
    for identities in (result['retention_groups']['building_world'], result['original_anchor_identities'],
                       result['retention_groups']['attack_world'], list(rows)):
        for row_id in identities:
            row_id = tuple(row_id)
            if row_id not in selected and len(selected) < 64:
                selected.append(row_id)
    registry, config = artifacts['registry'], artifacts['config']

    def encode(row):
        encoded = tensorize_observation(row['frame'], registry, artifacts['unit_types'], config)
        eligibility = build_action_eligibility(row['frame'], encoded['metadata']['entity_tags'], registry,
                                               artifacts['catalog'], max_entities=config.max_entities)
        placement = build_placement_masks(row['frame'], registry, artifacts['catalog'])
        encoded['inputs'].update({FUNCTION_INPUT: np.asarray(eligibility['function_mask'], bool),
            SOURCES_INPUT: np.asarray(eligibility['source_masks'], bool),
            WORLD_INPUT: np.asarray(placement['masks'], bool).reshape(3, config.world_size**2),
            CLASSES_INPUT: np.asarray(placement['function_classes'], np.int32)})
        return encoded

    component, _ = build_placement_bridge(encode(rows[selected[0]]), config, registry,
                                          is_training=False, sampling_mode='greedy')
    require(not any(isinstance(name, tuple) and name[0] == 'behaviour_features'
                    for name in component.input_spec), 'Inference asks for expert labels')
    network = hk.transform_with_state(jax.vmap(component.unroll))
    forward = jax.jit(network.apply)
    parameters = jax.tree_util.tree_map(jnp.asarray, decoded['params'])
    previous = jax.tree_util.tree_map(lambda spec: jnp.zeros((1,) + spec.shape, spec.dtype), component.prev_state_spec)
    events = []
    for row_id in selected:
        guard.check('independent observation-only reload')
        encoded = encode(rows[row_id])
        inputs = types.StreamDict()
        for name, spec in component.input_spec.items():
            spec.validate(encoded['inputs'][name])
            inputs[name] = jnp.asarray(encoded['inputs'][name])[None, None, ...]
        (prediction, _, _), next_state = forward(parameters, {}, jax.random.PRNGKey(42), inputs, previous)
        prediction = structured_prediction(jax.device_get(prediction), registry, config)
        require(next_state == {} and prediction['mask_checks_passed'], 'Reload state/mask failure')
        require(prediction['prediction'] == expected[row_id]['prediction'], 'Independent prediction differs')
        events.append({'identity': row_id, 'prediction': prediction['prediction'], 'exact': True})
    require(all(sha256(path) == digest for path, digest in hashes.items()), 'Provenance changed during reload')
    report = {'schema': 'building-world-independent-reload-v1', 'status': 'passed',
        'checkpoint_sha256': result['checkpoint_sha256'], 'optimizer_count': decoded['optimizer_updates'],
        'new_optimizer_updates': 0, 'game_launches': 0, 'source_inputs_unchanged': True,
        'frozen_numerical_leaves_bitwise_verified': checked, 'source_and_input_hashes': hashes,
        'frames': len(events), 'exact_predictions': len(events),
        'coverage': {name: len(set(selected) & {tuple(value) for value in values}) for name, values in
                     {**result['retention_groups'], 'original_anchors': result['original_anchor_identities']}.items()},
        'events': events}
    output.mkdir(parents=True, exist_ok=False)
    (output / 'reload.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({key: report[key] for key in ('status', 'frames', 'exact_predictions', 'optimizer_count')}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('candidate', 'parent', 'dataset', 'output'):
        parser.add_argument('--' + name, required=True)
    run(parser.parse_args())
