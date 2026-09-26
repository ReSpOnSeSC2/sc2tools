"""Learned head inversion, live pointer binding and paid-controller boundaries."""
import asyncio
import base64
from copy import deepcopy

import numpy as np
import pytest

from pluto_sc2.alphastar_tensor import TensorConfig, tensorize_sample, world_pixel
from pluto_sc2.intent_decoder import plan_next
from pluto_sc2.intent_runtime import IntentRuntime
from pluto_sc2.policy_intents import (
    PredictionError, bind_observation, inverse_world, prediction_integrity_valid, prediction_to_intent,
)
from test_intent_runtime import advance, world
from test_rich_intents import action, catalog, context, normalize


REGISTRY = [
    {"id": i, "name": name, "ability_id": ability, "general_id": general, "args": args,
     "camera_only_pt": planned, "planned_build": planned}
    for i, name, ability, general, args, planned in [
        (4, "Attack_Attack_pt", 23, 3674, ["queued", "unit_tags", "world"], False),
        (5, "Attack_Attack_unit", 23, 3674, ["queued", "unit_tags", "target_unit_tag"], False),
        (35, "Build_Pylon_pt", 881, 0, ["queued", "unit_tags", "world"], True),
        (36, "Build_Assimilator_unit", 882, 0, ["queued", "unit_tags", "target_unit_tag"], False),
        (47, "Build_CyberneticsCore_pt", 894, 0, ["queued", "unit_tags", "world"], True),
        (64, "Train_Probe_quick", 1006, 0, ["queued", "unit_tags"], False),
        (122, "Effect_ChronoBoostEnergyCost_unit", 3755, 0, ["queued", "unit_tags", "target_unit_tag"], False),
        (168, "raw_move_camera", 0, 0, ["world"], False),
    ]
]
SESSION = "native-match-fixture-unique-id"


def layer(value):
    return {"bits_per_pixel": 8, "size": {"x": 64, "y": 64},
            "data": base64.b64encode(bytes([value]) * 4096).decode()}


def frame():
    result = context()
    result.update(schema="protoss-rich-replay-v1", hud={"player_id": 2, "minerals": 500, "vespene": 200})
    result["entities"][0]["type_id"] = 84
    result["known_own"][0]["type_id"] = 84
    result["feature_layers"] = {"minimap_renders": {name: layer(value) for name, value in
        dict(height_map=8, visibility_map=2, creep=0, player_relative=1, alerts=0, pathable=1, buildable=1).items()}}
    return result


def add_entity(value, tag, owner, *, position=(139, 150), kind="Stalker"):
    value["entities"].append({"tag": tag, "owner": owner, "type_name": kind, "type_id": 74,
                              "position": list(position), "is_visible": True, "is_on_screen": True,
                              "cloak_state": 3})


def tags(value):
    current = sorted(r["tag"] for r in value["entities"])
    remembered = sorted({r["tag"] for k in ("known_own", "known_neutral") for r in value[k]} - set(current))
    return current + remembered


def binding(value, registry=None, public=None):
    return bind_observation(value, tags(value), registry or REGISTRY, public or catalog(), session_id=SESSION,
                            max_entities=8, max_selected=4)


def prediction(function=35, *, position=(140, 150), source=0, target=0, value=None):
    value = frame() if value is None else value
    x, y = world_pixel(position, value["spatial"]["map_size"])
    return {"function": np.asarray(function, np.int32), "unit_tags": np.asarray([source, 8, 8, 8], np.int32),
            "queued": np.asarray(0, np.int32), "target_unit_tag": np.asarray(target, np.int32),
            "world": np.asarray(y * 256 + x, np.int32), "delay": 99, "repeat": 99}


def convert(heads=None, value=None, *, bound=None, registry=None, public=None, session_id=SESSION):
    value = frame() if value is None else value
    registry, public = registry or REGISTRY, public or catalog()
    return prediction_to_intent(heads if heads is not None else prediction(value=value), registry, value,
                                bound if bound is not None else binding(value, registry, public), public,
                                session_id=session_id)


def test_predicted_pylon_has_distinct_provenance_and_paid_plan_without_native_wire():
    value, heads = frame(), prediction()
    before = deepcopy(value)
    result = convert(heads, value)
    assert result["admitted"] and result["provenance"] == "policy_prediction"
    assert prediction_integrity_valid(result)
    assert "wire_sha256" not in result and "wire_base64" not in result
    assert result["ability_id"] == 881 and result["source_tags"] == [101]
    assert result["target"]["point"] != [140, 150]  # Model resolution is honest cell-center quantization.
    assert {"paid_selection", "paid_command", "fresh_placement_query"} <= set(result["decoder_requirements"])
    assert result["evidence"]["disabled_heads"] == ["delay", "repeat"]
    assert not result["evidence"]["raw_execution_authorized"]
    assert plan_next(result, value)["stage"] == "placement_query"
    assert value == before
    heads["unit_tags"][0] = 7
    assert result["source_tags"] == [101] and prediction_integrity_valid(result)


@pytest.mark.parametrize("kind", ["unit", "world", "none"])
def test_actual_tensor_head_roundtrip_preserves_bound_source_and_target(kind):
    value = frame()
    add_entity(value, 900, 4)
    # Reverse raw input order; encoder and inverse must use the identical sorted sidecar.
    value["entities"].reverse()
    target = {"kind": "unit", "tag": 900} if kind == "unit" else {"kind": "world_point", "point": [140, 150]} if kind == "world" else None
    sample = {"frame": value, "preceding_loop": value["game_loop"], "action_loop": value["game_loop"] + 1,
              "replay_id": "a" * 64, "player_id": 2, "action_ordinal": 0,
              "intent": {"admitted": True, "kind": "unit_command",
              "ability_id": {"unit": 23, "world": 881, "none": 1006}[kind], "source_tags": [101],
              "queued": False, "target": target, "supervision": {"execution_class": "immediate"}}}
    encoded = tensorize_sample(sample, REGISTRY, {84: 7, 74: 8}, TensorConfig(max_entities=8, max_selected=4))
    bound = bind_observation(value, encoded["metadata"]["entity_tags"], REGISTRY, catalog(),
                             session_id=SESSION, max_entities=8, max_selected=4)
    result = convert(encoded["labels"], value, bound=bound)
    assert result["admitted"], result["reasons"]
    assert result["source_tags"] == [101]
    if kind == "world":
        assert world_pixel(result["target"]["point"], value["spatial"]["map_size"]) == world_pixel(target["point"], value["spatial"]["map_size"])
    else:
        assert result["target"] == target


@pytest.mark.parametrize("change", ["session", "loop", "camera", "hud", "player", "registry", "catalog", "sidecar"])
def test_stale_or_changed_binding_fails_closed(change):
    value, registry, public = frame(), deepcopy(REGISTRY), catalog()
    bound = binding(value, registry, public)
    session = SESSION
    if change == "session":
        session = "other-game-with-same-tags-and-loop"
    elif change == "loop":
        value["game_loop"] += 1
    elif change == "camera":
        value["camera"][0] += .1
    elif change == "hud":
        value["hud"]["minerals"] += 1
    elif change == "player":
        value["hud"]["player_id"] = 1
    elif change == "registry":
        registry[2]["general_id"] = 999
    elif change == "catalog":
        public["abilities"]["881"]["name"] = "ChangedPatch"
    else:
        bound["entity_tags"] = [999]
    assert not convert(value=value, bound=bound, registry=registry, public=public, session_id=session)["admitted"]


def test_archived_training_sidecar_is_not_a_live_binding():
    result = convert(bound={"entity_tags": [101], "preceding_loop": 2588, "replay_id": "a" * 64})
    assert result["reasons"] == ["live_observation_binding_required"]


@pytest.mark.parametrize("head,contents,reason", [
    ("unit_tags", [0, 0, 8, 8], "duplicate_source_pointer"),
    ("unit_tags", [0, 8, 0, 8], "source_pointer_after_eos"),
    ("unit_tags", [1, 8, 8, 8], "source_pointer_targets_padding"),
    ("unit_tags", [8, 8, 8, 8], "empty_source_selection"),
    ("unit_tags", [0, 8], "source_head_shape_mismatch"),
    ("unit_tags", [-1, 8, 8, 8], "invalid_source_pointer"),
    ("unit_tags", [0.0, 8, 8, 8], "invalid_source_pointer"),
    ("function", True, "invalid_function_head"),
    ("function", 999999, "unknown_function_prediction"),
    ("queued", 1, "controller_queue_not_supported"),
    ("world", 65536, "invalid_world_head"),
    ("world", float("nan"), "invalid_world_head"),
])
def test_invalid_meaningful_heads_are_not_coerced_or_repaired(head, contents, reason):
    heads = prediction()
    heads[head] = contents
    result = convert(heads)
    assert not result["admitted"] and result["reasons"] == [reason]


@pytest.mark.parametrize("change", ["hidden", "offscreen", "cloaked", "unknown_cloak", "fog"])
def test_sidecar_cannot_include_hidden_enemy(change):
    value = frame()
    add_entity(value, 900, 4)
    if change == "hidden":
        value["entities"][-1]["is_visible"] = False
    elif change == "offscreen":
        value["entities"][-1]["is_on_screen"] = False
    elif change in ("cloaked", "unknown_cloak"):
        value["entities"][-1]["cloak_state"] = 1 if change == "cloaked" else 0
    else:
        value["spatial"]["screen_visibility"] = [[0] * 128 for _ in range(72)]
    with pytest.raises(PredictionError, match="invalid_current_permitted_entity"):
        binding(value)


def test_enemy_cannot_be_source_and_self_cannot_be_attack_recipient():
    value = frame()
    add_entity(value, 900, 4)
    assert convert(prediction(5, source=1, target=0), value)["reasons"] == ["predicted_source_not_own"]
    assert convert(prediction(5, target=0), value)["reasons"] == ["friendly_attack_target"]
    assert convert(prediction(122, target=0), value)["admitted"]  # Own Chrono is not an attack.
    assert convert(prediction(5, target=2), value)["reasons"] == ["target_pointer_targets_padding"]


def test_boolean_owner_does_not_alias_self_alliance():
    value = frame()
    value["entities"][0]["owner"] = True
    with pytest.raises(PredictionError, match="invalid_current_permitted_entity"):
        binding(value)


def test_known_own_source_reacquires_without_claiming_current_selection_or_orders():
    value = frame()
    value["known_own"].append({"tag": 50, "owner": 1, "type_id": 59, "type_name": "Nexus",
                              "position": [130, 170], "last_seen_loop": 2500})
    bound = binding(value)
    assert bound["entity_tags"] == [101, 50]  # Current rows first, not globally sorted.
    result = convert(prediction(64, source=1), value, bound=bound)
    assert result["admitted"] and result["source_tags"] == [50]
    assert "paid_source_reacquisition" in result["decoder_requirements"]
    step = plan_next(result, value)
    assert step["stage"] == "camera" and step["operation"]["point"] == [130, 170]
    assert convert(prediction(122, target=1), value)["reasons"] == ["unit_target_not_current_visible_or_known_gas"]


@pytest.mark.parametrize("change", ["future", "enemy_owner", "duplicate", "wrong_order", "unknown_tag"])
def test_memory_and_encoder_sidecar_are_causal_and_exact(change):
    value = frame()
    value["known_own"].append({"tag": 50, "owner": 1, "type_name": "Nexus", "position": [130, 170], "last_seen_loop": 2500})
    sidecar = [101, 50]
    if change == "future":
        value["known_own"][-1]["last_seen_loop"] = 3000
    elif change == "enemy_owner":
        value["known_own"][-1]["owner"] = 4
    elif change == "duplicate":
        value["known_own"].append(deepcopy(value["known_own"][-1]))
    elif change == "wrong_order":
        sidecar = [50, 101]
    else:
        sidecar = [101, 999]
    with pytest.raises(PredictionError):
        bind_observation(value, sidecar, REGISTRY, catalog(), session_id=SESSION)


def test_remembered_neutral_geyser_is_only_permitted_stale_unit_target():
    value = frame()
    value["known_neutral"] = [{"tag": 20, "owner": 3, "type_name": "VESPENEGEYSER", "type_id": 342,
                                "position": [141.5, 159.5], "last_seen_loop": 2200}]
    result = convert(prediction(36, target=1), value)
    assert result["admitted"] and result["target"] == {"kind": "unit", "tag": 20, "point": [141.5, 159.5]}
    assert result["evidence"]["target_evidence"]["kind"] == "previously_seen_neutral"
    assert {"paid_camera_reframe", "fresh_target_visibility", "fresh_placement_query"} <= set(result["decoder_requirements"])
    assert convert(prediction(5, target=1), value)["reasons"] == ["unit_target_not_current_visible_or_known_gas"]
    value["known_neutral"][0]["type_name"] = "MINERALFIELD"
    assert not convert(prediction(36, target=1), value)["admitted"]


@pytest.mark.parametrize("bad_layer", [None, "visibility_map", "buildable", "missing"])
def test_offscreen_core_requires_whitelist_and_label_independent_public_terrain(bad_layer):
    value = frame()
    if bad_layer == "missing":
        value["feature_layers"] = {}
    elif bad_layer:
        value["feature_layers"]["minimap_renders"][bad_layer] = layer(0)
    result = convert(prediction(47, position=(139.5, 159.5)), value)
    assert result["admitted"] is (bad_layer is None)
    if bad_layer is None:
        assert "paid_camera_reframe" in result["decoder_requirements"]
        assert plan_next(result, value)["stage"] == "camera"


def test_world_generic_attack_cannot_use_offscreen_build_mask():
    assert convert(prediction(4, position=(139.5, 159.5)))["reasons"] == ["world_target_not_permitted_current_intent"]


def test_public_function_mismatch_and_ambiguous_inverse_fail_closed():
    public = catalog()
    public["abilities"]["881"]["target"] = 3
    assert convert(public=public)["reasons"] == ["function_public_target_kind_mismatch"]
    registry = deepcopy(REGISTRY)
    registry.append({**registry[2], "id": 999})
    assert convert(registry=registry)["reasons"] == ["ambiguous_native_function_inverse"]
    public = catalog()
    public["abilities"]["881"]["available"] = False
    assert convert(public=public)["reasons"] == ["public_ability_not_supported"]


@pytest.mark.parametrize("size,point", [([184, 200], [140, 150]), ([100, 120], [.1, .1]), ([120, 100], [100, 99.9])])
def test_non_square_public_map_inverse_roundtrip(size, point):
    x, y = world_pixel(point, size)
    center = inverse_world(y * 256 + x, size)
    assert world_pixel(center, size) == (x, y)
    assert all(0 <= v < bound for v, bound in zip(center, size))


@pytest.mark.parametrize("size,cell", [([184, 200], 255), ([200, 184], 255 * 256), ([100, 120], 65535)])
def test_padded_map_regions_are_rejected_without_clamping(size, cell):
    with pytest.raises(PredictionError, match="padded_map"):
        inverse_world(cell, size)


def test_camera_ignores_unused_heads_but_pays_actual_camera_input():
    heads = prediction(168, position=(20, 20))
    heads.update(queued=1, unit_tags=[999], target_unit_tag=999)
    result = convert(heads)
    assert result["admitted"] and not result["source_tags"] and not result["queued"]
    assert result["decoder_requirements"] == ["paid_camera"]
    step = plan_next(result, frame())
    assert step["stage"] == "camera" and step["paid_input"] and not step["raw_command"]


def test_unused_target_heads_are_not_reinterpreted_for_targetless_function():
    heads = prediction(64)
    heads.update(world=-999, target_unit_tag=999)
    result = convert(heads)
    assert result["admitted"] and result["target"] is None


def test_prediction_runtime_uses_actual_controller_two_paid_inputs_and_prediction_receipt():
    async def scenario():
        value = frame()
        intent = convert(value=value)
        bot = world(value)
        runtime = IntentRuntime(session_id=SESSION)
        assert (await runtime.step(bot, intent, value))["stage"] == "selection_issued"
        advance(bot, value)
        final = await runtime.step(bot, intent, value)
        assert final["stage"] == "complete"
        assert final["receipt"]["intent_id"] == intent["intent_id"] and "wire_sha256" not in final["receipt"]
        assert bot.fairplay.budget.total == 2
        command = bot.client.requests[-1].actions[0]
        assert command.HasField("action_feature_layer") and not command.HasField("action_raw")
        assert command.action_feature_layer.unit_command.ability_id == 881
    asyncio.run(scenario())


@pytest.mark.parametrize("failure", ["session", "unconfigured", "changed_frame", "mutated_intent", "player"])
def test_runtime_rechecks_prediction_binding_before_any_input(failure):
    async def scenario():
        value = frame()
        intent = convert(value=value)
        bot = world(value)
        runtime = IntentRuntime(session_id="other" if failure == "session" else None if failure == "unconfigured" else SESSION)
        if failure == "changed_frame":
            value["hud"]["minerals"] += 1
        elif failure == "mutated_intent":
            intent["target"]["point"][0] += 1
        elif failure == "player":
            bot.player_id = 1
        result = await runtime.step(bot, intent, value)
        assert result["stage"] == "deferred"
        assert not bot.client.requests and bot.fairplay.budget.total == 0
    asyncio.run(scenario())


def test_prediction_and_replay_receipt_namespaces_are_not_interchangeable():
    value = frame()
    intent = convert(prediction(168), value)
    wrong = {"camera": {"wire_sha256": intent["intent_id"], "confirmed_loop": value["game_loop"], "paid": True}}
    assert plan_next(intent, value, confirmations=wrong)["stage"] == "camera"
    wrong["camera"]["intent_id"] = wrong["camera"].pop("wire_sha256")
    assert plan_next(intent, value, confirmations=wrong)["stage"] == "complete"


def test_policy_runtime_cannot_reuse_coincidentally_matching_archived_native_tags():
    async def scenario():
        value = frame()
        native, _ = normalize(action(881, (140, 150), (71, 43)), value)
        assert native["admitted"] and native["evidence"]["preceding_loop"] == value["game_loop"]
        bot, runtime = world(value), IntentRuntime(session_id=SESSION)
        result = await runtime.step(bot, native, value)
        assert result["reason"] == "observed_wire_not_allowed_in_policy_session"
        assert not bot.client.requests
    asyncio.run(scenario())


def test_quantized_camera_noop_terminates_without_fabricated_paid_receipt():
    async def scenario():
        value = frame()
        intent = convert(prediction(168, position=value["camera"]), value)
        bot, runtime = world(value), IntentRuntime(session_id=SESSION)
        result = await runtime.step(bot, intent, value)
        assert result["stage"] == "deferred"
        assert result["reason"] == "camera_already_at_requested_minimap_pixel"
        assert not bot.client.requests and not runtime.confirmations and bot.fairplay.budget.total == 0
    asyncio.run(scenario())
