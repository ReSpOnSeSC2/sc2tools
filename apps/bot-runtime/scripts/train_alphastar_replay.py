"""Bounded, train-only imitation diagnostic using official AlphaStar modules.

Run in the pinned isolated Linux runtime. Never launches a game or executes raw
actions. The official source remains unmodified. Versioned adaptations: omitted
unavailable scalar conditioning/previous-action inputs, knownness projections,
and planned-construction intent masks requiring the separate paid-UI decoder.
Official components are Apache-2.0, google-deepmind/alphastar at PINNED_COMMIT.
"""
from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import asdict
import gzip
import hashlib
import json
import os
from pathlib import Path
import random
import shutil
import sys
import time
import traceback

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from pluto_sc2.alphastar_tensor import (  # noqa: E402
    DISABLED_HEADS, HEADS, MINIMAP_MAX, PLAYER_FIELDS, TensorConfig, TensorError,
    tensorize_sample, validate_supervised_masks,
)

PINNED_COMMIT = "700b1e74364ed5dfc66f6cd2574c5ffac2fa474e"
DEFAULT_UPSTREAM = ROOT / "runs/alphastar-foundation-v1/runtime-setup/alphastar-workcopy"
OPENING_ABILITIES = (1006, 881, 883, 880, 882, 894, 3755, 917)


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_dataset(directory):
    """Validate all partition identities and immutable payload hashes first."""
    directory = Path(directory)
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    if (manifest.get("schema") != "alphastar-intent-dataset-v1"
            or manifest.get("status") != "complete"
            or manifest.get("eligible_for_training") is not True
            or manifest.get("training_scope") != "bounded_imitation_diagnostic"):
        raise TensorError("Dataset has not passed the explicit bounded-imitation gate")
    hashes = {"samples": sha256(directory / "samples.jsonl.gz"),
              "game_data": sha256(directory / "game-data.json"),
              "manifest": sha256(directory / "manifest.json")}
    for name in ("samples", "game_data"):
        if manifest.get(name + "_sha256") != hashes[name]:
            raise TensorError(f"Dataset {name} hash mismatch")
    partitions = manifest.get("replay_partitions", {})
    if not partitions or any(v not in ("train", "validation") for v in partitions.values()):
        raise TensorError("Missing whole-replay partitions")
    if not isinstance(manifest.get("split_sha256"), str) or len(manifest["split_sha256"]) != 64:
        raise TensorError("Missing pinned whole-replay split hash")
    counts, seen = Counter(), set()
    with gzip.open(directory / "samples.jsonl.gz", "rt", encoding="utf-8") as stream:
        for line in stream:
            sample = json.loads(line)
            if type(sample.get("player_id")) is not int or sample["player_id"] not in (1, 2):
                raise TensorError("Missing replay player perspective")
            identity = (sample["replay_id"], sample["player_id"], sample["action_ordinal"])
            if identity in seen:
                raise TensorError("Duplicate expert action")
            seen.add(identity)
            if sample.get("partition") != partitions.get(sample["replay_id"]):
                raise TensorError("Replay partition mismatch or collision")
            if sample["frame"].get("game_loop") != sample["preceding_loop"] or not (
                    0 <= sample["preceding_loop"] < sample["action_loop"]):
                raise TensorError("Non-causal dataset sample")
            if sample["intent"].get("admitted") is not True:
                raise TensorError("Unadmitted intent in samples")
            counts[sample["partition"]] += 1
    if sum(counts.values()) != manifest.get("counts", {}).get("samples"):
        raise TensorError("Manifest sample count mismatch")
    if not counts["train"]:
        raise TensorError("No train samples; validation cannot train the model")
    return manifest, json.loads((directory / "game-data.json").read_text(encoding="utf-8")), hashes, counts


def train_rows(directory):
    with gzip.open(Path(directory) / "samples.jsonl.gz", "rt", encoding="utf-8") as stream:
        for line in stream:
            sample = json.loads(line)
            if sample["partition"] == "train":
                yield sample


def select_diagnostic_examples(critical, by_function, reservoir, maximum):
    """Opening dependencies and camera first; no alphabetic cancellation bias."""
    required = []
    for ability in OPENING_ABILITIES:
        required.extend(example for example in by_function.values()
                        if example["metadata"]["function"]["ability_id"] == ability)
    required.extend(example for name, example in by_function.items() if name == "raw_move_camera")
    required.extend(critical)

    def identity(example):
        meta = example["metadata"]
        return meta["replay_id"], meta["player_id"], meta["action_ordinal"]

    if len({identity(example) for example in required}) > maximum:
        raise TensorError("Increase max-samples to cover opening, camera and every admitted gas/Core event")
    selected, seen = [], set()
    optional = [by_function[name] for name in sorted(by_function)]
    for example in required + optional + reservoir:
        key = identity(example)
        if key not in seen and len(selected) < maximum:
            selected.append(example)
            seen.add(key)
    return selected


def teacher_forced_metrics(outputs, example):
    """Metrics on recorded prefixes; these are not free-running action accuracy."""
    validate_supervised_masks(outputs, example)
    values = {}
    for name, active in example["active_heads"].items():
        if not active:
            continue
        label = example["labels"][name]
        logits = np.asarray(outputs["logits", name])
        if name == "unit_tags":
            logits = logits.reshape(len(label), -1)
            predicted = logits.argmax(axis=-1)
            eos = logits.shape[-1] - 1
            source_mask = label != eos
            values["source_token_accuracy"] = float(np.mean(predicted[source_mask] == label[source_mask]))
            values["source_set_exact"] = float(set(predicted[predicted != eos]) == set(label[source_mask]))
            values["source_sequence_exact"] = float(np.array_equal(predicted[source_mask], label[source_mask]))
        else:
            predicted = int(logits.reshape(-1).argmax())
            values[name + "_accuracy"] = float(predicted == int(label))
            if name == "world":
                size = int(np.sqrt(logits.shape[-1]))
                wanted = int(label)
                values["world_grid_error"] = float(np.hypot(predicted % size - wanted % size,
                                                             predicted // size - wanted // size))
    return {"replay_id": example["metadata"]["replay_id"], "player_id": example["metadata"]["player_id"],
            "action_ordinal": example["metadata"]["action_ordinal"],
            "function": example["metadata"]["function"]["name"], "metrics": values}


def aggregate_metrics(records):
    keys = sorted({name for record in records for name in record["metrics"]})
    return {name: {"mean": float(np.mean([record["metrics"][name] for record in records
                                         if name in record["metrics"]])),
                   "events": sum(name in record["metrics"] for record in records)} for name in keys}


def verify_upstream(path):
    manifest_path = DEFAULT_UPSTREAM.parent / "upstream-source-manifest.json"
    source = json.loads(manifest_path.read_text(encoding="utf-8"))
    # The setup audit stores a file-hash mapping, independently of repository git state.
    entries = source.get("files", source)
    if isinstance(entries, list):
        entries = {entry["path"]: entry["sha256"] for entry in entries}
    for name, expected in entries.items():
        if not isinstance(expected, str) or len(expected) != 64:
            raise TensorError("Unsupported upstream source manifest")
        candidate = (Path(path) / name).resolve()
        if Path(path).resolve() not in candidate.parents or sha256(candidate) != expected:
            raise TensorError(f"Official source differs: {name}")
    return sha256(manifest_path), len(entries)


def runtime_registry(catalog):
    from pysc2.lib import actions
    from pysc2.env.converter.cc.game_data.python import uint8_lookup
    from alphastar.architectures.components.static_data import camera_masks
    from pluto_sc2.rich_intents import is_assisted_build
    camera_only = camera_masks.get_on_camera_only_functions_pt()
    registry = [dict(id=int(f.id), name=f.name, ability_id=f.ability_id,
                     general_id=f.general_id, args=[a.name for a in f.args],
                     camera_only_pt=bool(camera_only[int(f.id)]),
                     planned_build=(f.name.startswith("Build_") and "world" in [a.name for a in f.args]
                                    and is_assisted_build(f.ability_id,
                                        catalog["abilities"].get(str(f.ability_id), {})))) for f in actions.RAW_FUNCTIONS]
    # Unknown forward lookups FATAL-abort in the native extension rather than
    # raising Python errors. Enumerate its public finite reverse domain instead.
    mapping = {int(uint8_lookup.Uint8ToPySc2(index)): index
               for index in range(1, int(uint8_lookup.MaximumUnitTypeId()) + 1)}
    return registry, mapping


def inactive_source_logits(logits, masks, active, *, array_api=np):
    """Use only EOS for functions with no source argument; retain active masks."""
    eos_only = array_api.arange(logits.shape[-1]) == logits.shape[-1] - 1
    return (array_api.where(active, logits, array_api.where(eos_only, array_api.float32(0),
                                                           array_api.float32(-1e10))),
            array_api.where(active, masks, eos_only))


def build_official_bridge(example, config, registry, *, is_training=True, sampling_mode="sample"):
    """One checkpoint-compatible graph for teacher forcing or real inference.

    Inference receives observation tensors only. Official sampling feeds each
    predicted prefix into the following heads. Unsupported delay/repeat actions
    are fixed to their training value zero; their learned modules and parameter
    paths remain present. No expert function, source, or target is substituted.
    """
    if type(is_training) is not bool or sampling_mode not in ("sample", "greedy"):
        raise TensorError("Invalid official bridge execution mode")
    if is_training and sampling_mode != "sample":
        raise TensorError("Sampling mode applies only to label-free inference")
    import haiku as hk
    import jax.numpy as jnp
    from dm_env import specs
    from alphastar import types
    from alphastar.architectures import modular
    from alphastar.architectures.components import common, merge, vector, units, visual
    from alphastar.architectures.standard import encoders, torso, heads
    from alphastar.architectures.standard.configs import lite
    from alphastar.commons import sample as sampling

    obs_spec = types.SpecDict()
    for key, value in example["inputs"].items():
        if key[0] == "observation":
            obs_spec[key[1]] = specs.Array(value.shape, value.dtype)
    for name, maximum in MINIMAP_MAX.items():
        obs_spec["minimap_" + name] = specs.BoundedArray(
            (config.minimap_size, config.minimap_size), np.uint8, minimum=0, maximum=maximum)
    action_spec = types.SpecDict()
    for name, maximum, shape in (("function", len(registry) - 1, ()), ("delay", 1, ()),
                                 ("queued", 1, ()), ("repeat", 1, ()),
                                 ("unit_tags", config.max_entities, (config.max_selected,)),
                                 ("target_unit_tag", config.max_entities - 1, ()),
                                 ("world", config.world_size**2 - 1, ())):
        action_spec[name] = specs.BoundedArray(shape, np.int32, 0, maximum)
    cfg = lite.get_config()
    cfg.encoders.units.raw_units.num_unit_types = 256
    if not is_training:
        if sampling_mode == "greedy":
            for name in ("function", "queued", "target_unit_tag", "world"):
                cfg.heads[name].sampling.sample.sample_fn = lambda logits: jnp.argmax(logits).astype(jnp.int32)
            cfg.heads.unit_tags.inner_component.sampling.sample.sample_fn = (
                lambda logits: jnp.argmax(logits).astype(jnp.int32))
        for name in DISABLED_HEADS:
            cfg.heads[name].sampling.sample.sample_fn = lambda logits: jnp.asarray(0, dtype=jnp.int32)

    class KnowledgeAdapter(modular.BatchedComponent):
        @property
        def input_spec(self):
            return types.SpecDict({
                "units_stream": specs.Array((config.max_entities, cfg.units_stream_size), np.float32),
                "vector_stream": specs.Array((cfg.vector_stream_size,), np.float32),
                ("observation", "raw_knownness"): obs_spec["raw_knownness"],
                ("observation", "memory_status"): obs_spec["memory_status"],
                ("observation", "player_knownness"): obs_spec["player_knownness"],
                "non_empty_units": specs.Array((config.max_entities,), np.bool_)})

        @property
        def output_spec(self):
            return types.SpecDict({"units_stream": self.input_spec["units_stream"],
                                   "vector_stream": self.input_spec["vector_stream"]})

        def _forward(self, inputs):
            knowledge = jnp.concatenate([inputs["observation", "raw_knownness"],
                                         inputs["observation", "memory_status"]], axis=-1)
            added = hk.Linear(cfg.units_stream_size, name="unit_knownness")(knowledge)
            units_stream = inputs["units_stream"] + added * inputs["non_empty_units"][:, None]
            vector_stream = inputs["vector_stream"] + hk.Linear(cfg.vector_stream_size, name="hud_knownness")(
                inputs["observation", "player_knownness"])
            return types.StreamDict({"units_stream": units_stream, "vector_stream": vector_stream}), {}

    planned_functions = jnp.asarray([row["planned_build"] for row in registry])
    gas_functions = jnp.asarray([row["name"] == "Build_Assimilator_unit" for row in registry])
    camera_only_functions = jnp.asarray([row["camera_only_pt"] for row in registry])

    class IntentMask(modular.BatchedComponent):
        def __init__(self, argument):
            super().__init__(name="intent_mask_" + argument)
            self.argument = argument
            self.size = config.world_size**2 if argument == "world" else config.max_entities

        @property
        def input_spec(self):
            result = types.SpecDict({("logits", self.argument): specs.Array((self.size,), np.float32),
                                     ("action", "function"): specs.Array((), np.int32)})
            names = ("camera", "planned_build_mask") if self.argument == "world" else (
                "current_target_mask", "known_geyser_mask")
            for name in names:
                result["observation", name] = obs_spec[name]
            return result

        @property
        def output_spec(self):
            return types.SpecDict({("logits", self.argument): specs.Array((self.size,), np.float32),
                                   ("masks", self.argument): specs.Array((self.size,), np.bool_)})

        def _forward(self, inputs):
            function = inputs["action", "function"]
            if self.argument == "world":
                actual_camera = inputs["observation", "camera"].astype(jnp.bool_)
                original = jnp.logical_or(actual_camera, jnp.logical_not(camera_only_functions[function]))
                planned = inputs["observation", "planned_build_mask"]
                mask = jnp.where(planned_functions[function], jnp.logical_or(actual_camera, planned), original)
                mask = mask.reshape(-1)
            else:
                mask = jnp.logical_or(inputs["observation", "current_target_mask"],
                    gas_functions[function] & inputs["observation", "known_geyser_mask"])
            return types.StreamDict({("masks", self.argument): mask,
                                     ("logits", self.argument): sampling.mask_logits(
                                         inputs["logits", self.argument], mask)}), {}

    class UnmaskedWorld(visual.Logits):
        """Calculate official logits first; the following IntentMask is mandatory.

        The local all-ones argument disables only this layer's stock logit mask.
        It never changes camera encoding, observations, or actual UI permissions.
        """
        def _forward(self, inputs):
            local = inputs.copy()
            local["observation", "camera"] = jnp.ones_like(inputs["observation", "camera"])
            return super()._forward(local)

    class InactiveSourceMask(modular.BatchedComponent):
        """Camera/no-source functions must condition later heads on empty selection.

        Stock source sampling insists on selecting one unit before EOS. Our
        teacher-forced no-source examples contain only EOS, and their source
        loss is disabled by ArgumentMasks. Reproduce that explicit empty prefix
        during inference without inventing a source or changing any parameters.
        """
        @property
        def input_spec(self):
            return types.SpecDict({("logits", "unit_tags"): specs.Array((config.max_entities + 1,), np.float32),
                                   ("masks", "unit_tags"): specs.Array((config.max_entities + 1,), np.bool_),
                                   ("argument_masks", "unit_tags"): specs.Array((), np.bool_)})

        @property
        def output_spec(self):
            return types.SpecDict({key: spec for key, spec in self.input_spec.items()
                                   if key[0] != "argument_masks"})

        def _forward(self, inputs):
            active = inputs["argument_masks", "unit_tags"]
            logits, mask = inactive_source_logits(inputs["logits", "unit_tags"],
                                                   inputs["masks", "unit_tags"], active, array_api=jnp)
            return types.StreamDict({("logits", "unit_tags"): logits, ("masks", "unit_tags"): mask}), {}

    component = modular.SequentialComponent(name="official_lite_rich_intent_v1")
    component.append(vector.ClockFeatureEncoder(name="game_loop", input_name=("observation", "game_loop"),
        output_name="clock_embedding", output_size=cfg.vector_stream_size, **cfg.encoders.vector.game_loop))
    for name, size, setting in (("player", len(PLAYER_FIELDS), cfg.encoders.vector.player),
                                ("unit_counts_bow", 256, cfg.encoders.vector.unit_counts_bow)):
        component.append(vector.VectorEncoder(name=name, input_name=("observation", name),
            output_name=name + "_embedding", num_features=size, output_size=cfg.vector_stream_size, **setting))
    component.append(merge.SumMerge(name="observed_vector_merge",
        input_names=["clock_embedding", "player_embedding", "unit_counts_bow_embedding"],
        output_name="vector_stream", stream_shape=(cfg.vector_stream_size,)))
    component.append(encoders.get_units_encoder(obs_spec, action_spec, cfg.units_stream_size, cfg.encoders.units))
    component.append(KnowledgeAdapter(name="knowledge_adapter_v1"))
    component.append(encoders.get_visual_encoder(obs_spec, action_spec, cfg.visual_stream_sizes[0], cfg.encoders.visual))
    component.append(torso.get_torso(obs_spec, action_spec, cfg.vector_stream_size, cfg.units_stream_size,
                                     cfg.visual_stream_sizes, cfg.torso))
    for name in ("function", "delay", "queued", "repeat"):
        component.append(heads.get_vector_head(name, action_spec, cfg.vector_stream_size,
                                               is_training, 0, cfg.heads[name]))
    source_head = heads.get_unit_tags_head(obs_spec, action_spec, cfg.vector_stream_size,
                                           cfg.units_stream_size, is_training, cfg.heads.unit_tags)
    if not is_training:
        for recurrent in source_head._components:
            if isinstance(recurrent, units.UnitTagsHead):
                inner = modular.SequentialComponent(name=recurrent._inner_component.name)
                for part in recurrent._inner_component._components:
                    if isinstance(part, common.Sample):
                        inner.append(InactiveSourceMask(name="inactive_source_mask"))
                    inner.append(part)
                recurrent._inner_component = inner
                recurrent._constant_inputs = list(recurrent._constant_inputs) + [("argument_masks", "unit_tags")]
        # SequentialComponent caches dependencies at append time. Rebuild its
        # cached spec after adding the function mask to the recurrent inputs.
        adapted_source = modular.SequentialComponent(name=source_head.name)
        for part in source_head._components:
            adapted_source.append(part)
        source_head = adapted_source
    component.append(source_head)
    target_head = heads.get_target_unit_tag_head(obs_spec, action_spec, cfg.vector_stream_size,
                                               cfg.units_stream_size, is_training, cfg.heads.target_unit_tag)
    adapted_target = modular.SequentialComponent(name="target_unit_tag_head")
    for part in target_head._components:
        if isinstance(part, units.PointerLogits):
            # Real pointer scores remain unmasked until the stricter causal intent mask.
            part._unit_tags_masking = units.UnitTagsMasking.TARGETABLE
        adapted_target.append(part)
        if isinstance(part, units.PointerLogits):
            adapted_target.append(IntentMask("target_unit_tag"))
    component.append(adapted_target)
    world_head = heads.get_world_head(obs_spec, action_spec, cfg.vector_stream_size,
                                     cfg.visual_stream_sizes, is_training, cfg.heads.world)
    adapted_world = modular.SequentialComponent(name="world_head")
    for part in world_head._components:
        if isinstance(part, visual.Logits):
            part.__class__ = UnmaskedWorld  # Fresh per-run instance; no upstream module or file mutation.
        adapted_world.append(part)
        if isinstance(part, UnmaskedWorld):
            adapted_world.append(IntentMask("world"))
    component.append(adapted_world)
    return component, action_spec


def run(args):
    os.environ.setdefault("XLA_PYTHON_CLIENT_PREALLOCATE", "false")
    os.environ.setdefault("OMP_NUM_THREADS", "4")
    os.environ.setdefault("JAX_COMPILATION_CACHE_DIR", str(Path.home() / ".cache/sc2-alphastar-v1/jax"))
    if args.preflight_only:
        os.environ["JAX_PLATFORMS"] = "cpu"
    sys.dont_write_bytecode = True
    output = Path(args.output).resolve()
    if output.exists():
        raise TensorError("Output must be a new directory; checkpoints are immutable")
    output.mkdir(parents=True)
    state = {"schema": "alphastar-real-replay-diagnostic-v1", "status": "running", "pid": os.getpid(),
             "started_unix": time.time(), "optimizer_updates": 0, "checkpoints_written": 0,
             "upstream_commit": PINNED_COMMIT, "live_game_ready": False, "strength_evidence": False,
             "training_scope": "bounded_imitation_diagnostic", "validation_optimizer_updates": 0,
             "disabled_supervision": list(DISABLED_HEADS), "ablated_encoders": ["mmr", "requested_races",
                 "observed_race", "upgrades", "previous_actions", "previous_unit_arguments"],
             "adaptations": ["field_knownness_and_memory_age_v1", "causal_planned_construction_masks_v1"],
             "notes": ["Zero storage for unknown unit/HUD values carries separate knownness embeddings.",
                       "Unit counts describe current camera-visible own units, never unseen global units.",
                       "Assisted construction predictions require paid camera/reacquisition in a separate decoder.",
                       "Training diagnostic does not authorize raw actions or prove a playable policy."]}
    state["compilation_cache"] = os.environ["JAX_COMPILATION_CACHE_DIR"]

    def save():
        (output / "result.json").write_text(json.dumps(state, indent=2, allow_nan=False) + "\n", encoding="utf-8")

    def check_stop():
        for marker in (output / "STOP", Path(args.dataset) / "STOP", DEFAULT_UPSTREAM.parent.parent / "STOP"):
            if marker.exists():
                raise TensorError(f"STOP marker respected: {marker}")

    try:
        check_stop()
        source_hash, source_count = verify_upstream(args.upstream)
        sys.path.insert(0, str(Path(args.upstream).resolve()))
        manifest, catalog, hashes, counts = read_dataset(args.dataset)
        state.update(dataset_hashes=hashes, dataset_counts=dict(counts), split_sha256=manifest["split_sha256"],
                     upstream_manifest_sha256=source_hash, upstream_file_count=source_count,
                     trainer_sha256=sha256(__file__), tensor_bridge_sha256=sha256(ROOT / "src/pluto_sc2/alphastar_tensor.py"))
        state["pid_creation_time"] = __import__("psutil").Process().create_time()
        snapshot = output / "source-snapshot"
        snapshot.mkdir()
        source_hashes = {}
        for filename in (Path(__file__), ROOT / "src/pluto_sc2/alphastar_tensor.py",
                         ROOT / "src/pluto_sc2/rich_intents.py", ROOT / "src/pluto_sc2/rich_actions.py"):
            shutil.copy2(filename, snapshot / filename.name)
            source_hashes[str(filename)] = sha256(filename)
        (snapshot / "manifest.json").write_text(json.dumps(source_hashes, indent=2) + "\n")
        state["source_hashes"] = source_hashes
        registry, mapping = runtime_registry(catalog)
        (output / "registry.json").write_text(json.dumps({"functions": registry, "unit_types": mapping}, indent=2))
        config = TensorConfig(max_entities=args.max_entities, max_selected=args.max_selected)
        state["tensor_config"] = asdict(config)
        examples, exclusions, candidate_count, by_function, critical = [], Counter(), 0, {}, []
        rng = random.Random(args.seed)
        for row in train_rows(args.dataset):
            check_stop()
            try:
                example = tensorize_sample(row, registry, mapping, config)
            except TensorError as exc:
                exclusions[str(exc)] += 1
                if row["intent"].get("ability_id") in (882, 894):
                    raise TensorError(f"Critical opening sample cannot be represented: {exc}") from exc
                continue
            candidate_count += 1
            if row["intent"].get("ability_id") in (882, 894):
                critical.append(example)
            by_function.setdefault(example["metadata"]["function"]["name"], example)
            if len(examples) < args.max_samples:
                examples.append(example)
            else:
                index = rng.randrange(candidate_count)
                if index < len(examples):
                    examples[index] = example
        # Bounded diagnostic coverage includes rare opening dependencies when
        # present, instead of accidentally selecting only frequent camera moves.
        examples = select_diagnostic_examples(critical, by_function, examples, args.max_samples)
        state.update(tensor_candidates=candidate_count, tensor_exclusions=dict(exclusions), selected_samples=len(examples))
        state["sample_selection"] = "all opening abilities and camera, all gas/Core events, optional functions, seeded reservoir"
        if not examples:
            raise TensorError("No faithfully representable training samples")
        save()
        if args.preflight_only:
            component, _ = build_official_bridge(examples[0], config, registry)
            for example in examples:
                for key, spec in component.input_spec.items():
                    spec.validate(example["inputs"][key])
            state.update(status="preflight_passed", model_forward_executed=False,
                         input_shapes={"/".join(key if isinstance(key, tuple) else (key,)): list(spec.shape)
                                       for key, spec in component.input_spec.items()},
                         sample_provenance=[example["metadata"] for example in examples])
            return
        import jax
        import jax.numpy as jnp
        import haiku as hk
        import optax
        from alphastar import types
        from alphastar.unplugged.losses.supervised import Supervised
        state["devices"] = [str(device) for device in jax.devices()]
        if not any(device.platform == "gpu" for device in jax.devices()):
            raise TensorError("Pinned GPU runtime required")
        component, action_spec = build_official_bridge(examples[0], config, registry)
        state["input_shapes"] = {"/".join(key if isinstance(key, tuple) else (key,)): list(spec.shape)
                                 for key, spec in component.input_spec.items()}
        network = hk.transform_with_state(jax.vmap(component.unroll))
        previous = jax.tree_util.tree_map(lambda spec: jnp.zeros((1,) + spec.shape, spec.dtype), component.prev_state_spec)

        def inputs_for(example):
            result = types.StreamDict()
            for key, spec in component.input_spec.items():
                value = example["inputs"][key if isinstance(key, tuple) else key]
                spec.validate(value)
                result[key] = jnp.asarray(value)[None, None, ...]
            return result

        key = jax.random.PRNGKey(args.seed)
        params, network_state = jax.jit(network.init)(key, inputs_for(examples[0]), previous)
        state["parameter_count"] = sum(int(value.size) for value in jax.tree_util.tree_leaves(params))
        apply = jax.jit(network.apply)
        admitted, mask_proofs, baseline_metrics = [], [], []
        for example in examples:
            check_stop()
            (predictions, _, _), _ = apply(params, network_state, key, inputs_for(example), previous)
            try:
                proof = validate_supervised_masks(predictions, example)
            except TensorError as exc:
                state["mask_failure"] = {**example["metadata"], "reason": str(exc)}
                raise
            admitted.append(example)
            mask_proofs.append({**example["metadata"], "verified_unmasked_targets": proof})
            baseline_metrics.append(teacher_forced_metrics(predictions, example))
        state.update(mask_exclusions={}, admitted_samples=len(admitted), mask_proofs=mask_proofs)
        state["teacher_forced_metrics"] = {
            "scope": "same selected TRAIN events with recorded autoregressive prefixes; not validation, free-running accuracy or strength",
            "world_error_units": "256x256 world-grid cells, isotropic public-map transform",
            "baseline": {"summary": aggregate_metrics(baseline_metrics), "events": baseline_metrics}}
        save()
        if not admitted or not any(example["active_heads"]["unit_tags"] for example in admitted):
            raise TensorError("No admitted real unit-command supervision")
        weights = {name: 0. if name in DISABLED_HEADS else 1. for name in HEADS}
        loss = Supervised(action_spec=action_spec, weights=weights, burnin_len=0, overlap_len=0)
        optimizer = optax.adam(args.learning_rate)
        opt_state = optimizer.init(params)

        def objective(parameters, inputs):
            (predictions, _, _), next_state = network.apply(parameters, network_state, key, inputs, previous)
            loss_inputs = predictions.copy()
            loss_inputs["step_type"] = inputs["step_type"]
            values, _ = loss.batched_loss(loss_inputs)
            return jnp.mean(values), (predictions, next_state)

        grad_fn = jax.jit(jax.value_and_grad(objective, has_aux=True))
        state["updates"] = []
        # Round-robin known admitted events; never iterate validation rows or fabricate states.
        for step in range(args.steps):
            check_stop()
            example = admitted[step % len(admitted)]
            (value, (predictions, _)), gradient = grad_fn(params, inputs_for(example))
            check_stop()
            validate_supervised_masks(predictions, example)
            leaves = jax.tree_util.tree_leaves(gradient)
            norm = float(jnp.sqrt(sum(jnp.sum(jnp.square(leaf)) for leaf in leaves)))
            finite = all(bool(jnp.all(jnp.isfinite(leaf))) for leaf in leaves)
            if not finite or not np.isfinite(float(value)) or not np.isfinite(norm) or norm <= 0:
                raise TensorError("Nonfinite or zero real replay gradient; no optimizer update")
            updates, opt_state = optimizer.update(gradient, opt_state, params)
            params = optax.apply_updates(params, updates)
            if not all(bool(jnp.all(jnp.isfinite(leaf))) for leaf in jax.tree_util.tree_leaves(params)):
                raise TensorError("Nonfinite updated parameters")
            state["optimizer_updates"] += 1
            state["updates"].append({"step": step + 1, "loss": float(value), "gradient_l2_norm": norm,
                                     "replay_id": example["metadata"]["replay_id"],
                                     "player_id": example["metadata"]["player_id"],
                                     "action_ordinal": example["metadata"]["action_ordinal"], "partition": "train"})
            save()
            print(json.dumps(state["updates"][-1]), flush=True)
        final_metrics = []
        for example in admitted:
            check_stop()
            (predictions, _, _), _ = apply(params, network_state, key, inputs_for(example), previous)
            final_metrics.append(teacher_forced_metrics(predictions, example))
        state["teacher_forced_metrics"]["final"] = {
            "summary": aggregate_metrics(final_metrics), "events": final_metrics}
        check_stop()
        verify_upstream(args.upstream)
        for name, path in (("samples", Path(args.dataset) / "samples.jsonl.gz"),
                           ("game_data", Path(args.dataset) / "game-data.json"),
                           ("manifest", Path(args.dataset) / "manifest.json")):
            if sha256(path) != hashes[name]:
                raise TensorError(f"Dataset {name} changed during diagnostic")
        if any(sha256(path) != expected for path, expected in source_hashes.items()):
            raise TensorError("Training source changed during diagnostic")
        from flax import serialization
        checkpoint = {"params": jax.device_get(params), "network_state": jax.device_get(network_state),
                      "optimizer_state": jax.device_get(opt_state), "optimizer_updates": state["optimizer_updates"]}
        (output / "checkpoint.msgpack").write_bytes(serialization.to_bytes(checkpoint))
        state.update(checkpoints_written=1, checkpoint_sha256=sha256(output / "checkpoint.msgpack"))
        restored = serialization.from_bytes(checkpoint, (output / "checkpoint.msgpack").read_bytes())
        leaves_before, tree_before = jax.tree_util.tree_flatten(checkpoint)
        leaves_after, tree_after = jax.tree_util.tree_flatten(restored)
        equal = tree_before == tree_after and len(leaves_before) == len(leaves_after)
        for original, recovered in zip(leaves_before, leaves_after):
            original, recovered = np.asarray(original), np.asarray(recovered)
            equal = (equal and original.dtype == recovered.dtype and original.shape == recovered.shape
                     and np.array_equal(original, recovered))
        if not equal:
            raise TensorError("Saved checkpoint did not roundtrip exact parameter/state/optimizer leaves")
        state.update(checkpoint_restore_verified=True, checkpoint_restored_leaf_count=len(leaves_after),
                     status="passed", learned_from_actual_replay=True)
    except BaseException as exc:
        state.update(status="failed", error=f"{type(exc).__name__}: {exc}", traceback=traceback.format_exc())
        raise
    finally:
        state.update(finished_unix=time.time(), wall_seconds=time.time() - state["started_unix"])
        save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--upstream", type=Path, default=DEFAULT_UPSTREAM)
    parser.add_argument("--steps", type=int, default=3)
    parser.add_argument("--max-samples", type=int, default=16)
    parser.add_argument("--max-entities", type=int, default=128)
    parser.add_argument("--max-selected", type=int, default=16)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--learning-rate", type=float, default=1e-4)
    parser.add_argument("--preflight-only", action="store_true", help="CPU schema construction only; no model execution")
    args = parser.parse_args()
    if not 1 <= args.steps <= 100 or not 1 <= args.max_samples <= 128 or not 0 < args.learning_rate <= .001:
        parser.error("Bounded diagnostic requires steps1..100, samples1..128 and learning-rate(0,.001]")
    run(args)


if __name__ == "__main__":
    main()
