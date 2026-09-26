import copy
import io
import multiprocessing
import random

import pytest
import torch

from scripts import train_build_order_hud_v1 as trainer
from pluto_sc2.build_order_hud_prior_v1 import HudResidualPrior, verify_frozen_base
from pluto_sc2.build_order_imitation_v1 import BuildOrderPrior


def training_values(seed):
    generator = torch.Generator().manual_seed(seed)
    hud = torch.cat((torch.rand(5, 4, generator=generator), torch.ones(5, 4)), dim=1)
    return (torch.tensor([[1, 0], [2, 3], [3, 4], [4, 2], [2, 5]]),
            torch.zeros(5, 2, 2), torch.tensor([1, 2, 2, 2, 2]), torch.tensor([2, 3, 4, 5, 2]),
            torch.zeros(5), hud)


def test_exact_adapter_resume_matches_uninterrupted_and_base_never_changes():
    torch.set_num_threads(1)
    base = copy.deepcopy(BuildOrderPrior().state_dict())
    model = HudResidualPrior(base)
    model.vocabulary_size = 4
    optimizer = torch.optim.Adam(model.adapter.parameters(), lr=trainer.LR)
    for i in range(3):
        trainer.step(model, optimizer, training_values(i))
    buffer = io.BytesIO()
    torch.save({"adapter": model.adapter.state_dict(), "optimizer": optimizer.state_dict()}, buffer)
    for i in range(3, 8):
        trainer.step(model, optimizer, training_values(i))
    restored = HudResidualPrior(base)
    restored.vocabulary_size = 4
    state = torch.load(io.BytesIO(buffer.getvalue()), weights_only=True)
    restored.adapter.load_state_dict(state["adapter"])
    resumed = torch.optim.Adam(restored.adapter.parameters(), lr=trainer.LR)
    resumed.load_state_dict(state["optimizer"])
    for i in range(3, 8):
        trainer.step(restored, resumed, training_values(i))
    assert trainer.exact(model.adapter.state_dict(), restored.adapter.state_dict())
    assert trainer.exact(optimizer.state_dict(), resumed.state_dict())
    trainer.verify_adapter_optimizer(restored, resumed, 8)
    verify_frozen_base(model, base)
    verify_frozen_base(restored, base)


def test_frozen_equality_rejects_changed_signed_zero():
    assert not trainer.exact(torch.tensor([0.]), torch.tensor([-0.]))


def test_optimizer_cannot_include_base():
    model = HudResidualPrior(BuildOrderPrior().state_dict())
    optimizer = torch.optim.Adam(model.parameters(), lr=trainer.LR)
    with pytest.raises(ValueError, match="outside"):
        trainer.verify_adapter_optimizer(model, optimizer, 0)


def test_resume_shuffle_rng_exact():
    generator = random.Random(23)
    trainer.next_order(list(range(300)), generator)
    state = generator.getstate()
    expected = trainer.next_order(list(range(300)), generator)
    restored = random.Random()
    restored.setstate(state)
    assert trainer.next_order(list(range(300)), restored) == expected


@pytest.mark.parametrize("phase,offset,updates", [("training", 128, 1), ("training", 256, 2),
                                                   ("evaluation", 300, 3)])
def test_durable_partial_cursor(phase, offset, updates):
    cursor = {"epochs_completed": 0, "phase": phase, "order": list(range(300)), "next_offset": offset}
    trainer.validate_cursor(cursor, 300, updates)
    with pytest.raises(ValueError):
        trainer.validate_cursor(cursor, 300, updates + 1)


@pytest.mark.parametrize("kind", ["duplicate", "nonbatch", "early_evaluation", "ready_with_order"])
def test_changed_cursor_rejected(kind):
    cursor = {"epochs_completed": 0, "phase": "training", "order": list(range(300)), "next_offset": 128}
    if kind == "duplicate":
        cursor["order"][1] = 0
    elif kind == "nonbatch":
        cursor["next_offset"] = 127
    elif kind == "early_evaluation":
        cursor["phase"] = "evaluation"
    else:
        cursor["phase"] = "ready"
    with pytest.raises(ValueError):
        trainer.validate_cursor(cursor, 300)


def lease_child(path, connection):
    try:
        with trainer.TrainingLease(path):
            connection.send("acquired")
    except RuntimeError:
        connection.send("busy")
    finally:
        connection.close()


def test_os_lease_prevents_second_process_and_releases(tmp_path):
    path = tmp_path / "trainer.lock"
    context = multiprocessing.get_context("spawn")
    with trainer.TrainingLease(path):
        receiver, sender = context.Pipe(duplex=False)
        process = context.Process(target=lease_child, args=(path, sender))
        process.start()
        sender.close()
        assert receiver.poll(20)
        assert receiver.recv() == "busy"
        process.join(20)
        assert process.exitcode == 0
    with trainer.TrainingLease(path):
        pass


def test_continuous_review_is_bound_to_exact_run_checkpoint_and_source(tmp_path):
    import json
    path = tmp_path / "review.json"
    receipt = {"schema": "own-command-hud-continuation-review-v1", "approved": True,
               "run_path": str(tmp_path), "parent_checkpoint_sha256": trainer.PARENT_SHA,
               "initial_parity_passed": True, "frozen_base_and_optimizer_verified": True,
               "source_hashes": {"source": "hash"}, "checkpoint_sha256": "checkpoint"}
    path.write_text(json.dumps(receipt))
    sha = trainer.continuation_permission(path, tmp_path, "checkpoint", {}, {"source": "hash"})
    assert trainer.continuation_permission(path, tmp_path, "later", {"continuation_review_sha256": sha}, {"source": "hash"}) == sha
    with pytest.raises(ValueError):
        trainer.continuation_permission(path, tmp_path, "changed", {}, {"source": "hash"})
    with pytest.raises(ValueError):
        trainer.continuation_permission(path, tmp_path, "checkpoint", {}, {"source": "other"})


def test_orphan_snapshot_allocation_never_overwrites_and_reference_matches(tmp_path):
    path = tmp_path / "checkpoint-000002-adapter00000378.pt"
    path.write_bytes(b"orphan preserved")
    assert trainer.allocate_snapshot(tmp_path, 1, 378) == (3, "checkpoint-000003-adapter00000378.pt")
    assert path.read_bytes() == b"orphan preserved"


def test_epoch_receipt_chain_is_immutable_and_resume_checks_it(tmp_path):
    first = {"epoch": 1, "adapter_updates": 378, "metrics": {"correct": 7}}
    digest = trainer.append_epoch_receipt(tmp_path, first, None)
    assert trainer.append_epoch_receipt(tmp_path, first, None) == digest
    second = {"epoch": 2, "adapter_updates": 756, "metrics": {"correct": 8}}
    final = trainer.append_epoch_receipt(tmp_path, second, digest)
    trainer.verify_epoch_chain(tmp_path, 2, final)
    with pytest.raises(ValueError):
        trainer.append_epoch_receipt(tmp_path, {**first, "metrics": {"correct": 9}}, None)
    with pytest.raises(ValueError):
        trainer.verify_epoch_chain(tmp_path, 2, digest)


def test_stop_before_update_preserves_optimizer_age_and_adapter():
    model = HudResidualPrior(BuildOrderPrior().state_dict())
    model.vocabulary_size = 4
    optimizer = torch.optim.Adam(model.adapter.parameters(), lr=trainer.LR)
    before = copy.deepcopy(model.adapter.state_dict())
    def stop():
        raise InterruptedError("STOP")
    with pytest.raises(InterruptedError):
        trainer.step(model, optimizer, training_values(1), before_step=stop)
    assert trainer.exact(before, model.adapter.state_dict())
    trainer.verify_adapter_optimizer(model, optimizer, 0)


def test_real_normalized_float_weights_expand_only_whole_train_views():
    row = {"race": "Protoss", "partition": "train", "weight": 2.0,
           "commands": [{"game_loop": 12}, {"game_loop": 50000}]}
    assert trainer.weighted_training_examples([row, {**row, "partition": "validation"}]) == [(row, 0), (row, 0)]
    with pytest.raises(ValueError):
        trainer.weighted_training_examples([{**row, "weight": 1.5}])
