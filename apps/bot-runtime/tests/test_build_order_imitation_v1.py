import copy

import numpy as np
import pytest
import torch

from pluto_sc2.build_order_imitation_v1 import (
    CAPACITY,
    BuildOrderPrior,
    collate_examples,
    extend_vocabulary,
    imitation_loss,
    prefix_example,
    validate_record,
)


def record(partition="train"):
    return dict(
        race="Protoss",
        partition=partition,
        commands=[
            dict(ability_link=10 + i, command_index=0, game_loop=loop, source_event_index=i)
            for i, loop in enumerate((10, 20, 20, 40))
        ],
    )


def test_no_target_same_loop_or_future_in_prefix():
    row = record()
    vocabulary = extend_vocabulary([row])
    before = prefix_example(row, 2, vocabulary)
    changed = copy.deepcopy(row)
    for i in (1, 2, 3):
        changed["commands"][i]["ability_link"] = 99
    after = prefix_example(changed, 2, vocabulary)
    for x, y in zip(before[:3], after[:3]):
        np.testing.assert_array_equal(x, y)
    assert before[2] == 1
    assert before[0][0] == vocabulary["10:0"]


def test_start_uses_bos_and_time_zero():
    row = record()
    vocabulary = extend_vocabulary([row])
    tokens, times, length, _, _ = prefix_example(row, 0, vocabulary)
    assert tokens[0] == 1 and length == 1 and not times.any()


def test_validation_does_not_extend_vocabulary():
    row, valid = record(), record("validation")
    valid["commands"][0]["ability_link"] = 600
    vocabulary = extend_vocabulary([row, valid])
    assert "600:0" not in vocabulary
    assert prefix_example(valid, 0, vocabulary)[3] == -1


def test_incremental_tokens_append_without_remapping():
    row = record()
    previous = extend_vocabulary([row])
    row["commands"][0]["ability_link"] = 6
    extended = extend_vocabulary([row], previous)
    assert all(extended[key] == slot for key, slot in previous.items())
    assert extended["6:0"] == len(previous) + 2


def test_bad_vocabulary_or_capacity_fails():
    with pytest.raises(ValueError):
        extend_vocabulary([], {"wrong": 10})
    many = record()
    many["commands"] = [dict(ability_link=i, command_index=0) for i in range(CAPACITY)]
    with pytest.raises(ValueError):
        extend_vocabulary([many])


def test_reordered_commands_rejected():
    row = record()
    row["commands"][1]["source_event_index"] = 3
    with pytest.raises(ValueError):
        validate_record(row)


def test_model_masks_reserved_slots_and_has_finite_gradient():
    row = record()
    vocabulary = extend_vocabulary([row])
    inputs = collate_examples([prefix_example(row, i, vocabulary) for i in range(4)])
    model = BuildOrderPrior()
    logits, waits = model(*inputs[:3], len(vocabulary))
    assert (logits[:, :2] == -1e9).all()
    assert (logits[:, len(vocabulary) + 2 :] == -1e9).all()
    loss, _, _ = imitation_loss(logits, waits, *inputs[3:])
    loss.backward()
    assert torch.isfinite(loss) and sum(p.grad.abs().sum() for p in model.parameters()) > 0


def test_unknown_target_cannot_enter_training_loss():
    with pytest.raises(ValueError):
        imitation_loss(torch.zeros(1, CAPACITY), torch.zeros(1), torch.tensor([-1]), torch.zeros(1))


def test_reserved_growth_does_not_change_parameter_or_optimizer_shapes():
    model = BuildOrderPrior()
    optimizer = torch.optim.Adam(model.parameters())
    row = record()
    vocabulary = extend_vocabulary([row])
    args = collate_examples([prefix_example(row, i, vocabulary) for i in range(4)])
    loss, _, _ = imitation_loss(*model(*args[:3], len(vocabulary)), *args[3:])
    loss.backward()
    optimizer.step()
    checkpoint = copy.deepcopy((model.state_dict(), optimizer.state_dict()))
    restored = BuildOrderPrior()
    restored_optimizer = torch.optim.Adam(restored.parameters())
    restored.load_state_dict(checkpoint[0])
    restored_optimizer.load_state_dict(checkpoint[1])
    for a, b in zip(model.parameters(), restored.parameters()):
        assert torch.equal(a, b)
    for a, b in zip(optimizer.state.values(), restored_optimizer.state.values()):
        for key in a:
            assert torch.equal(a[key], b[key])


def test_time_features_only_use_previous_loop():
    row = record()
    vocabulary = extend_vocabulary([row])
    a = prefix_example(row, 3, vocabulary)
    row["commands"][3]["game_loop"] = 200
    b = prefix_example(row, 3, vocabulary)
    np.testing.assert_array_equal(a[1], b[1])
    assert a[4] != b[4]
