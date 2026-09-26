"""Replay-derived opening teachers for adversary imitation warm starts.

Source commands are human intentions, not proof that the original game
accepted each input. Teachers execute legal intentions in a fresh game, record
actual engine acceptance, and expose all omissions. They are removed for PPO.
"""
from __future__ import annotations

from collections import Counter
import math
import random

from pluto_sc2.adversary_schema import get_spec


def sample_builds(builds, count, *, seed=1, user_loss_weight=2.0):
    """Sample training replay IDs; wins over the user's Protoss get 2x mass.

    Weights apply once per build choice, not again to every imitation row.
    Validation is never sampled through this helper.
    """
    if type(count) is not int or count < 1 or not builds:
        raise ValueError("At least one training build and a positive count are required")
    if isinstance(user_loss_weight, bool) or not math.isfinite(user_loss_weight) or user_loss_weight < 1:
        raise ValueError("The user-loss build weight must be finite and at least one")
    weights = []
    seen = set()
    for build in builds:
        if build.get("partition") not in (None, "train"):
            raise ValueError("Held-out builds cannot be sampled for training")
        replay_id = build["replay_id"]
        if replay_id in seen:
            raise ValueError("Duplicate replay IDs would silently multiply build weights")
        seen.add(replay_id)
        result = build["user_result"]
        if result not in ("Victory", "Defeat", "Win", "Loss"):
            raise ValueError("Build sampling requires an explicit original user result")
        weights.append(user_loss_weight if result in ("Defeat", "Loss") else 1.0)
    return random.Random(seed).choices(builds, weights=weights, k=count)


class ReplayBuildTeacher:
    """Legal live-game execution of one opponent's early economic intentions."""

    def __init__(self, build, *, horizon_seconds=360, patience_seconds=90):
        self.build = build
        self.spec = get_spec(build["race"])
        self.indices = {name: index for index, name in enumerate(self.spec.action_names)}
        self.orders = []
        self.omissions = []
        self.completed = []
        self._pending = None
        self.horizon = float(horizon_seconds)
        self.patience = float(patience_seconds)
        if not 0 < self.horizon <= 1800 or not 0 < self.patience <= 600:
            raise ValueError("Invalid teacher opening horizon or patience")
        # Construction schedules use tracker correspondence to remove repeats.
        # Unit/research/morph commands can still be unconfirmed intentions;
        # their success is established only by this live teacher's execution.
        # Hand-built recipes may supply only an explicit order list.
        source_orders = build.get("teacher_orders", build.get("orders", []))
        for index, item in enumerate(source_orders):
            name, when = item.get("action"), item["game_seconds"]
            if not math.isfinite(when) or when < 0:
                raise ValueError("Build commands need finite nonnegative game times")
            if when > self.horizon:
                continue
            if name not in self.indices or not name.startswith(("build_", "train_", "morph_", "research_")):
                self.omissions.append({"order": index, "reason": "outside opening production vocabulary"})
                continue
            self.orders.append({**item, "source_index": index, "status": "pending"})
        self.orders.sort(key=lambda item: (item["game_seconds"], item["source_index"]))

    def __call__(self, bot, observation, mask):
        if bot.spec.race != self.spec.race:
            raise ValueError("Build teacher and learner races differ")
        self._pending = None
        now = float(bot.time)
        # Idle workers would otherwise make later source build intentions
        # unreachable. This is a declared teacher heuristic, not a PPO rule.
        idle = any(u.is_idle for u in bot.workers)
        if idle and mask[self.indices["harvest_minerals"]]:
            return self.indices["harvest_minerals"]
        pending = [item for item in self.orders if item["status"] == "pending"]
        for item in pending:
            if item["game_seconds"] > now:
                break
            index = self.indices[item["action"]]
            if mask[index]:
                self._pending = item
                return index
            if now - item["game_seconds"] > self.patience:
                item["status"] = "omitted"
                self.omissions.append({"order": item["source_index"], "reason": "unavailable beyond patience",
                                       "at": now})
        gas = self.indices["harvest_gas"]
        # The adapter assigns only to unsaturated owned gas buildings.
        if mask[gas] and any(item["game_seconds"] <= now + 30 for item in pending):
            return gas
        for name in ("inject_larva", "call_mule"):
            index = self.indices.get(name)
            if index is not None and mask[index]:
                return index
        return 0

    def on_action_result(self, action, accepted):
        if self._pending is not None and action == self.indices[self._pending["action"]] and accepted:
            self._pending["status"] = "accepted"
            self.completed.append(self._pending["source_index"])
        self._pending = None

    def report(self):
        return {"replay_id": self.build["replay_id"], "race": self.spec.race,
                "horizon_seconds": self.horizon, "patience_seconds": self.patience,
                "method": "replay command intentions with legal live execution and economic teacher fallbacks",
                "orders": len(self.orders), "status_counts": dict(Counter(item["status"] for item in self.orders)),
                "completed_source_indices": self.completed, "omissions": self.omissions,
                "fallbacks": ["idle workers gather", "gas saturation", "inject larvae", "call MULE"]}
