"""Numerical diagnostics and non-invasive graph instrumentation contracts."""
from copy import deepcopy

import numpy as np
import pytest

from scripts.audit_alphastar_world_logits_v1 import distribution_metrics, mask_transition, instrument_component


def test_stable_ce_entropy_rank_and_mask_exclusion_are_distinct():
    logits = np.array([1000., 1000., 998., 997.], np.float32)
    mask = np.array([True, True, False, True])
    value = distribution_metrics(logits, mask, 1, size=2)
    probabilities = np.exp([0, 0, -3]) / np.exp([0, 0, -3]).sum()
    assert value["target_rank_strict"] == 1 and value["target_tie_count"] == 2
    assert value["target_ce_nats"] == pytest.approx(-np.log(probabilities[1]))
    assert value["entropy_nats"] == pytest.approx(-np.sum(probabilities * np.log(probabilities)))
    excluded = distribution_metrics(logits, mask, 2, size=2)
    assert excluded["target_ce_nats"] is None and excluded["target_rank_strict"] is None
    assert not excluded["target_allowed"] and excluded["target_probability"] == 0


def test_masked_huge_logit_cannot_dominate_and_removal_does_not_change_allowed_logits():
    logits = np.array([2., 4., 1e9, 0.])
    before = np.ones(4, bool)
    after = np.array([True, True, False, True])
    masked = np.where(after, logits, -1e10)
    assert distribution_metrics(masked, after, 1, size=2)["argmax"] == 1
    assert mask_transition(logits, before, masked, after)["removed_cells"] == 1
    with pytest.raises(ValueError, match="expanded"):
        mask_transition(masked, after, logits, before)
    masked[0] += .01
    with pytest.raises(ValueError, match="allowed logit"):
        mask_transition(logits, before, masked, after)


@pytest.mark.parametrize("logits,mask", [(np.array([0., np.nan, 1., 2.]), np.ones(4, bool)),
    (np.zeros(4), np.zeros(4, bool)), (np.zeros(4), np.ones(4, int))])
def test_invalid_distributions_fail_closed(logits, mask):
    with pytest.raises(ValueError):
        distribution_metrics(logits, mask, 0, size=2)


class Part:
    def __init__(self, name):
        self.name = name
        self.output_spec = {("logits", "world"): "float", ("masks", "world"): "bool"}


class Sequential:
    def __init__(self, name):
        self.name, self._components = name, []
        self.input_spec = {"visual_stream_ds8": "features"}

    def append(self, component):
        self._components.append(component)


def test_taps_preserve_original_components_order_and_scopes_without_mutation():
    root, world = Sequential("official_lite_rich_intent_v1"), Sequential("world_head")
    for name in ("vector_to_visual", "logits", "intent_mask_world", "observed_building_overlap_mask_v1", "sample"):
        world.append(Part(name))
    root.append(Part("function_head"))
    root.append(world)
    originals = list(world._components)
    copied = instrument_component(root, Sequential, lambda stage, specs: Part("tap_" + stage))
    rebuilt = copied._components[1]
    assert rebuilt.name == world.name and copied._components[0] is root._components[0]
    assert [p for p in rebuilt._components if not p.name.startswith("tap_")] == originals
    assert world._components == originals
    assert [p.name for p in rebuilt._components] == ["tap_encoder_visual", "vector_to_visual", "logits", "tap_raw",
        "intent_mask_world", "tap_intent", "observed_building_overlap_mask_v1", "tap_placement", "sample"]
    bad = deepcopy(root)
    bad._components[1]._components[2:4] = reversed(bad._components[1]._components[2:4])
    with pytest.raises(ValueError, match="ordering"):
        instrument_component(bad, Sequential, lambda stage, specs: Part(stage))
