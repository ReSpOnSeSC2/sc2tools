import copy

import pytest
import torch

from pluto_sc2.build_order_imitation_v1 import BuildOrderPrior
from pluto_sc2.build_order_hud_prior_v1 import HudResidualPrior, verify_frozen_base


def inputs():
    return (torch.tensor([[1, 0], [2, 3]]), torch.zeros(2, 2, 2), torch.tensor([1, 2]), 4,
            torch.tensor([[.2, .1, .1, .3, 1, 1, 1, 1], [0., 0, 0, 0, 0, 0, 0, 0]]))


def test_initial_parity_mask_wait_and_rng_exact():
    base = BuildOrderPrior()
    rng = torch.get_rng_state().clone()
    model = HudResidualPrior(base.state_dict())
    assert torch.equal(torch.get_rng_state(), rng)
    expected = base(*inputs()[:4])
    actual = model(*inputs())
    assert all(torch.equal(a, b) for a, b in zip(actual, expected))
    assert all(not p.requires_grad for p in model.base.parameters())


def test_adapter_learning_never_changes_base_wait_or_mask():
    base = BuildOrderPrior()
    params = copy.deepcopy(base.state_dict())
    model = HudResidualPrior(params).train()
    optimizer = torch.optim.Adam(model.adapter.parameters(), lr=.002)
    expected = base(*inputs()[:4])
    logits, _ = model(*inputs())
    torch.nn.functional.cross_entropy(logits, torch.tensor([3, 2])).backward()
    optimizer.step()
    actual, wait = model(*inputs())
    assert not torch.equal(actual[0, 2:6], expected[0][0, 2:6])
    assert torch.equal(actual[1], expected[0][1])  # Missing HUD always preserves parent.
    assert torch.equal(wait, expected[1])
    assert torch.equal(actual.eq(-1e9), expected[0].eq(-1e9))
    verify_frozen_base(model, params)


@pytest.mark.parametrize("kind", ["nonfinite", "fractional_known", "missing_nonzero", "shape"])
def test_invalid_hud_rejected(kind):
    model = HudResidualPrior(BuildOrderPrior().state_dict())
    values = list(inputs())
    if kind == "nonfinite":
        values[-1][0, 0] = float("nan")
    elif kind == "fractional_known":
        values[-1][0, 4] = .5
    elif kind == "missing_nonzero":
        values[-1][1, 0] = 1
    else:
        values[-1] = values[-1][:, :7]
    with pytest.raises(ValueError):
        model(*values)
