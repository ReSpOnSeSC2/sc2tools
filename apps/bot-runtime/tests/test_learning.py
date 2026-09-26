"""Learning tests use numerical rollouts and do not require a game install."""

from dataclasses import replace
import random

import numpy as np
import pytest
import torch

from pluto_sc2.learning import (
    Policy,
    PPOConfig,
    PPOTrainer,
    Transition,
    compute_gae,
    load_checkpoint,
    save_checkpoint,
)


@pytest.fixture(autouse=True)
def reproducible_learning_test():
    previous_threads = torch.get_num_threads()
    torch.set_num_threads(1)
    torch.manual_seed(73)
    np.random.seed(73)
    random.seed(73)
    yield
    torch.set_num_threads(previous_threads)


def transition(**overrides):
    values = dict(
        observation=np.zeros(4, dtype=np.float32),
        mask=np.ones(3, dtype=bool),
        action=0,
        log_prob=-np.log(3),
        value=1.0,
        reward=2.0,
        next_value=3.0,
        terminated=False,
        truncated=False,
    )
    values.update(overrides)
    return Transition(**values)


def rollout(policy, count=24):
    transitions = []
    for index in range(count):
        observation = np.random.normal(size=policy.input_dim).astype(np.float32)
        mask = np.array([True, index % 2 == 0, True])
        action, log_prob, value = policy.act(observation, mask)
        transitions.append(
            Transition(
                observation, mask, action, log_prob, value,
                float(action == 0) + index / count, 0.0,
                index % 6 == 5, False,
            )
        )
    return transitions


def assert_nested_equal(left, right):
    if isinstance(left, torch.Tensor):
        assert torch.equal(left, right)
    elif isinstance(left, dict):
        assert left.keys() == right.keys()
        for key in left:
            assert_nested_equal(left[key], right[key])
    elif isinstance(left, (tuple, list)):
        assert len(left) == len(right)
        for item_left, item_right in zip(left, right):
            assert_nested_equal(item_left, item_right)
    else:
        assert left == right


def test_masked_policy_can_only_select_legal_action():
    policy = Policy(4, 3, hidden_dim=16)
    observation = np.zeros(4, dtype=np.float32)
    mask = np.array([False, True, False])
    for deterministic in (False, True):
        for _ in range(10):
            action, log_prob, value = policy.act(observation, mask, deterministic)
            assert action == 1
            assert log_prob == 0
            assert np.isfinite(value)
    assert policy.value(observation) == value


@pytest.mark.parametrize("mask", [
    [False, False, False],
    [1, 2, 0],
    [1, np.nan, 0],
    [True, False],
    [[True, False, False]],
])
def test_invalid_masks_are_rejected(mask):
    with pytest.raises(ValueError, match="mask"):
        Policy(4, 3, 16).act(np.zeros(4, dtype=np.float32), np.asarray(mask))


@pytest.mark.parametrize("observation", [
    [0, 0, np.nan, 0], [0, np.inf, 0, 0], [0, 0, 0],
    [[0, 0, 0, 0]], [0j, 0j, 1j, 0j],
])
def test_invalid_observations_are_rejected(observation):
    with pytest.raises(ValueError, match="observation"):
        Policy(4, 3, 16).act(np.asarray(observation), np.ones(3, dtype=bool))


def test_nonfinite_logits_are_rejected_even_for_masked_action():
    policy = Policy(4, 3, 16)
    with torch.no_grad():
        policy.actor.bias[1] = torch.nan
    with pytest.raises(ValueError, match="non-finite"):
        policy.act(np.zeros(4), np.array([True, False, True]))


def test_batch_evaluation_matches_inference_and_has_finite_gradients():
    policy = Policy(4, 3, 16)
    observations = np.random.normal(size=(5, 4)).astype(np.float32)
    masks = np.array([[True, False, True]] * 5)
    outputs = [policy.act(obs, mask) for obs, mask in zip(observations, masks)]
    actions = torch.tensor([output[0] for output in outputs])
    log_probs, entropies, values = policy.evaluate(
        torch.from_numpy(observations), torch.from_numpy(masks), actions
    )
    np.testing.assert_allclose(log_probs.detach().numpy(), [output[1] for output in outputs], atol=1e-6)
    np.testing.assert_allclose(values.detach().numpy(), [output[2] for output in outputs], atol=1e-6)
    (-log_probs.mean() + values.square().mean() - .01 * entropies.mean()).backward()
    assert all(parameter.grad is not None and torch.isfinite(parameter.grad).all() for parameter in policy.parameters())
    with pytest.raises(ValueError, match="excluded"):
        policy.evaluate(torch.from_numpy(observations), torch.from_numpy(masks), torch.ones(5, dtype=torch.long))
    with pytest.raises(ValueError, match="integer"):
        policy.evaluate(torch.from_numpy(observations), torch.from_numpy(masks), actions.float())


def test_gae_bootstraps_truncation_but_never_crosses_episode_boundary():
    # The second episode's huge reward must not leak into the truncated first.
    transitions = [
        transition(value=1, reward=2, next_value=3),
        transition(value=3, reward=4, next_value=5, truncated=True),
        transition(value=7, reward=100, next_value=999, terminated=True),
    ]
    advantages, returns = compute_gae(transitions, gamma=.9, gae_lambda=.8)
    # Last step: 100 - 7; truncation: 4 + .9*5 - 3; first: 2+.9*3-1+.9*.8*5.5
    np.testing.assert_allclose(advantages, [7.66, 5.5, 93], atol=1e-5)
    np.testing.assert_allclose(returns, [8.66, 8.5, 100], atol=1e-5)


def test_gae_terminal_ignores_bootstrap_and_nonterminal_rollout_end_uses_it():
    terminal_advantages, _ = compute_gae([transition(terminated=True)], gamma=.9)
    truncated_advantages, _ = compute_gae([transition(truncated=True)], gamma=.9)
    unfinished_advantages, _ = compute_gae([transition()], gamma=.9)
    np.testing.assert_allclose(terminal_advantages, [1])
    np.testing.assert_allclose(truncated_advantages, [3.7])
    np.testing.assert_allclose(unfinished_advantages, [3.7])


@pytest.mark.parametrize("kwargs", [
    {"learning_rate": 0}, {"learning_rate": "0.1"}, {"gamma": 1.1},
    {"gae_lambda": -.1}, {"clip_range": 0}, {"epochs": True},
    {"minibatch_size": 0}, {"entropy_coef": -1}, {"value_coef": np.nan},
    {"max_grad_norm": 0}, {"target_kl": 0},
    {"reference_kl_coef": -1}, {"reference_kl_coef": float("nan")},
])
def test_ppo_configuration_rejects_invalid_values(kwargs):
    with pytest.raises(ValueError):
        PPOConfig(**kwargs)


def test_ppo_update_changes_parameters_and_reports_finite_metrics():
    policy = Policy(4, 3, 16)
    trainer = PPOTrainer(policy, PPOConfig(epochs=3, minibatch_size=7, target_kl=None))
    transitions = rollout(policy)
    original = {key: tensor.clone() for key, tensor in policy.state_dict().items()}
    metrics = trainer.update(transitions)
    assert metrics["optimizer_steps"] == 12
    assert metrics["transitions"] == 24
    assert all(np.isfinite(value) for value in metrics.values())
    assert any(not torch.equal(original[key], tensor) for key, tensor in policy.state_dict().items())


def test_ppo_rejects_invalid_rollout_before_changing_parameters():
    policy = Policy(4, 3, 16)
    trainer = PPOTrainer(policy)
    transitions = rollout(policy)
    transitions[-1] = replace(transitions[-1], mask=np.zeros(3, dtype=bool))
    original = {key: tensor.clone() for key, tensor in policy.state_dict().items()}
    with pytest.raises(ValueError, match="legal action"):
        trainer.update(transitions)
    assert_nested_equal(original, policy.state_dict())
    with pytest.raises(ValueError, match="at least one"):
        trainer.update([])


def test_ppo_stops_before_step_when_old_policy_diverges():
    policy = Policy(4, 3, 16)
    transitions = [replace(item, log_prob=-20) for item in rollout(policy)]
    trainer = PPOTrainer(policy, PPOConfig(target_kl=.01))
    original = {key: tensor.clone() for key, tensor in policy.state_dict().items()}
    metrics = trainer.update(transitions)
    assert metrics["early_stop"] == 1
    assert metrics["optimizer_steps"] == 0
    assert_nested_equal(original, policy.state_dict())


def test_checkpoint_roundtrip_restores_policy_optimizer_config_and_counters(tmp_path):
    policy = Policy(4, 3, 16)
    config = PPOConfig(epochs=2, minibatch_size=6, target_kl=None)
    trainer = PPOTrainer(policy, config)
    trainer.update(rollout(policy))
    path = tmp_path / "checkpoints" / "agent.pt"
    metadata = {"feature_schema": "v1", "actions": ["wait", "train", "attack"], "notes": None}
    save_checkpoint(path, policy, trainer.optimizer, metadata, {"updates": 1, "steps": 24}, config)
    restored_policy = Policy(4, 3, 16)
    restored_trainer = PPOTrainer(restored_policy, config)
    restored = load_checkpoint(path, restored_policy, restored_trainer.optimizer, 4, 3)
    assert restored["policy"] is restored_policy
    assert restored["metadata"] == metadata
    assert restored["counters"] == {"updates": 1, "steps": 24}
    assert restored["config"] == config
    assert_nested_equal(policy.state_dict(), restored_policy.state_dict())
    assert_nested_equal(trainer.optimizer.state_dict(), restored_trainer.optimizer.state_dict())
    assert load_checkpoint(path)["policy"].hidden_dim == 16
    observation = np.arange(4, dtype=np.float32)
    mask = np.array([True, False, True])
    assert restored_policy.act(observation, mask, True) == policy.act(observation, mask, True)


def test_checkpoint_resumes_exact_rng_and_next_optimizer_update(tmp_path):
    policy = Policy(4, 3, 16)
    config = PPOConfig(epochs=2, minibatch_size=5, target_kl=None)
    trainer = PPOTrainer(policy, config)
    transitions = rollout(policy)
    trainer.update(transitions)
    path = tmp_path / "resume.pt"
    save_checkpoint(path, policy, trainer.optimizer, config=config)
    expected_random = (random.random(), np.random.rand(), torch.rand(4))
    expected_metrics = trainer.update(transitions)
    expected_state = {key: value.clone() for key, value in policy.state_dict().items()}
    restored_policy = Policy(4, 3, 16)
    restored_trainer = PPOTrainer(restored_policy, config)
    load_checkpoint(path, restored_policy, restored_trainer.optimizer, restore_rng=True)
    actual_random = (random.random(), np.random.rand(), torch.rand(4))
    assert_nested_equal(expected_random, actual_random)
    actual_metrics = restored_trainer.update(transitions)
    assert expected_metrics == actual_metrics
    assert_nested_equal(expected_state, restored_policy.state_dict())


def test_checkpoint_checks_schema_dimensions_and_parameter_integrity(tmp_path):
    policy = Policy(4, 3, 16)
    path = tmp_path / "agent.pt"
    save_checkpoint(path, policy)
    with pytest.raises(ValueError, match="input_dim"):
        load_checkpoint(path, expected_input_dim=5)
    with pytest.raises(ValueError, match="action_dim"):
        load_checkpoint(path, expected_action_dim=4)
    with pytest.raises(ValueError, match="dimensions"):
        load_checkpoint(path, Policy(4, 3, 32))
    checkpoint = torch.load(path, weights_only=True)
    checkpoint["policy_state"]["actor.weight"][0, 0] = torch.nan
    torch.save(checkpoint, path)
    original = {key: tensor.clone() for key, tensor in policy.state_dict().items()}
    with pytest.raises(ValueError, match="parameter"):
        load_checkpoint(path, policy)
    assert_nested_equal(original, policy.state_dict())
    checkpoint["schema_version"] = 999
    torch.save(checkpoint, path)
    with pytest.raises(ValueError, match="schema_version"):
        load_checkpoint(path)


def test_failed_atomic_save_keeps_prior_checkpoint_and_cleans_temporary_file(tmp_path, monkeypatch):
    policy = Policy(4, 3, 16)
    path = tmp_path / "agent.pt"
    save_checkpoint(path, policy, counters={"steps": 12})
    original_bytes = path.read_bytes()

    def broken_save(payload, stream):
        stream.write(b"incomplete checkpoint")
        raise OSError("simulated disk failure")

    monkeypatch.setattr(torch, "save", broken_save)
    with pytest.raises(OSError, match="disk failure"):
        save_checkpoint(path, policy, counters={"steps": 24})
    assert path.read_bytes() == original_bytes
    assert list(tmp_path.iterdir()) == [path]


def test_checkpoint_rejects_non_json_metadata_and_negative_counters(tmp_path):
    policy = Policy(4, 3, 16)
    with pytest.raises(ValueError, match="JSON"):
        save_checkpoint(tmp_path / "bad.pt", policy, metadata={"custom": object()})
    with pytest.raises(ValueError, match="counters"):
        save_checkpoint(tmp_path / "bad.pt", policy, counters={"steps": -1})
    assert not (tmp_path / "bad.pt").exists()


def test_checkpoint_loading_without_rng_restore_does_not_consume_rng(tmp_path):
    policy = Policy(4, 3, 16)
    path = tmp_path / "agent.pt"
    save_checkpoint(path, policy)
    torch_before = torch.get_rng_state().clone()
    python_before = random.getstate()
    numpy_before = np.random.get_state()
    load_checkpoint(path)
    assert torch.equal(torch_before, torch.get_rng_state())
    assert python_before == random.getstate()
    numpy_after = np.random.get_state()
    assert numpy_before[0] == numpy_after[0]
    np.testing.assert_array_equal(numpy_before[1], numpy_after[1])
    assert numpy_before[2:] == numpy_after[2:]


def test_default_outcome_discount_preserves_reward_across_long_episode():
    assert PPOConfig().gamma == 1.0
    transitions = [transition(value=0, reward=0, next_value=0) for _ in range(200)]
    transitions[-1] = replace(transitions[-1], reward=1, terminated=True)
    _, returns = compute_gae(transitions, gae_lambda=1.0)
    np.testing.assert_array_equal(returns, np.ones(200, dtype=np.float32))


def reference_only_rollout(policy, mask):
    observation = np.zeros(policy.input_dim, dtype=np.float32)
    action, log_prob, value = policy.act(observation, mask)
    return [Transition(observation, mask, action, log_prob, value, value, 0, True, False)] * 4


def test_reference_regularizer_reduces_kl_without_mutating_teacher_or_source():
    policy = Policy(4, 3, 16)
    teacher = Policy(4, 3, 16)
    with torch.no_grad():
        teacher.actor.bias[0] = 2
    teacher_state = {key: value.clone() for key, value in teacher.state_dict().items()}
    config = PPOConfig(
        epochs=1, learning_rate=.02, target_kl=None, reference_kl_coef=1,
        entropy_coef=0, value_coef=0,
    )
    trainer = PPOTrainer(policy, config, reference_policy=teacher)
    assert trainer.reference_policy is not teacher
    assert trainer.reference_policy is not policy
    assert not trainer.reference_policy.training
    assert not any(parameter.requires_grad for parameter in trainer.reference_policy.parameters())
    mask = np.array([True, False, True])
    metrics = [trainer.update(reference_only_rollout(policy, mask)) for _ in range(8)]
    assert metrics[0]["reference_kl"] > 0.1
    assert metrics[-1]["reference_kl"] < metrics[0]["reference_kl"] * .5
    assert all(result["reference_enabled"] == 1 for result in metrics)
    assert_nested_equal(teacher_state, teacher.state_dict())
    assert_nested_equal(teacher_state, trainer.reference_policy.state_dict())
    assert all(parameter.grad is None for parameter in trainer.reference_policy.parameters())
    with torch.no_grad():
        teacher.actor.bias.add_(1)
    assert_nested_equal(teacher_state, trainer.reference_policy.state_dict())


def test_reference_kl_ignores_illegal_action_logits_and_is_zero_for_equal_legal_policy():
    policy = Policy(4, 3, 16)
    trainer = PPOTrainer(
        policy, PPOConfig(epochs=1, value_coef=0, entropy_coef=0, target_kl=None),
        reference_policy=policy,
    )
    with torch.no_grad():
        trainer.reference_policy.actor.bias[1] = 50_000
    original = {key: value.clone() for key, value in policy.state_dict().items()}
    metrics = trainer.update(reference_only_rollout(policy, np.array([True, False, True])))
    assert metrics["reference_kl"] == 0
    assert metrics["reference_enabled"] == 1
    assert_nested_equal(original, policy.state_dict())
    assert all(np.isfinite(value) for value in metrics.values())


@pytest.mark.parametrize("reference_present,coefficient", [(False, .01), (True, 0.0)])
def test_plain_ppo_reports_reference_disabled(reference_present, coefficient):
    policy = Policy(4, 3, 16)
    trainer = PPOTrainer(
        policy, PPOConfig(reference_kl_coef=coefficient),
        reference_policy=policy if reference_present else None,
    )
    metrics = trainer.update(rollout(policy))
    assert metrics["reference_kl"] == 0
    assert metrics["reference_enabled"] == 0


def test_reference_rejects_wrong_architecture_or_nonfinite_weights():
    policy = Policy(4, 3, 16)
    with pytest.raises(ValueError, match="dimensions"):
        PPOTrainer(policy, reference_policy=Policy(4, 3, 32))
    teacher = Policy(4, 3, 16)
    with torch.no_grad():
        teacher.actor.weight[0, 0] = torch.inf
    with pytest.raises(ValueError, match="finite"):
        PPOTrainer(policy, reference_policy=teacher)


def test_corrupted_teacher_rejects_entire_update_before_student_changes():
    policy = Policy(4, 3, 16)
    trainer = PPOTrainer(policy, reference_policy=policy)
    transitions = rollout(policy)
    with torch.no_grad():
        trainer.reference_policy.actor.bias[0] = torch.nan
    original = {key: value.clone() for key, value in policy.state_dict().items()}
    with pytest.raises(ValueError, match="non-finite"):
        trainer.update(transitions)
    assert_nested_equal(original, policy.state_dict())


def test_anchored_checkpoint_resumes_exact_teacher_optimizer_and_next_update(tmp_path):
    policy = Policy(4, 3, 16)
    config = PPOConfig(epochs=2, minibatch_size=5, target_kl=None)
    trainer = PPOTrainer(policy, config, reference_policy=policy)
    transitions = rollout(policy)
    trainer.update(transitions)
    reference_before = {key: value.clone() for key, value in trainer.reference_policy.state_dict().items()}
    path = tmp_path / "anchored.pt"
    save_checkpoint(path, policy, trainer.optimizer, config=config, reference_policy=trainer.reference_policy)
    rng_before = torch.get_rng_state().clone()
    loaded = load_checkpoint(path)
    assert torch.equal(rng_before, torch.get_rng_state())
    expected_metrics = trainer.update(transitions)
    expected_state = {key: value.clone() for key, value in policy.state_dict().items()}
    loaded = load_checkpoint(path, restore_rng=True)
    assert loaded["reference_policy"] is not loaded["policy"]
    assert not any(parameter.requires_grad for parameter in loaded["reference_policy"].parameters())
    restored_trainer = PPOTrainer(loaded["policy"], loaded["config"], loaded["reference_policy"])
    restored_trainer.optimizer.load_state_dict(loaded["optimizer_state"])
    actual_metrics = restored_trainer.update(transitions)
    assert actual_metrics == expected_metrics
    assert_nested_equal(expected_state, restored_trainer.policy.state_dict())
    assert_nested_equal(reference_before, restored_trainer.reference_policy.state_dict())


@pytest.mark.parametrize("corruption", ["missing", "flag", "dimensions", "dimension_type", "nonfinite", "keys", "dtype"])
def test_bad_reference_checkpoint_rejected_before_loading_student(tmp_path, corruption):
    policy = Policy(4, 3, 16)
    path = tmp_path / "anchored.pt"
    save_checkpoint(path, policy, reference_policy=policy)
    checkpoint = torch.load(path, weights_only=True)
    reference = checkpoint["reference_policy"]
    if corruption == "missing":
        del checkpoint["reference_policy"]
    elif corruption == "flag":
        checkpoint["reference_present"] = False
    elif corruption == "dimensions":
        reference["policy_spec"]["hidden_dim"] = 32
    elif corruption == "dimension_type":
        reference["policy_spec"]["hidden_dim"] = 16.0
    elif corruption == "nonfinite":
        reference["policy_state"]["actor.bias"][0] = torch.nan
    elif corruption == "keys":
        del reference["policy_state"]["actor.bias"]
    elif corruption == "dtype":
        reference["policy_state"]["actor.bias"] = reference["policy_state"]["actor.bias"].double()
    torch.save(checkpoint, path)
    student = Policy(4, 3, 16)
    original = {key: value.clone() for key, value in student.state_dict().items()}
    with pytest.raises(ValueError, match="reference"):
        load_checkpoint(path, policy=student)
    assert_nested_equal(original, student.state_dict())


def test_saving_invalid_reference_preserves_existing_checkpoint(tmp_path):
    policy = Policy(4, 3, 16)
    path = tmp_path / "agent.pt"
    save_checkpoint(path, policy)
    original = path.read_bytes()
    with pytest.raises(ValueError, match="dimensions"):
        save_checkpoint(path, policy, reference_policy=Policy(4, 3, 32))
    with torch.no_grad():
        policy.actor.bias[0] = torch.nan
    with pytest.raises(ValueError, match="finite"):
        save_checkpoint(path, policy, reference_policy=policy)
    assert path.read_bytes() == original


def test_legacy_checkpoint_keeps_explicit_discount_and_loads_without_reference(tmp_path):
    path = tmp_path / "legacy.pt"
    save_checkpoint(path, Policy(4, 3, 16), config=PPOConfig(gamma=.99))
    checkpoint = torch.load(path, weights_only=True)
    checkpoint["schema_version"] = 1
    del checkpoint["reference_policy"]
    del checkpoint["reference_present"]
    del checkpoint["config"]["reference_kl_coef"]
    torch.save(checkpoint, path)
    loaded = load_checkpoint(path)
    assert loaded["schema_version"] == 1
    assert loaded["reference_policy"] is None
    assert loaded["config"].gamma == .99
