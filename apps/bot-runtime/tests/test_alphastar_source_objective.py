"""CPU proof of the narrow source objective, independent of SC2/GPU execution."""
from copy import deepcopy
from types import SimpleNamespace

import numpy as np
import pytest
import torch

from scripts.alphastar_source_objective import (
    HEADS, SOURCE_OBJECTIVE, TensorError, gradient_comparison, make_source_objective,
    objective_contract, require_objective_contract, source_loss_reference,
)


def fixture(slots, source_count, vocab=25):
    """Same legal prefix; after first EOS every mask admits EOS only."""
    if not 1 <= source_count < min(slots, vocab):
        raise ValueError("Fixture requires room for first EOS")
    eos = vocab - 1
    labels = np.full(slots, eos, np.int32)
    labels[:source_count] = np.arange(source_count)
    masks = np.ones((slots, vocab), bool)
    for step in range(slots):
        masks[step, :min(step, source_count)] = False
        if step == 0:
            masks[step, eos] = False
        if step > source_count:
            masks[step] = False
            masks[step, eos] = True
    raw = np.random.default_rng(812).normal(size=(slots, vocab))
    return np.where(masks, raw, -1e10), labels, masks


@pytest.mark.parametrize("count", [1, 3, 13, 15])
def test_padding_dilution_and_corrected_logit_gradient_parity(count):
    old = source_loss_reference(*fixture(16, count))
    new = source_loss_reference(*fixture(64, count))
    assert old["legacy_loss"] > 0
    assert new["legacy_loss"] * 4 == pytest.approx(old["legacy_loss"], abs=1e-14)
    assert new["corrected_loss"] == pytest.approx(old["legacy_loss"], abs=1e-14)
    np.testing.assert_array_equal(old["corrected_gradient"], new["corrected_gradient"][:16])
    np.testing.assert_array_equal(new["corrected_gradient"][count + 1:], 0)
    np.testing.assert_array_equal(new["token_loss"][count + 1:], 0)


@pytest.mark.parametrize("count", [16, 18, 63])
def test_larger_source_sets_have_finite_loss_without_claiming_old_capacity_parity(count):
    logits, labels, masks = fixture(64, count, vocab=80)
    result = source_loss_reference(logits, labels, masks)
    assert np.isfinite(result["corrected_loss"]) and result["corrected_loss"] > 0
    assert result["corrected_loss"] == pytest.approx(result["legacy_loss"] * 4)
    assert result["weight"] == 4


def test_inactive_sources_have_exactly_zero_loss_and_gradient():
    result = source_loss_reference(*fixture(64, 13), active=False)
    assert result["legacy_loss"] == result["corrected_loss"] == 0
    np.testing.assert_array_equal(result["corrected_gradient"], 0)


def test_masked_active_target_is_never_silently_admitted():
    logits, labels, masks = fixture(64, 13)
    masks[0, labels[0]] = False
    logits[0, labels[0]] = -1e10
    with pytest.raises(TensorError, match="label is masked"):
        source_loss_reference(logits, labels, masks)


@pytest.mark.parametrize("capacity", [0, 15, 32, 65, True, 64.0])
def test_unreviewed_capacity_fails_closed(capacity):
    with pytest.raises(TensorError):
        objective_contract(capacity)


def test_metadata_is_exact_and_other_head_weights_are_unchanged():
    old, new = objective_contract(16), objective_contract(64)
    assert new["objective_id"] == SOURCE_OBJECTIVE
    assert new["weights"]["unit_tags"] == 4
    assert old["weights"]["unit_tags"] == 1
    for name in HEADS:
        if name != "unit_tags":
            assert old["weights"][name] == new["weights"][name]
    require_objective_contract(new, 64)
    changed = deepcopy(new)
    changed["weights"]["world"] = 4
    with pytest.raises(TensorError):
        require_objective_contract(changed, 64)
    with pytest.raises(TensorError):
        require_objective_contract({}, 64)


def test_official_factory_contract_and_per_head_evaluation():
    class Loss:
        def __init__(self, *, action_spec, weights, burnin_len, overlap_len):
            assert burnin_len == overlap_len == 0
            self.weights = weights

        def batched_loss(self, inputs):
            return sum(inputs[name] * self.weights[name] for name in HEADS), {}

    specs = {head: SimpleNamespace(shape=(64,) if head == "unit_tags" else ()) for head in HEADS}
    inputs = {head: number + 1 for number, head in enumerate(HEADS)}
    objective = make_source_objective(specs, loss_factory=Loss)
    per_head = objective.batched_head_losses(inputs)
    assert sum(per_head.values()) == objective.batched_loss(inputs)[0]
    assert per_head["unit_tags"] == 4 * inputs["unit_tags"]
    assert per_head["delay"] == per_head["repeat"] == 0
    source_only = make_source_objective(specs, source_only=True, loss_factory=Loss)
    assert source_only.batched_loss(inputs)[0] == per_head["unit_tags"]
    assert objective.weights["function"] == 1  # Separate proof instance did not mutate trainer weights.


@pytest.mark.parametrize("count", [1, 13, 15])
def test_cpu_network_parameter_gradients_match_analytic_and_padding_contract(count):
    """Independent autodiff through a nonlinear shared source head, CPU only.

This complements the separate restored official-network audit; it is not
represented as a whole AlphaStar checkpoint gradient test.
"""
    generator = torch.Generator(device="cpu").manual_seed(91)
    features = torch.randn(64, 7, generator=generator, dtype=torch.float64)
    weight = torch.randn(7, 11, generator=generator, dtype=torch.float64, requires_grad=True)
    pointer = torch.randn(11, 25, generator=generator, dtype=torch.float64, requires_grad=True)

    def calculation(slots, corrected):
        _, labels, masks = fixture(slots, count)
        logits = torch.tanh(features[:slots] @ weight) @ pointer
        logits = torch.where(torch.from_numpy(masks), logits, torch.full_like(logits, -1e10))
        token = -torch.log_softmax(logits, dim=-1)[torch.arange(slots), torch.from_numpy(labels).long()]
        objective = token.sum() / (16 if corrected else slots)
        gradients = torch.autograd.grad(objective, (weight, pointer), retain_graph=True)
        logits_grad = torch.autograd.grad(objective, logits)[0]
        reference = source_loss_reference(logits.detach().numpy(), labels, masks)
        np.testing.assert_allclose(logits_grad.detach().numpy(), reference[
            "corrected_gradient" if corrected else "legacy_gradient"], rtol=1e-13, atol=1e-14)
        return objective.item(), {"weight": gradients[0].numpy(), "pointer": gradients[1].numpy()}

    a, ga = calculation(16, False)
    b, gb = calculation(64, False)
    c, gc = calculation(64, True)
    assert a == pytest.approx(c, abs=1e-13)
    assert c == pytest.approx(4 * b, abs=1e-13)
    assert gradient_comparison(ga, gc, rtol=1e-12, atol=1e-13)["passed"]
    assert gradient_comparison({k: 4 * v for k, v in gb.items()}, gc,
                               rtol=1e-12, atol=1e-13)["passed"]


def test_gradient_gate_reports_discrepancy_and_rejects_schema_or_nonfinite():
    value = {"module": {"w": np.array([1.0, 2.0])}}
    report = gradient_comparison(value, {"module": {"w": np.array([1.0, 2.01])}})
    assert not report["passed"] and report["max_abs_error"] > .009
    assert report["worst_leaves"][0]["path"] == "/module/w"
    with pytest.raises(TensorError):
        gradient_comparison(value, {"other": np.array([1.0])})
    with pytest.raises(TensorError):
        gradient_comparison(value, {"module": {"w": np.array([np.nan, 2])}})


def test_actual_network_probe_selection_retains_train_and_mixed_source_counts():
    from scripts.audit_alphastar_source_objective import select_probe_rows
    from scripts.preflight_alphastar_curriculum import identity

    rows = [{"replay_id": "train-replay", "player_id": 2, "action_ordinal": index,
             "partition": "train", "intent": {"source_tags": list(range(count))}}
            for index, count in enumerate([0, 1, 3, 5, 18])]
    anchors = [identity(row) for row in rows[:2]]
    original = [identity(row) for row in rows[:4]]
    chosen = select_probe_rows(rows, anchors, original, 3)
    assert [len(row["intent"]["source_tags"]) for row in chosen] == [1, 5, 0]
    rows[3]["partition"] = "validation"
    with pytest.raises(TensorError, match="TRAIN"):
        select_probe_rows(rows, anchors, original, 3)
    with pytest.raises(TensorError, match="bounded"):
        select_probe_rows(rows, anchors, original, 26)


def output_fixture(count=3):
    logits, labels, masks = fixture(64, count)
    outputs = {("logits", "unit_tags"): logits[None, None],
               ("masks", "unit_tags"): masks[None, None],
               ("action", "unit_tags"): labels[None, None],
               ("argument_masks", "unit_tags"): np.array([[True]]),
               ("masks", "function"): np.ones((1, 1, 3), bool),
               ("action", "function"): np.array([[1]]),
               ("argument_masks", "function"): np.array([[True]])}
    example = {"active_heads": {"function": True, "unit_tags": True},
               "labels": {"function": np.array(1), "unit_tags": labels}}
    return outputs, example, SimpleNamespace(max_entities=24)


def test_restored_output_gate_verifies_first_eos_and_rejects_unmasked_padding():
    from scripts.audit_alphastar_source_objective import source_output_proof

    outputs, example, config = output_fixture()
    proof = source_output_proof(outputs, example, config)
    assert proof["source_count"] == 3 and proof["meaningful_slots_including_first_eos"] == 4
    assert proof["post_eos_loss_and_gradient_zero"]
    outputs["masks", "unit_tags"][0, 0, 4, 10] = True
    outputs["logits", "unit_tags"][0, 0, 4, 10] = .5
    with pytest.raises(TensorError, match="EOS-only"):
        source_output_proof(outputs, example, config)


def test_restored_output_gate_rejects_silently_masked_meaningful_source():
    from scripts.audit_alphastar_source_objective import source_output_proof

    outputs, example, config = output_fixture()
    outputs["masks", "unit_tags"][0, 0, 0, 0] = False
    outputs["logits", "unit_tags"][0, 0, 0, 0] = -1e10
    with pytest.raises(TensorError, match="silently masked"):
        source_output_proof(outputs, example, config)
