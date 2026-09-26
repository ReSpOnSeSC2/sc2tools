"""Masked actor-critic inference, PPO optimization, and portable checkpoints.

Observations are flat float vectors. The environment owns feature normalization
and history stacking. A mask contains one boolean (or 0/1 value) per action;
callers must provide at least one legal action, including their explicit wait
action when necessary. Checkpoints use PyTorch's restricted weights-only loader.
"""

from __future__ import annotations

import copy
from dataclasses import asdict, dataclass
import math
import numbers
import os
from pathlib import Path
import random
import tempfile
from typing import Any, Mapping, Sequence

import numpy as np
import torch
from torch import Tensor, nn
from torch.distributions import Categorical


CHECKPOINT_SCHEMA_VERSION = 2


def _positive_int(name: str, value: int) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{name} must be a positive integer")


def _finite_scalar(name: str, value: float) -> float:
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, numbers.Real):
        raise ValueError(f"{name} must be a finite number")
    try:
        result = float(value)
    except (ValueError, TypeError, OverflowError) as error:
        raise ValueError(f"{name} must be a finite number") from error
    if not math.isfinite(result):
        raise ValueError(f"{name} must be a finite number")
    return result


def _mask_tensor(mask: Any, *, device: torch.device, action_dim: int) -> Tensor:
    try:
        result = torch.as_tensor(mask, device=device)
    except (ValueError, TypeError, RuntimeError) as error:
        raise ValueError("action mask must contain boolean or 0/1 values") from error
    if result.ndim not in (1, 2) or result.shape[-1] != action_dim:
        raise ValueError(f"action mask must end in dimension {action_dim}")
    if result.is_complex() or not torch.all((result == 0) | (result == 1)).item():
        raise ValueError("action mask must contain only boolean or 0/1 values")
    result = result.bool()
    if not torch.all(result.any(dim=-1)).item():
        raise ValueError("each action mask must contain at least one legal action")
    return result


class Policy(nn.Module):
    """Two-layer actor-critic with an explicitly masked categorical policy.

    ``act`` and ``value`` accept one NumPy observation. ``evaluate`` accepts
    batches and returns action log probabilities, entropies, and state values.
    Move the module with ``.to(device)`` to select a training/inference device.
    """

    def __init__(self, input_dim: int, action_dim: int, hidden_dim: int = 256):
        super().__init__()
        for name, dimension in (
            ("input_dim", input_dim),
            ("action_dim", action_dim),
            ("hidden_dim", hidden_dim),
        ):
            _positive_int(name, dimension)
        self.input_dim = input_dim
        self.action_dim = action_dim
        self.hidden_dim = hidden_dim
        self.trunk = nn.Sequential(
            nn.Linear(input_dim, hidden_dim),
            nn.Tanh(),
            nn.Linear(hidden_dim, hidden_dim),
            nn.Tanh(),
        )
        self.actor = nn.Linear(hidden_dim, action_dim)
        self.critic = nn.Linear(hidden_dim, 1)
        for layer in self.trunk:
            if isinstance(layer, nn.Linear):
                nn.init.orthogonal_(layer.weight, math.sqrt(2))
                nn.init.zeros_(layer.bias)
        nn.init.orthogonal_(self.actor.weight, 0.01)
        nn.init.zeros_(self.actor.bias)
        nn.init.orthogonal_(self.critic.weight, 1.0)
        nn.init.zeros_(self.critic.bias)

    @property
    def device(self) -> torch.device:
        return next(self.parameters()).device

    def _observations(self, observations: Any) -> Tensor:
        try:
            result = torch.as_tensor(observations, device=self.device)
            if result.is_complex():
                raise ValueError("observations must be real numeric vectors")
            result = result.to(dtype=torch.float32)
        except (TypeError, ValueError, RuntimeError) as error:
            raise ValueError("observations must be finite numeric vectors") from error
        if result.ndim not in (1, 2) or result.shape[-1] != self.input_dim:
            raise ValueError(f"observations must end in dimension {self.input_dim}")
        if not torch.isfinite(result).all().item():
            raise ValueError("observations must be finite")
        return result

    def forward(self, observations: Tensor) -> tuple[Tensor, Tensor]:
        observations = self._observations(observations)
        features = self.trunk(observations)
        logits, values = self.actor(features), self.critic(features).squeeze(-1)
        if not torch.isfinite(logits).all().item() or not torch.isfinite(values).all().item():
            raise ValueError("policy produced non-finite logits or values")
        return logits, values

    def _distribution(self, logits: Tensor, masks: Any) -> Categorical:
        masks = _mask_tensor(masks, device=self.device, action_dim=self.action_dim)
        if masks.shape != logits.shape:
            raise ValueError("action masks must have the same shape as policy logits")
        return Categorical(logits=logits.masked_fill(~masks, -torch.inf))

    @torch.inference_mode()
    def act(
        self, observation: np.ndarray, mask: np.ndarray, deterministic: bool = False
    ) -> tuple[int, float, float]:
        observations = self._observations(observation)
        if observations.ndim != 1:
            raise ValueError("act expects exactly one observation")
        logits, value = self(observations)
        distribution = self._distribution(logits, mask)
        action = distribution.logits.argmax() if deterministic else distribution.sample()
        return int(action.item()), float(distribution.log_prob(action).item()), float(value.item())

    @torch.inference_mode()
    def value(self, observation: np.ndarray) -> float:
        observations = self._observations(observation)
        if observations.ndim != 1:
            raise ValueError("value expects exactly one observation")
        return float(self(observations)[1].item())

    def evaluate(
        self, observations: Tensor, masks: Tensor, actions: Tensor
    ) -> tuple[Tensor, Tensor, Tensor]:
        observations = self._observations(observations)
        if observations.ndim != 2 or observations.shape[0] == 0:
            raise ValueError("evaluate expects a nonempty batch of observations")
        logits, values = self(observations)
        distribution = self._distribution(logits, masks)
        actions = torch.as_tensor(actions, device=self.device)
        if actions.shape != observations.shape[:1]:
            raise ValueError("actions must have one element per observation")
        if actions.dtype == torch.bool or actions.is_complex() or actions.is_floating_point():
            raise ValueError("actions must be integer indices")
        actions = actions.long()
        if not torch.all((actions >= 0) & (actions < self.action_dim)).item():
            raise ValueError("an action index is outside the policy action space")
        legal = _mask_tensor(masks, device=self.device, action_dim=self.action_dim)
        if not legal.gather(1, actions.unsqueeze(1)).all().item():
            raise ValueError("cannot evaluate an action excluded by its action mask")
        return distribution.log_prob(actions), distribution.entropy(), values


@dataclass(frozen=True)
class Transition:
    observation: np.ndarray
    mask: np.ndarray
    action: int
    log_prob: float
    value: float
    reward: float
    next_value: float
    terminated: bool
    truncated: bool


@dataclass(frozen=True)
class PPOConfig:
    learning_rate: float = 3e-4
    gamma: float = 1.0
    gae_lambda: float = 0.95
    clip_range: float = 0.2
    epochs: int = 4
    minibatch_size: int = 64
    entropy_coef: float = 0.01
    value_coef: float = 0.5
    max_grad_norm: float = 0.5
    target_kl: float | None = 0.03
    reference_kl_coef: float = 0.01

    def __post_init__(self) -> None:
        for name in ("epochs", "minibatch_size"):
            _positive_int(name, getattr(self, name))
        for name in ("gamma", "gae_lambda"):
            if not 0 <= _finite_scalar(name, getattr(self, name)) <= 1:
                raise ValueError(f"{name} must be between zero and one")
        for name in ("learning_rate", "max_grad_norm"):
            if _finite_scalar(name, getattr(self, name)) <= 0:
                raise ValueError(f"{name} must be positive")
        if not 0 < _finite_scalar("clip_range", self.clip_range) < 1:
            raise ValueError("clip_range must be between zero and one (exclusive)")
        for name in ("entropy_coef", "value_coef", "reference_kl_coef"):
            if _finite_scalar(name, getattr(self, name)) < 0:
                raise ValueError(f"{name} must be nonnegative")
        if self.target_kl is not None and _finite_scalar("target_kl", self.target_kl) <= 0:
            raise ValueError("target_kl must be positive or None")
        for name in ("learning_rate", "gamma", "gae_lambda", "clip_range", "entropy_coef", "value_coef", "max_grad_norm", "reference_kl_coef"):
            object.__setattr__(self, name, float(getattr(self, name)))
        if self.target_kl is not None:
            object.__setattr__(self, "target_kl", float(self.target_kl))


def compute_gae(
    transitions: Sequence[Transition], gamma: float = 1.0, gae_lambda: float = 0.95
) -> tuple[np.ndarray, np.ndarray]:
    """Return unnormalized advantages and value targets in temporal order.

    A true terminal state has zero bootstrap value. A time-limit truncation
    bootstraps from ``next_value`` but stops propagation into the next episode.
    The last nonterminal rollout step also bootstraps from ``next_value``.
    """
    for name, parameter in (("gamma", gamma), ("gae_lambda", gae_lambda)):
        if not 0 <= _finite_scalar(name, parameter) <= 1:
            raise ValueError(f"{name} must be between zero and one")
    gamma, gae_lambda = float(gamma), float(gae_lambda)
    if not transitions:
        raise ValueError("at least one transition is required")
    advantages = np.empty(len(transitions), dtype=np.float64)
    values = np.empty(len(transitions), dtype=np.float64)
    next_advantage = 0.0
    for index in range(len(transitions) - 1, -1, -1):
        transition = transitions[index]
        if not isinstance(transition, Transition):
            raise ValueError("rollouts must contain Transition instances")
        if not isinstance(transition.terminated, (bool, np.bool_)) or not isinstance(
            transition.truncated, (bool, np.bool_)
        ):
            raise ValueError("terminated and truncated must be boolean")
        reward = _finite_scalar("reward", transition.reward)
        value = _finite_scalar("value", transition.value)
        next_value = _finite_scalar("next_value", transition.next_value)
        bootstrap = 0.0 if transition.terminated else next_value
        delta = reward + gamma * bootstrap - value
        continuation = not (transition.terminated or transition.truncated)
        next_advantage = delta + gamma * gae_lambda * float(continuation) * next_advantage
        advantages[index], values[index] = next_advantage, value
    returns = advantages + values
    if (
        not np.isfinite(advantages).all()
        or not np.isfinite(returns).all()
        or np.abs(advantages).max() > np.finfo(np.float32).max
        or np.abs(returns).max() > np.finfo(np.float32).max
    ):
        raise ValueError("rollout advantages or returns exceed finite float32 range")
    return advantages.astype(np.float32), returns.astype(np.float32)


def _policy_spec(policy: Policy) -> dict[str, int]:
    if not isinstance(policy, Policy):
        raise TypeError("policy must be Policy")
    return {name: getattr(policy, name) for name in ("input_dim", "action_dim", "hidden_dim")}


def _validate_reference(policy: Policy, reference_policy: Policy) -> None:
    if _policy_spec(reference_policy) != _policy_spec(policy):
        raise ValueError("reference policy dimensions must match the training policy")
    if any(not torch.isfinite(value).all().item() for value in reference_policy.state_dict().values()):
        raise ValueError("reference policy parameters must be finite")


class PPOTrainer:
    """PPO with optional frozen imitation-reference regularization.

    The reference is cloned, frozen, and evaluated on the same observations and
    legal actions as the learner. Its masked forward KL, D_KL(reference||policy),
    is an AlphaStar-inspired adaptation to this PPO learner. No reference means
    ordinary PPO, even when ``reference_kl_coef`` is nonzero.
    """

    def __init__(
        self, policy: Policy, config: PPOConfig | None = None,
        reference_policy: Policy | None = None,
    ):
        self.policy = policy
        self.config = config or PPOConfig()
        if not isinstance(self.config, PPOConfig):
            raise TypeError("config must be PPOConfig")
        self.reference_policy: Policy | None = None
        if reference_policy is not None:
            _validate_reference(policy, reference_policy)
            self.reference_policy = copy.deepcopy(reference_policy).to(policy.device)
            self.reference_policy.eval().requires_grad_(False)
        self.optimizer = torch.optim.Adam(policy.parameters(), lr=self.config.learning_rate, eps=1e-5)

    def update(self, transitions: Sequence[Transition]) -> dict[str, float]:
        advantages_np, returns_np = compute_gae(
            transitions, self.config.gamma, self.config.gae_lambda
        )
        observations_list, masks_list, actions_list, log_probs_list, values_list = [], [], [], [], []
        for transition in transitions:
            observation = self.policy._observations(transition.observation)
            if observation.ndim != 1:
                raise ValueError("each transition must contain one observation")
            mask = _mask_tensor(
                transition.mask, device=self.policy.device, action_dim=self.policy.action_dim
            )
            if mask.ndim != 1:
                raise ValueError("each transition must contain one action mask")
            action = transition.action
            if isinstance(action, (bool, np.bool_)) or not isinstance(action, (int, np.integer)):
                raise ValueError("transition action must be an integer index")
            if not 0 <= action < self.policy.action_dim or not mask[action].item():
                raise ValueError("transition action must be legal under its stored mask")
            log_prob = _finite_scalar("log_prob", transition.log_prob)
            if log_prob > 1e-6:
                raise ValueError("categorical action log_prob cannot be positive")
            observations_list.append(observation)
            masks_list.append(mask)
            actions_list.append(action)
            log_probs_list.append(log_prob)
            values_list.append(transition.value)
        device = self.policy.device
        observations = torch.stack(observations_list).detach()
        masks = torch.stack(masks_list)
        actions = torch.tensor(actions_list, dtype=torch.long, device=device)
        old_log_probs = torch.tensor(log_probs_list, dtype=torch.float32, device=device)
        old_values = torch.tensor(values_list, dtype=torch.float32, device=device)
        advantages = torch.as_tensor(advantages_np, device=device)
        returns = torch.as_tensor(returns_np, device=device)
        if not torch.isfinite(old_log_probs).all() or not torch.isfinite(old_values).all():
            raise ValueError("stored log probabilities and values must fit finite float32")
        if len(transitions) > 1:
            # Compute moments in float64 to avoid overflowing for finite targets.
            advantage64 = advantages.double()
            advantages = ((advantage64 - advantage64.mean()) / (advantage64.std(unbiased=False) + 1e-8)).float()
        reference_logits = None
        reference_enabled = self.reference_policy is not None and self.config.reference_kl_coef > 0
        if reference_enabled:
            # Validate the entire teacher batch before changing learner weights.
            # This reference remains fixed across all PPO epochs and minibatches.
            with torch.no_grad():
                self.reference_policy.to(device).eval()
                reference_logits = self.reference_policy(observations)[0].detach()
        totals = {name: 0.0 for name in ("policy_loss", "value_loss", "entropy", "approx_kl", "clip_fraction", "grad_norm", "reference_kl")}
        samples_processed = 0
        updates = 0
        early_stop = False
        cfg = self.config
        self.policy.train()
        for _ in range(cfg.epochs):
            permutation = torch.randperm(len(transitions), device=device)
            for start in range(0, len(transitions), cfg.minibatch_size):
                indices = permutation[start : start + cfg.minibatch_size]
                log_probs, entropies, values = self.policy.evaluate(
                    observations[indices], masks[indices], actions[indices]
                )
                log_ratio = log_probs - old_log_probs[indices]
                ratios = log_ratio.exp()
                if not torch.isfinite(ratios).all().item():
                    raise ValueError("non-finite PPO probability ratio; check stored policy log probabilities")
                with torch.no_grad():
                    approx_kl = ((ratios - 1) - log_ratio).mean()
                    clip_fraction = ((ratios - 1).abs() > cfg.clip_range).float().mean()
                if cfg.target_kl is not None and approx_kl.item() > 1.5 * cfg.target_kl:
                    early_stop = True
                    break
                surrogate = ratios * advantages[indices]
                clipped_surrogate = ratios.clamp(1 - cfg.clip_range, 1 + cfg.clip_range) * advantages[indices]
                policy_loss = -torch.minimum(surrogate, clipped_surrogate).mean()
                clipped_values = old_values[indices] + (values - old_values[indices]).clamp(-cfg.clip_range, cfg.clip_range)
                value_loss = 0.5 * torch.maximum(
                    (values - returns[indices]).square(),
                    (clipped_values - returns[indices]).square(),
                ).mean()
                entropy = entropies.mean()
                reference_kl = torch.zeros((), device=device)
                if reference_logits is not None:
                    reference_distribution = self.policy._distribution(reference_logits[indices], masks[indices])
                    current_distribution = self.policy._distribution(self.policy(observations[indices])[0], masks[indices])
                    reference_kl = torch.distributions.kl_divergence(reference_distribution, current_distribution).mean()
                loss = (
                    policy_loss + cfg.value_coef * value_loss - cfg.entropy_coef * entropy
                    + cfg.reference_kl_coef * reference_kl
                )
                if not torch.isfinite(loss).item():
                    raise ValueError("PPO loss is non-finite; check rollout reward and value scales")
                self.optimizer.zero_grad(set_to_none=True)
                loss.backward()
                grad_norm = nn.utils.clip_grad_norm_(self.policy.parameters(), cfg.max_grad_norm, error_if_nonfinite=True)
                self.optimizer.step()
                count = len(indices)
                samples_processed += count
                updates += 1
                for name, metric in (
                    ("policy_loss", policy_loss), ("value_loss", value_loss),
                    ("entropy", entropy), ("approx_kl", approx_kl),
                    ("clip_fraction", clip_fraction), ("grad_norm", grad_norm),
                    ("reference_kl", reference_kl),
                ):
                    totals[name] += float(metric.detach().item()) * count
            if early_stop:
                break
        metrics = {key: total / max(samples_processed, 1) for key, total in totals.items()}
        return_variance = float(np.var(returns_np.astype(np.float64)))
        residual_variance = float(np.var(returns_np.astype(np.float64) - old_values.cpu().numpy().astype(np.float64)))
        metrics.update(
            explained_variance=(1 - residual_variance / return_variance) if return_variance > 1e-12 else 0.0,
            mean_reward=float(np.mean([transition.reward for transition in transitions], dtype=np.float64)),
            mean_return=float(np.mean(returns_np, dtype=np.float64)),
            transitions=float(len(transitions)),
            optimizer_steps=float(updates),
            early_stop=float(early_stop),
            reference_enabled=float(reference_enabled),
        )
        return metrics


def _json_data(value: Any, name: str = "metadata") -> Any:
    """Validate data without accepting custom classes into checkpoint payloads."""
    if value is None or type(value) in (str, bool, int):
        return value
    if type(value) is float and math.isfinite(value):
        return value
    if type(value) in (list, tuple):
        return [_json_data(item, name) for item in value]
    if type(value) is dict and all(type(key) is str for key in value):
        return {key: _json_data(item, name) for key, item in value.items()}
    raise ValueError(f"{name} must contain only finite JSON-compatible data with string keys")


def _counters(value: Mapping[str, int] | None) -> dict[str, int]:
    result = {} if value is None else dict(value)
    if any(type(key) is not str or type(count) is not int or count < 0 for key, count in result.items()):
        raise ValueError("checkpoint counters must map strings to nonnegative integers")
    return result


def _rng_state() -> dict[str, Any]:
    numpy_state = np.random.get_state()
    return {
        "python": random.getstate(),
        "numpy": {
            "algorithm": numpy_state[0],
            "keys": torch.from_numpy(numpy_state[1].astype(np.int64)),
            "position": numpy_state[2],
            "has_gauss": numpy_state[3],
            "cached_gaussian": numpy_state[4],
        },
        "torch": torch.get_rng_state(),
        "cuda": torch.cuda.get_rng_state_all() if torch.cuda.is_available() else [],
    }


def save_checkpoint(
    path: str | Path,
    policy: Policy,
    optimizer: torch.optim.Optimizer | None = None,
    metadata: dict[str, Any] | None = None,
    counters: Mapping[str, int] | None = None,
    config: PPOConfig | None = None,
    reference_policy: Policy | None = None,
) -> None:
    """Atomically write parameters, optional optimizer/config, counters and RNG.

    Include feature/action schema identifiers in ``metadata``. Consumers must
    check these identifiers before using a checkpoint with an environment.
    Include the trainer's ``reference_policy`` when using imitation anchoring;
    its independent weights make the checkpoint sufficient to resume the anchor.
    A temporary file is flushed and synchronized before replacing the target.
    """
    reference_payload = None
    if reference_policy is not None:
        _validate_reference(policy, reference_policy)
        reference_payload = {
            "policy_spec": _policy_spec(reference_policy),
            "policy_state": {key: value.detach().cpu().clone() for key, value in reference_policy.state_dict().items()},
        }
    checkpoint = {
        "schema_version": CHECKPOINT_SCHEMA_VERSION,
        "policy_spec": _policy_spec(policy),
        "policy_state": {key: value.detach().cpu().clone() for key, value in policy.state_dict().items()},
        "reference_policy": reference_payload,
        "reference_present": reference_payload is not None,
        "optimizer_state": None if optimizer is None else optimizer.state_dict(),
        "metadata": _json_data({} if metadata is None else metadata),
        "counters": _counters(counters),
        "config": None if config is None else asdict(config),
        "rng_state": _rng_state(),
    }
    if any(not torch.isfinite(value).all().item() for value in checkpoint["policy_state"].values()):
        raise ValueError("cannot save non-finite policy parameters")
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(mode="wb", prefix=f".{path.name}.", suffix=".tmp", dir=path.parent, delete=False) as stream:
            temporary_path = Path(stream.name)
            torch.save(checkpoint, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()


def _restore_rng(state: dict[str, Any]) -> None:
    try:
        python_state = state["python"]
        random.Random().setstate(python_state)
        numpy_saved = state["numpy"]
        numpy_state = (
            numpy_saved["algorithm"], numpy_saved["keys"].cpu().numpy().astype(np.uint32),
            numpy_saved["position"], numpy_saved["has_gauss"], numpy_saved["cached_gaussian"],
        )
        np.random.RandomState().set_state(numpy_state)
        torch.Generator(device="cpu").set_state(state["torch"])
        cuda_states = state.get("cuda", [])
        if cuda_states and torch.cuda.is_available() and len(cuda_states) != torch.cuda.device_count():
            raise ValueError("CUDA device count differs from the saved RNG state")
    except (KeyError, TypeError, ValueError, RuntimeError, AttributeError) as error:
        raise ValueError("invalid checkpoint RNG state") from error
    random.setstate(python_state)
    np.random.set_state(numpy_state)
    torch.set_rng_state(state["torch"])
    if cuda_states and torch.cuda.is_available():
        torch.cuda.set_rng_state_all(cuda_states)


def _stage_policy(spec: dict[str, int], state: Any, name: str) -> Policy:
    # Initialization must not consume the caller's RNG when merely loading.
    with torch.random.fork_rng(devices=[]):
        staged_policy = Policy(**spec)
    template = staged_policy.state_dict()
    if not isinstance(state, dict) or state.keys() != template.keys():
        raise ValueError(f"checkpoint {name} parameters are missing or unexpected")
    for key, tensor in state.items():
        if (
            not isinstance(tensor, Tensor) or tensor.shape != template[key].shape
            or tensor.dtype != template[key].dtype or not torch.isfinite(tensor).all().item()
        ):
            raise ValueError(f"invalid checkpoint {name} parameter: {key}")
    staged_policy.load_state_dict(state, strict=True)
    return staged_policy


def load_checkpoint(
    path: str | Path,
    policy: Policy | None = None,
    optimizer: torch.optim.Optimizer | None = None,
    expected_input_dim: int | None = None,
    expected_action_dim: int | None = None,
    restore_rng: bool = False,
) -> dict[str, Any]:
    """Load with ``weights_only=True`` and validate before replacing weights.

    Returns ``policy``, ``metadata``, ``counters``, ``config`` (PPOConfig or
    None), ``reference_policy`` (a frozen Policy or None), ``optimizer_state``
    and ``schema_version``. If provided, the policy
    must exactly match all saved dimensions. Pass an optimizer to restore it;
    callers can alternatively restore returned optimizer_state after creating
    their trainer. ``restore_rng=True`` resumes Python, NumPy and Torch RNGs.
    """
    if optimizer is not None and policy is None:
        raise ValueError("restoring an optimizer requires its corresponding policy")
    checkpoint = torch.load(Path(path), map_location="cpu", weights_only=True)
    if not isinstance(checkpoint, dict) or checkpoint.get("schema_version") not in (1, CHECKPOINT_SCHEMA_VERSION):
        raise ValueError("unsupported checkpoint schema_version")
    spec = checkpoint.get("policy_spec")
    if not isinstance(spec, dict) or set(spec) != {"input_dim", "action_dim", "hidden_dim"}:
        raise ValueError("checkpoint policy dimensions are missing or invalid")
    for name, dimension in spec.items():
        _positive_int(name, dimension)
    for name, expected in (("input_dim", expected_input_dim), ("action_dim", expected_action_dim)):
        if expected is not None:
            _positive_int(f"expected_{name}", expected)
            if spec[name] != expected:
                raise ValueError(f"checkpoint {name}={spec[name]} does not match expected {expected}")
    if policy is not None and any(getattr(policy, name) != dimension for name, dimension in spec.items()):
        raise ValueError("checkpoint dimensions do not match supplied policy")
    metadata = _json_data(checkpoint.get("metadata", {}))
    if not isinstance(metadata, dict):
        raise ValueError("checkpoint metadata must be a dictionary")
    counters = _counters(checkpoint.get("counters", {}))
    config_data = checkpoint.get("config")
    try:
        config = None if config_data is None else PPOConfig(**config_data)
    except TypeError as error:
        raise ValueError("invalid checkpoint PPO config") from error
    state = checkpoint.get("policy_state")
    staged_policy = _stage_policy(spec, state, "policy")
    reference_payload = checkpoint.get("reference_policy")
    reference_present = checkpoint.get("reference_present", False)
    if checkpoint["schema_version"] == 2:
        if (
            "reference_policy" not in checkpoint or "reference_present" not in checkpoint
            or not isinstance(reference_present, bool)
            or reference_present != (reference_payload is not None)
        ):
            raise ValueError("checkpoint reference policy is missing or inconsistent")
    elif reference_payload is not None or reference_present:
        raise ValueError("legacy checkpoint cannot contain a reference policy")
    reference_policy = None
    if reference_payload is not None:
        if not isinstance(reference_payload, dict) or set(reference_payload) != {"policy_spec", "policy_state"}:
            raise ValueError("checkpoint reference policy is malformed")
        reference_spec = reference_payload["policy_spec"]
        if not isinstance(reference_spec, dict) or set(reference_spec) != set(spec):
            raise ValueError("checkpoint reference policy dimensions are invalid")
        if any(isinstance(value, bool) or not isinstance(value, int) or value <= 0 for value in reference_spec.values()):
            raise ValueError("checkpoint reference policy dimensions must be positive integers")
        if reference_spec != spec:
            raise ValueError("checkpoint reference policy dimensions differ from policy")
        reference_policy = _stage_policy(spec, reference_payload["policy_state"], "reference policy")
        reference_policy.eval().requires_grad_(False)
    optimizer_state = checkpoint.get("optimizer_state")
    if optimizer is not None:
        if optimizer_state is None:
            raise ValueError("checkpoint contains no optimizer state")
        try:
            copy.deepcopy(optimizer).load_state_dict(optimizer_state)
        except (KeyError, TypeError, ValueError, RuntimeError) as error:
            raise ValueError("checkpoint optimizer state is incompatible") from error
    if restore_rng:
        _restore_rng(checkpoint.get("rng_state", {}))
    loaded_policy = staged_policy if policy is None else policy
    if policy is not None:
        policy.load_state_dict(state, strict=True)
    if optimizer is not None:
        optimizer.load_state_dict(optimizer_state)
    return {
        "policy": loaded_policy, "metadata": metadata, "counters": counters,
        "config": config, "optimizer_state": optimizer_state,
        "reference_policy": reference_policy,
        "schema_version": checkpoint["schema_version"],
    }
