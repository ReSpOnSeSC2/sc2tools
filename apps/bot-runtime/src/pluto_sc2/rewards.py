"""Auditable, bounded training rewards from information the player can observe.

This module never reads an SC2 score table or raw world state.  The adapter must
provide only own economy/assets and enemies permitted by that agent's camera
and fog rules.  ``confirmed_dead_tags`` is an explicit observation, not a list
inferred from units disappearing.  Reward is training feedback, never a ladder
rating.  Selections, camera moves, orders and action attempts earn nothing.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
import math
from typing import Mapping


REWARD_VERSION = "tactical-economy-v1"
_CATEGORIES = frozenset(("worker", "army", "structure", "expansion", "upgrade"))


def _number(name: str, value: float, *, nonnegative: bool = True) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite number")
    number = float(value)
    if not math.isfinite(number) or (nonnegative and number < 0):
        raise ValueError(f"{name} must be finite and nonnegative")
    return number


@dataclass(frozen=True)
class RewardConfig:
    """Coefficients and lifetime absolute budgets, stored with each match.

    Budgets are separate: harvesting cannot consume the combat allowance.
    Total auxiliary *absolute* reward is at most four; with +/-10 outcomes,
    even the best shaped loss cannot outrank the worst shaped win or draw in
    undiscounted episode return. Discounted training returns also depend on
    the trainer's discount factor and horizon.
    """

    version: str = REWARD_VERSION
    terminal_win: float = 10.0
    terminal_loss: float = -10.0
    terminal_draw: float = 0.0
    gas_value: float = 1.5
    mined_mineral_coefficient: float = 0.00004
    mined_gas_coefficient: float = 0.00006
    worker_coefficient: float = 0.0008
    army_coefficient: float = 0.0006
    structure_coefficient: float = 0.0005
    expansion_coefficient: float = 0.0003
    upgrade_coefficient: float = 0.0004
    combat_coefficient: float = 0.001
    economic_damage_multiplier: float = 1.25
    first_enemy_base_reward: float = 0.35
    new_enemy_type_reward: float = 0.04
    counter_army_coefficient: float = 0.0002
    replay_progress_coefficient: float = 0.3
    supply_blocked_per_second: float = 0.0001
    idle_worker_per_second: float = 0.00002
    idle_production_per_second: float = 0.00004
    mining_budget: float = 0.35
    completion_budget: float = 1.2
    combat_budget: float = 1.3
    macro_budget: float = 0.25
    intel_budget: float = 0.6
    replay_budget: float = 0.3
    # Opt-in v2 feedback from the ordinary resource/supply HUD. Never pay for
    # merely issuing a spend/cancel command or reducing the bank.
    unspent_resources_per_second: float = 0.0
    bank_mineral_reserve: float = 400.0
    bank_gas_reserve: float = 200.0
    bank_grace_seconds: float = 20.0
    bank_budget: float = 0.0

    def __post_init__(self) -> None:
        if self.version not in {REWARD_VERSION, "tactical-economy-v2"}:
            raise ValueError(f"unsupported reward version: {self.version}")
        for name, value in asdict(self).items():
            if name == "version":
                continue
            _number(name, value, nonnegative=name not in ("terminal_loss", "terminal_draw"))
        if self.auxiliary_budget > 4.0 + 1e-12:
            raise ValueError("episode auxiliary absolute budget must be at most 4")
        if self.version == REWARD_VERSION and (self.bank_budget or self.unspent_resources_per_second):
            raise ValueError("bank feedback requires tactical-economy-v2")
        if self.bank_mineral_reserve <= 0 or self.bank_gas_reserve <= 0:
            raise ValueError("resource reserves must be positive")
        if not self.terminal_win > self.terminal_draw > self.terminal_loss:
            raise ValueError("outcome rewards must order victory > draw > defeat")
        gap = min(self.terminal_win - self.terminal_draw, self.terminal_draw - self.terminal_loss)
        if gap <= 2 * self.auxiliary_budget:
            raise ValueError("outcome rewards must dominate all auxiliary reward differences")

    @property
    def auxiliary_budget(self) -> float:
        return (self.mining_budget + self.completion_budget + self.combat_budget
                + self.macro_budget + self.intel_budget + self.replay_budget + self.bank_budget)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, values: Mapping) -> RewardConfig:
        return cls(**dict(values))


@dataclass(frozen=True)
class RewardAsset:
    """One known asset. Costs exclude refunds and count gas at config.gas_value.

    Own assets must include only actual units/structures or completed upgrades;
    exclude larvae, eggs, temporary summons, hallucinations and projectiles.
    Use stable negative tags for upgrades, distinct from real unit tags.
    """

    tag: int
    mineral_cost: float
    gas_cost: float
    category: str
    health: float = 1.0
    health_max: float = 1.0
    shields: float = 0.0
    shields_max: float = 0.0
    completed: bool = True
    type_id: str = ""
    counter_match: bool = False

    def __post_init__(self) -> None:
        if isinstance(self.tag, bool) or not isinstance(self.tag, int):
            raise ValueError("asset tag must be an integer")
        if self.category not in _CATEGORIES:
            raise ValueError(f"unsupported asset category: {self.category}")
        for name in ("mineral_cost", "gas_cost", "health", "health_max", "shields", "shields_max"):
            _number(name, getattr(self, name))
        if not isinstance(self.completed, bool) or not isinstance(self.type_id, str):
            raise ValueError("completed must be boolean and type_id must be a string")
        if not isinstance(self.counter_match, bool):
            raise ValueError("counter_match must be boolean")

    @property
    def durability_fraction(self) -> float:
        maximum = self.health_max + self.shields_max
        return min(1.0, (self.health + self.shields) / maximum) if maximum else 1.0

    def value(self, config: RewardConfig) -> float:
        return self.mineral_cost + self.gas_cost * config.gas_value


@dataclass(frozen=True)
class RewardSnapshot:
    """Allowed observation and verified changes derived by the adapter.

    ``replay_progress`` is positive coverage gain from before/after own-asset
    counts compared against the *same current reference frame*. Advancing the
    reference clock cannot itself cause gain. ``replay_similarity`` is audit
    information only: phase-dependent coverage can begin at one and fall as
    the target advances, so its lifetime high-water is not a reward signal.
    """
    game_time: float
    collected_minerals: float | None = None
    collected_gas: float | None = None
    own_assets: tuple[RewardAsset, ...] = ()
    visible_enemies: tuple[RewardAsset, ...] = ()
    confirmed_dead_tags: frozenset[int] = frozenset()
    supply_blocked: bool = False
    idle_workers: int = 0
    idle_production: int = 0
    replay_similarity: float | None = None
    replay_progress: float = 0.0
    minerals: float | None = None
    vespene: float | None = None
    supply_used: float | None = None

    def __post_init__(self) -> None:
        _number("game_time", self.game_time)
        for name in ("collected_minerals", "collected_gas", "minerals", "vespene", "supply_used"):
            value = getattr(self, name)
            if value is not None:
                _number(name, value)
        for name in ("idle_workers", "idle_production"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"{name} must be a nonnegative integer")
        if not isinstance(self.supply_blocked, bool):
            raise ValueError("supply_blocked must be boolean")
        if self.replay_similarity is not None:
            _number("replay_similarity", self.replay_similarity)
            if self.replay_similarity > 1:
                raise ValueError("replay_similarity must be between 0 and 1")
        _number("replay_progress", self.replay_progress)
        if self.replay_progress > 1:
            raise ValueError("replay_progress must be between 0 and 1")
        own_tags = [asset.tag for asset in self.own_assets]
        enemy_tags = [asset.tag for asset in self.visible_enemies]
        if len(set(own_tags)) != len(own_tags) or len(set(enemy_tags)) != len(enemy_tags):
            raise ValueError("snapshot asset tags must be unique within each side")
        if set(own_tags) & set(enemy_tags):
            raise ValueError("an asset cannot be both own and enemy")
        if any(isinstance(tag, bool) or not isinstance(tag, int) for tag in self.confirmed_dead_tags):
            raise ValueError("confirmed dead tags must be integers")


@dataclass(frozen=True)
class RewardResult:
    total: float
    components: dict[str, float]
    auxiliary_used: float
    raw_components: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class _EnemyLedger:
    asset: RewardAsset
    minimum_fraction: float
    credited_value: float = 0.0
    dead: bool = False


class RewardEngine:
    """One engine per episode; call update before actions and finish once.

    First observation establishes resource and starting-asset baselines. A
    unit leaving sight has no effect. Health/shield damage is credited only
    below that target's previous minimum fraction; healing cannot reset it.
    A confirmed kill earns only the target value not credited as damage.
    Own losses subtract cost directly, avoiding unstable kill/loss ratios.
    """

    def __init__(self, config: RewardConfig | None = None):
        self.config = config or RewardConfig()
        self._previous: RewardSnapshot | None = None
        self._collected: dict[str, float] = {}
        self._own: dict[int, RewardAsset] = {}
        self._completed: set[int] = set()
        self._dead_own: set[int] = set()
        self._enemies: dict[int, _EnemyLedger] = {}
        self._discovered_types: set[tuple[str, str]] = set()
        self._found_enemy_base = False
        self._spent = {group: 0.0 for group in ("mining", "completion", "combat", "macro", "intel", "replay", "bank")}
        self._bank_since: float | None = None
        self._totals: dict[str, float] = {}
        self._raw_totals: dict[str, float] = {}
        self._event_counts: dict[str, int] = {}
        self._signal_totals: dict[str, float] = {}
        self._replay_high_water: float | None = None
        self._finished = False
        self._terminal: float | None = None
        self._terminal_correction = 0.0

    @property
    def auxiliary_used(self) -> float:
        return sum(self._spent.values())

    def summary(self) -> dict:
        return {
            "config": self.config.to_dict(),
            "components": dict(self._totals),
            "raw_components": dict(self._raw_totals),
            "event_counts": dict(self._event_counts),
            "signal_totals": dict(self._signal_totals),
            "replay_similarity_high_water": self._replay_high_water,
            "absolute_budget_used": dict(self._spent),
            "auxiliary_used": self.auxiliary_used,
            "terminal_reward": self._terminal,
            "terminal_correction": self._terminal_correction,
            "total": sum(self._totals.values()) + (self._terminal or 0.0),
        }

    def update(self, snapshot: RewardSnapshot) -> RewardResult:
        if self._finished:
            raise RuntimeError("cannot update rewards after finish")
        previous = self._previous
        if previous is not None and snapshot.game_time < previous.game_time:
            raise ValueError("reward snapshot time must be monotonic")
        groups: dict[str, dict[str, float]] = {group: {} for group in self._spent}
        config = self.config

        def add(group: str, key: str, value: float) -> None:
            if value:
                groups[group][key] = groups[group].get(key, 0.0) + value

        def event(name: str, amount: float | None = None) -> None:
            self._event_counts[name] = self._event_counts.get(name, 0) + 1
            if amount is not None:
                self._signal_totals[name] = self._signal_totals.get(name, 0.0) + amount

        for field_name, coefficient, key in (
            ("collected_minerals", config.mined_mineral_coefficient, "mined_minerals"),
            ("collected_gas", config.mined_gas_coefficient, "mined_gas"),
        ):
            amount = getattr(snapshot, field_name)
            if amount is None:
                continue
            old = self._collected.get(field_name, amount)
            delta = max(0.0, amount - old)
            add("mining", key, delta * coefficient)
            if delta:
                event(key, delta)
            self._collected[field_name] = max(old, amount)

        new_completed_asset = False
        for asset in snapshot.own_assets:
            self._own[asset.tag] = asset
            if not asset.completed or asset.tag in self._completed or asset.tag in self._dead_own:
                continue
            self._completed.add(asset.tag)
            if previous is not None:
                new_completed_asset = True
                coefficient = getattr(config, f"{asset.category}_coefficient")
                add("completion", f"completed_{asset.category}", asset.value(config) * coefficient)
                event(f"completed_{asset.category}", asset.value(config))
                if asset.category == "army" and asset.counter_match:
                    add("completion", "completed_counter_army", asset.value(config) * config.counter_army_coefficient)
                    event("completed_counter_army", asset.value(config))

        # Coverage is phase-dependent. Its high-water is audit information,
        # while shaping uses explicit before/after gain against the SAME frame.
        # The independent completion ledger prevents replaying a gain without
        # producing an actual new asset, even if the adapter repeats a delta.
        if snapshot.replay_similarity is not None:
            score = snapshot.replay_similarity
            old_score = score if self._replay_high_water is None else self._replay_high_water
            self._replay_high_water = max(old_score, score)
        if new_completed_asset and snapshot.replay_progress:
            progress = snapshot.replay_progress
            add("replay", "replay_composition_progress", progress * config.replay_progress_coefficient)
            event("replay_composition_progress", progress)

        # A target is learned only from the caller's currently permitted sight.
        for asset in snapshot.visible_enemies:
            if asset.category == "expansion" and not self._found_enemy_base:
                self._found_enemy_base = True
                add("intel", "first_enemy_base", config.first_enemy_base_reward)
                event("first_enemy_base")
            novelty = (asset.category, asset.type_id)
            # Base discovery has its own once-per-game bonus. Do not also use
            # type-novelty allowance on that same townhall or its later morphs.
            if asset.type_id and asset.category in ("army", "structure"):
                if novelty not in self._discovered_types:
                    self._discovered_types.add(novelty)
                    add("intel", "new_enemy_type", config.new_enemy_type_reward)
                    event("new_enemy_type")
            ledger = self._enemies.get(asset.tag)
            if ledger is None:
                self._enemies[asset.tag] = _EnemyLedger(asset, asset.durability_fraction)
                continue
            if ledger.dead:
                continue
            old_asset = ledger.asset
            # Morphs and changes to maximum durability are not damage events.
            same_form = (
                old_asset.type_id == asset.type_id
                and old_asset.health_max + old_asset.shields_max == asset.health_max + asset.shields_max
            )
            if same_form:
                lost_fraction = max(0.0, ledger.minimum_fraction - asset.durability_fraction)
                remaining = max(0.0, asset.value(config) - ledger.credited_value)
                credit = min(remaining, lost_fraction * asset.value(config))
                ledger.credited_value += credit
                ledger.minimum_fraction = min(ledger.minimum_fraction, asset.durability_fraction)
                add("combat", self._damage_key(asset), credit * self._combat_coefficient(asset))
                if credit:
                    event(self._damage_key(asset), credit)
            else:
                ledger.minimum_fraction = asset.durability_fraction
            ledger.asset = asset

        for tag in snapshot.confirmed_dead_tags:
            own = self._own.get(tag)
            if own is not None and tag not in self._dead_own:
                self._dead_own.add(tag)
                add("combat", "own_losses", -own.value(config) * config.combat_coefficient)
                event("own_losses", own.value(config))
            enemy = self._enemies.get(tag)
            if enemy is not None and not enemy.dead:
                remaining = max(0.0, enemy.asset.value(config) - enemy.credited_value)
                enemy.credited_value += remaining
                enemy.dead = True
                add("combat", self._damage_key(enemy.asset), remaining * self._combat_coefficient(enemy.asset))
                event("enemy_kills", enemy.asset.value(config))
                if remaining:
                    event(self._damage_key(enemy.asset), remaining)

        if previous is not None:
            dt = snapshot.game_time - previous.game_time
            # The previous observation applies to the interval that just ended.
            add("macro", "supply_blocked", -dt * previous.supply_blocked * config.supply_blocked_per_second)
            add("macro", "idle_workers", -dt * previous.idle_workers * config.idle_worker_per_second)
            add("macro", "idle_production", -dt * previous.idle_production * config.idle_production_per_second)
            if self._bank_since is not None:
                elapsed = max(0.0, snapshot.game_time - max(previous.game_time,
                                                          self._bank_since + config.bank_grace_seconds))
                excess = self._bank_excess(previous)
                penalty = elapsed * excess * config.unspent_resources_per_second
                add("bank", "unspent_resources", -penalty)
                if penalty:
                    event("unspent_resource_seconds", elapsed)
        if self._bank_excess(snapshot) <= 0:
            self._bank_since = None
        elif self._bank_since is None:
            self._bank_since = snapshot.game_time
        self._previous = snapshot
        components: dict[str, float] = {}
        raw: dict[str, float] = {}
        for group, values in groups.items():
            requested = sum(abs(value) for value in values.values())
            remaining = max(0.0, getattr(config, f"{group}_budget") - self._spent[group])
            scale = min(1.0, remaining / requested) if requested else 0.0
            self._spent[group] += requested * scale
            for name, value in values.items():
                raw[name] = value
                applied = value * scale
                components[name] = applied
                self._totals[name] = self._totals.get(name, 0.0) + applied
                self._raw_totals[name] = self._raw_totals.get(name, 0.0) + value
        return RewardResult(sum(components.values()), components, self.auxiliary_used, raw)

    def _bank_excess(self, snapshot: RewardSnapshot) -> float:
        if (snapshot.minerals is None or snapshot.vespene is None or snapshot.supply_used is None
                or snapshot.supply_used >= 190):
            return 0.0
        config = self.config
        return min(2.0, max(0.0, snapshot.minerals / config.bank_mineral_reserve - 1)
                   + max(0.0, snapshot.vespene / config.bank_gas_reserve - 1))

    def finish(self, outcome: str) -> RewardResult:
        if self._finished:
            raise RuntimeError("terminal reward already awarded")
        rewards = {
            "victory": self.config.terminal_win,
            "defeat": self.config.terminal_loss,
            "tie": self.config.terminal_draw,
            "draw": self.config.terminal_draw,
            "time_limit": self.config.terminal_draw,
        }
        if outcome not in rewards:
            raise ValueError(f"unsupported match outcome: {outcome}")
        self._finished = True
        self._terminal = rewards[outcome]
        return RewardResult(self._terminal, {"outcome": self._terminal}, self.auxiliary_used)

    def correct_timeout(self) -> RewardResult:
        """Replace an engine-reported result with a verified time-limit draw.

        SC2 can report defeat after another participant leaves at the time cap.
        Only the match runner, which knows that cap was reached, may call this.
        The caller adds this delta to its final transition; dense feedback is
        retained. Repeated calls return zero and cannot farm terminal reward.
        """
        if not self._finished:
            raise RuntimeError("cannot correct timeout before terminal reward")
        adjustment = self.config.terminal_draw - self._terminal
        self._terminal = self.config.terminal_draw
        self._terminal_correction += adjustment
        return RewardResult(adjustment, {"outcome_correction": adjustment}, self.auxiliary_used)

    @staticmethod
    def _damage_key(asset: RewardAsset) -> str:
        return "enemy_economic_damage" if asset.category in ("worker", "expansion") else "enemy_combat_damage"

    def _combat_coefficient(self, asset: RewardAsset) -> float:
        multiplier = self.config.economic_damage_multiplier if asset.category in ("worker", "expansion") else 1
        return self.config.combat_coefficient * multiplier
