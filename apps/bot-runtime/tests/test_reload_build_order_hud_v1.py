import copy

import pytest
import torch

from scripts import reload_build_order_hud_v1 as review


def checkpoint(updates):
    state = {} if updates == 0 else {0: {"step": torch.tensor(float(updates)),
        "exp_avg": torch.zeros(512, 8), "exp_avg_sq": torch.ones(512, 8)}}
    return {"adapter_updates": updates, "adapter_parameters": {"weight": torch.zeros(512, 8)},
        "adapter_optimizer": {"state": state, "param_groups": [{"params": [0], "lr": .0005,
            "betas": (.9, .999), "eps": 1e-8, "weight_decay": 0, "amsgrad": False, "maximize": False}]},
        "cursor": {"epochs_completed": updates // 378, "phase": "ready", "order": [], "next_offset": 0}}


@pytest.mark.parametrize("updates", [0, 378, 756])
def test_separately_aged_adapter_state(updates):
    assert review.verify_adapter_state(checkpoint(updates)) == updates // 378


@pytest.mark.parametrize("fault", ["age", "extra_parameter", "dtype", "negative_variance", "cursor", "lr"])
def test_reject_corrupt_optimizer_or_cursor(fault):
    value = copy.deepcopy(checkpoint(378))
    if fault == "age":
        value["adapter_optimizer"]["state"][0]["step"] += 1
    elif fault == "extra_parameter":
        value["adapter_optimizer"]["param_groups"][0]["params"].append(1)
    elif fault == "dtype":
        value["adapter_optimizer"]["state"][0]["exp_avg"] = torch.zeros(512, 8, dtype=torch.float64)
    elif fault == "negative_variance":
        value["adapter_optimizer"]["state"][0]["exp_avg_sq"][0, 0] = -1
    elif fault == "cursor":
        value["cursor"]["next_offset"] = 128
    else:
        value["adapter_optimizer"]["param_groups"][0]["lr"] = .002
    with pytest.raises(ValueError):
        review.verify_adapter_state(value)


def test_initial_adapter_must_really_be_zero():
    value = checkpoint(0)
    value["adapter_parameters"]["weight"][0, 0] = 1e-10
    with pytest.raises(ValueError, match="not zero"):
        review.verify_adapter_state(value)


def test_byte_equality_and_digest_distinguish_signed_zero():
    assert not review.exact(torch.tensor([0.]), torch.tensor([-0.]))
    assert review.tree_sha({"value": torch.tensor([0.])}) != review.tree_sha({"value": torch.tensor([-0.])})
