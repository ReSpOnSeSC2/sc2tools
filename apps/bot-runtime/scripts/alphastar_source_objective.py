"""Versioned source-slot normalization; official graph and losses stay frozen.

Official Supervised averages unit_tags over capacity, including zero-loss slots
after EOS. Weight capacity/16 retains the original sixteen-slot scale. This is
not an EOS bonus, a new label, or per-example meaningful-length normalization.
"""
from __future__ import annotations

import numpy as np

from pluto_sc2.alphastar_tensor import DISABLED_HEADS, HEADS, TensorError

SOURCE_OBJECTIVE = "source-slot-normalization16-v1"
REFERENCE_SOURCE_SLOTS = 16


def objective_contract(max_selected):
    if type(max_selected) is not int or max_selected not in (16, 64):
        raise TensorError("Source objective supports only reviewed16/64 selection capacities")
    weights = {head: 0.0 if head in DISABLED_HEADS else 1.0 for head in HEADS}
    weights["unit_tags"] = max_selected / REFERENCE_SOURCE_SLOTS
    return {"objective_id": SOURCE_OBJECTIVE, "reference_source_slots": REFERENCE_SOURCE_SLOTS,
            "max_selected": max_selected, "weights": weights,
            "source_reduction": "sum of official masked source-token CE /16",
            "first_eos_supervised": True, "post_eos_labels_or_masks_changed": False,
            "other_head_weights_changed": False, "evaluation_example_weights": False}


def require_objective_contract(record, max_selected):
    expected = objective_contract(max_selected)
    if record != expected:
        raise TensorError("Unknown or changed source objective contract")
    return expected


class SourceObjective:
    """Official loss factory with explicit metadata and comparable head metrics.

Training uses batched_loss. Evaluation can use batched_head_losses on the same
unweighted example set; it does not reuse sampling/oversampling frequencies.
Each head value includes its declared objective weight. Disabled heads are zero.
"""

    def __init__(self, action_spec, *, source_only=False, loss_factory=None):
        if set(action_spec) != set(HEADS) or type(source_only) is not bool:
            raise TensorError("Require the unchanged official action-head vocabulary")
        shape = tuple(action_spec["unit_tags"].shape)
        if len(shape) != 1:
            raise TensorError("Source action spec must have one selection-slot dimension")
        self.contract = objective_contract(shape[0])
        if loss_factory is None:
            from alphastar.unplugged.losses.supervised import Supervised
            loss_factory = Supervised
        self.weights = dict(self.contract["weights"])
        if source_only:
            self.weights = {head: weight if head == "unit_tags" else 0.0
                            for head, weight in self.weights.items()}
        self.source_only = source_only
        self._action_spec, self._factory = action_spec, loss_factory
        self._loss = self._make(self.weights)
        self._head_losses = None

    def _make(self, weights):
        return self._factory(action_spec=self._action_spec, weights=weights, burnin_len=0, overlap_len=0)

    def batched_loss(self, inputs):
        return self._loss.batched_loss(inputs)

    def batched_head_losses(self, inputs):
        if self._head_losses is None:
            self._head_losses = {head: self._make({name: self.weights[name] if name == head else 0.0
                                                  for name in HEADS}) for head in HEADS}
        return {head: loss.batched_loss(inputs)[0] for head, loss in self._head_losses.items()}


def make_source_objective(action_spec, *, source_only=False, loss_factory=None):
    return SourceObjective(action_spec, source_only=source_only, loss_factory=loss_factory)


def source_loss_reference(logits, labels, masks, *, active=True):
    """Independent float64 loss/analytic derivative for CPU contract tests.

Consumes already-masked teacher-forced logits, just like official Supervised.
Invalid active targets fail instead of becoming silently zero-loss examples.
There is deliberately no trainer or parameter update in this helper.
"""
    logits, labels, masks = np.asarray(logits, dtype=np.float64), np.asarray(labels), np.asarray(masks)
    if (logits.ndim != 2 or logits.shape[0] not in (16, 64) or logits.shape[1] < 2
            or labels.shape != logits.shape[:1] or labels.dtype.kind not in "iu"
            or masks.dtype != np.bool_ or masks.shape != logits.shape or type(active) is not bool
            or np.any(labels < 0) or np.any(labels >= logits.shape[1])
            or not np.all(np.isfinite(logits[masks])) or not np.all(masks.any(axis=1))
            or np.any(np.isnan(logits)) or np.any(logits[~masks] > -1e8)):
        raise TensorError("Invalid masked source-loss reference inputs")
    if active and not np.all(masks[np.arange(len(labels)), labels]):
        raise TensorError("Active source label is masked; no normalization may admit it")
    maximum = logits.max(axis=1, keepdims=True)
    exp = np.exp(logits - maximum)
    probabilities = exp / exp.sum(axis=1, keepdims=True)
    logsumexp = maximum[:, 0] + np.log(exp.sum(axis=1))
    token_loss = logsumexp - logits[np.arange(len(labels)), labels]
    gradient = probabilities.copy()
    gradient[np.arange(len(labels)), labels] -= 1
    if not active:
        token_loss[:] = 0
        gradient[:] = 0
    slots = len(labels)
    return {"legacy_loss": float(token_loss.sum() / slots),
            "corrected_loss": float(token_loss.sum() / REFERENCE_SOURCE_SLOTS),
            "legacy_gradient": gradient / slots, "corrected_gradient": gradient / REFERENCE_SOURCE_SLOTS,
            "token_loss": token_loss, "weight": objective_contract(slots)["weights"]["unit_tags"]}


def gradient_comparison(reference, candidate, *, rtol=2e-5, atol=2e-4):
    """Report measured whole-tree discrepancy without widening the gate."""
    def flatten(value, prefix=""):
        if isinstance(value, dict):
            result = {}
            for key in sorted(value):
                result.update(flatten(value[key], prefix + "/" + str(key)))
            return result
        return {prefix: np.asarray(value)}
    left, right = flatten(reference), flatten(candidate)
    if set(left) != set(right):
        raise TensorError("Gradient tree paths changed")
    worst, square_error, square_reference, max_abs, count = [], 0.0, 0.0, 0.0, 0
    passed = True
    for path in left:
        a, b = left[path], right[path]
        if a.shape != b.shape or not np.all(np.isfinite(a)) or not np.all(np.isfinite(b)):
            raise TensorError("Gradient tree shape or finite-value check failed")
        delta = np.asarray(b, np.float64) - np.asarray(a, np.float64)
        error = float(np.max(np.abs(delta))) if delta.size else 0.0
        margin = float(np.max(np.abs(delta) - (atol + rtol * np.abs(a)))) if delta.size else -atol
        square_error += float(np.sum(delta * delta))
        square_reference += float(np.sum(np.square(np.asarray(a, np.float64))))
        max_abs = max(max_abs, error)
        count += a.size
        passed = passed and bool(np.allclose(a, b, rtol=rtol, atol=atol))
        worst.append({"path": path, "max_abs_error": error, "max_tolerance_excess": margin})
    return {"passed": passed, "leaves": len(left), "values": count, "max_abs_error": max_abs,
            "l2_error": square_error**.5, "reference_l2": square_reference**.5,
            "relative_l2_error": (square_error / square_reference)**.5 if square_reference else None,
            "rtol": rtol, "atol": atol,
            "worst_leaves": sorted(worst, key=lambda row: row["max_tolerance_excess"], reverse=True)[:5]}
