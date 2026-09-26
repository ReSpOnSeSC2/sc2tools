"""Geometry counterexamples are synthetic tests, never demonstration labels."""
from copy import deepcopy

import numpy as np
import pytest

from pluto_sc2.building_placement_v1 import (
    PlacementError, assess_placement, build_placement_constraints, build_placement_masks,
    registry_class_indices,
)


def catalog():
    units, abilities = {}, {}
    for uid, name, aid, size in [(59, "Nexus", 880, 5), (60, "Pylon", 881, 2),
                                 (61, "Assimilator", 882, 3), (62, "Gateway", 883, 3)]:
        target = 3 if aid == 882 else 2
        units[str(uid)] = dict(unit_id=uid, name=name, ability_id=aid, race=3,
                               available=True, attributes=[8])
        abilities[str(aid)] = dict(id=aid, name="ProtossBuild", target=target,
            native=dict(ability_id=aid, link_name="ProtossBuild", button_name=name,
                        is_building=True, target=target, footprint_radius=size / 2))
    return dict(units=units, abilities=abilities)


def unit(tag=1, type_id=60, name="Pylon", point=(20, 20), **overrides):
    return dict(tag=tag, type_id=type_id, type_name=name, position=list(point), owner=1,
                is_visible=True, is_on_screen=True, is_flying=False, is_hallucination=False,
                health=100, build_progress=.1, **overrides)


def frame(entities=None):
    return dict(schema="protoss-rich-replay-v1", game_loop=10, camera=[20, 20],
        entities=[unit()] if entities is None else entities, known_own=[], known_neutral=[],
        spatial=dict(map_size=[64, 64], screen_size=[128, 72], camera_width=24,
                     camera_height=13.5, screen_visibility=[[2] * 128 for _ in range(72)]))


def registry():
    return [dict(id=0, name="Build_Pylon_pt", ability_id=881, args=["queued", "unit_tags", "world"]),
            dict(id=1, name="Build_Gateway_pt", ability_id=883, args=["queued", "unit_tags", "world"]),
            dict(id=2, name="Build_Nexus_pt", ability_id=880, args=["queued", "unit_tags", "world"]),
            dict(id=3, name="Attack_pt", ability_id=23, args=["queued", "unit_tags", "world"]),
            dict(id=4, name="Build_Assimilator_unit", ability_id=882, args=["queued", "unit_tags", "target_unit_tag"])]


def test_same_cell_pylon_then_gateway_is_proven_conflict():
    result = assess_placement(frame(), catalog(), 883, [20, 20], quantized=True)
    assert result["state"] == "proven_conflict" and result["exclude"]
    assert result["conflicts"] == [1]


def test_legal_adjacent_gateway_and_nexus_ignore_render_and_collision_radius():
    data = frame([unit(type_id=59, name="Nexus", point=(23.5, 19.5), radius=100)])
    data["feature_layers"] = {"renders": {"unit_type": "intentionally not geometry"}}
    # Exactly touching public5x5/3x3 squares; rendered silhouettes can overlap.
    result = assess_placement(data, catalog(), 883, [19.5, 21.5], quantized=True)
    assert not result["exclude"] and result["state"] == "unknown"


def test_quantization_does_not_reject_a_cell_that_contains_a_legal_boundary():
    data = frame()
    # Cell-center overlap is insufficient: a possible point and its placement
    # snap can separate these footprints. Strict inequality preserves contact.
    result = assess_placement(data, catalog(), 883, [22.3, 20], quantized=True)
    assert result["state"] == "unknown" and result["uncertain_overlaps"] == [1]


@pytest.mark.parametrize("changes", [dict(is_visible=False), dict(is_on_screen=False),
    dict(last_seen_loop=9), dict(is_flying=True), dict(is_hallucination=True), dict(health=0)])
def test_stale_hidden_airborne_or_nonreal_structure_never_excludes(changes):
    entity = unit()
    entity.update(changes)
    assert not assess_placement(frame([entity]), catalog(), 883, [20, 20])["exclude"]


def test_memory_and_fog_do_not_supply_occupancy():
    data = frame([])
    data["known_own"] = [dict(unit(), last_seen_loop=9)]
    data["spatial"]["screen_visibility"] = [[0] * 128 for _ in range(72)]
    result = assess_placement(data, catalog(), 883, [20, 20])
    assert result["state"] == "unknown" and not result["structures"]
    assert build_placement_masks(data, registry(), catalog())["masks"].all()


def test_current_visible_enemy_is_allowed_but_cloaked_enemy_is_not():
    entity = unit()
    entity.update(owner=4, cloak_state=3)
    assert assess_placement(frame([entity]), catalog(), 883, [20, 20])["exclude"]
    entity["cloak_state"] = 1
    assert not assess_placement(frame([entity]), catalog(), 883, [20, 20])["exclude"]


@pytest.mark.parametrize("mutation", ["radius", "identity", "structure", "missing"])
def test_unknown_or_changed_public_metadata_is_permissive(mutation):
    data = catalog()
    if mutation == "radius":
        data["abilities"]["881"]["native"]["footprint_radius"] = 20
    elif mutation == "identity":
        data["units"]["60"]["name"] = "Unknown"
    elif mutation == "structure":
        data["units"]["60"]["attributes"] = []
    else:
        del data["abilities"]["881"]
    assert not assess_placement(frame(), data, 883, [20, 20])["exclude"]


def test_gas_unknown_functions_and_registry_aliases_remain_permissive():
    data = registry()
    assert registry_class_indices(data, catalog()).tolist() == [0, 1, 2, -1, -1]
    assert assess_placement(frame(), catalog(), 882, [20, 20])["state"] == "unknown"
    assert assess_placement(frame(), catalog(), 9999, [20, 20])["state"] == "unknown"
    data[1]["name"] = "SomeOtherGateway"
    assert registry_class_indices(data, catalog())[1] == -1


def test_unobserved_clear_point_is_unknown_and_observed_clear_is_not_legality():
    assert assess_placement(frame([]), catalog(), 881, [20, 20])["state"] == "no_observed_conflict"
    assert assess_placement(frame([]), catalog(), 881, [50, 50])["state"] == "unknown"


def test_vector_mask_matches_reference_every_cell_on_synthetic_small_map():
    data = frame([unit(), unit(tag=2, type_id=59, name="Nexus", point=(24, 22))])
    masks = build_placement_masks(data, registry(), catalog())
    assert masks["masks"].shape == (3, 256, 256) and masks["masks"].dtype == np.bool_
    # Exhaustively prove geometric reference parity by directly checking every
    # public center and obstacle, without thousands of repeated frame parsing.
    constraints = build_placement_constraints(data, catalog(), 881)
    margin = constraints["quantized_margin"]
    for cls, radius in enumerate((1, 1.5, 2.5)):
        for y in range(256):
            for x in range(256):
                point = ((x + .5) / 4, 64 - (y + .5) / 4)
                conflict = any(all(abs(p - q) + m < radius + obstacle["radius"]
                                   for p, q, m in zip(point, obstacle["position"], margin))
                               for obstacle in constraints["structures"])
                assert masks["masks"][cls, y, x] == (not conflict)
    for x, y in ((80, 175), (91, 171), (96, 167), (10, 10)):
        point = [(x + .5) / 4, 64 - (y + .5) / 4]
        for cls, ability in enumerate((881, 883, 880)):
            assert masks["masks"][cls, y, x] == (not assess_placement(
                data, catalog(), ability, point, quantized=True)["exclude"])


def test_non_square_map_y_inversion_padding_and_existing_mask_intersection():
    data = frame()
    data["spatial"]["map_size"] = [32, 64]
    result = build_placement_masks(data, registry(), catalog())
    assert result["masks"][:, :, 128:].all()  # Existing graph, not us, excludes padding.
    assert result["requires_existing_mask_intersection"] is True
    existing = np.zeros((256, 256), dtype=bool)
    assert not (result["masks"][0] & existing).any()
    assert not result["masks"][0, 175, 80]


def test_inputs_unchanged_and_labels_rejected_not_read():
    data, public = frame(), catalog()
    before = deepcopy((data, public))
    build_placement_masks(data, registry(), public)
    assert (data, public) == before
    for key in ("intent", "labels", "action_ordinal", "hidden_enemies"):
        with pytest.raises(PlacementError, match="observation-only"):
            assess_placement({**data, key: {}}, public, 881, [20, 20])


def test_invalid_registry_transform_and_nonfinite_points_fail_closed():
    with pytest.raises(PlacementError):
        registry_class_indices([dict(registry()[0], id=2)], catalog())
    with pytest.raises(PlacementError):
        build_placement_masks(frame(), registry(), catalog(), world_size=64)
    with pytest.raises(PlacementError):
        assess_placement(frame(), catalog(), 881, [float("nan"), 20])


def test_missing_pixel_precision_never_creates_an_exclusion():
    data = frame()
    del data["spatial"]["screen_size"]
    assert not assess_placement(data, catalog(), 881, [20, 20])["exclude"]
    assert build_placement_masks(data, registry(), catalog())["masks"].all()
