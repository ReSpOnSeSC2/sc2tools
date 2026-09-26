"""Translate only an agent's permitted observations into training feedback.

There are no global kill/loss score reads here. Death notifications are accepted
only for previously observed eligible assets whose last position is visible now
(and still inside the Protoss camera). Leaving sight never implies a death.
"""
from __future__ import annotations

from collections import Counter
from typing import Any

from sc2.data import Attribute
from sc2.dicts.unit_train_build_abilities import TRAIN_INFO

from .counters import counter_match
from .rewards import RewardAsset, RewardConfig, RewardEngine, RewardSnapshot


_WORKERS = frozenset(("PROBE", "SCV", "DRONE"))
_BASES = frozenset(("NEXUS", "COMMANDCENTER", "ORBITALCOMMAND", "PLANETARYFORTRESS",
                    "COMMANDCENTERFLYING", "ORBITALCOMMANDFLYING", "HATCHERY", "LAIR", "HIVE"))
_TEMPORARY = frozenset(("MULE", "LARVA", "EGG", "BROODLING", "BROODLINGESCORT", "LOCUSTMP",
                        "LOCUSTMPFLYING", "INTERCEPTOR", "AUTOTURRET", "POINTDEFENSEDRONE",
                        "ADEPTPHASESHIFT", "DISRUPTORPHASED", "KD8CHARGE", "INFESTEDTERRAN",
                        "INFESTEDTERRANSEGG", "CHANGELING", "CHANGELINGMARINE",
                        "CHANGELINGMARINESHIELD", "CHANGELINGZEALOT", "CHANGELINGZERGLING",
                        "CHANGELINGZERGLINGWINGS"))


def _eligible(unit: Any) -> bool:
    name = unit.type_id.name
    return (not getattr(unit, "is_hallucination", False) and name not in _TEMPORARY
            and not any(part in name for part in ("COCOON", "EGG", "CREEPTUMOR")))


def _asset(bot: Any, unit: Any, known_threats: set[int], *, own: bool) -> RewardAsset | None:
    if not _eligible(unit):
        return None
    data = bot.game_data.units.get(int(unit.type_id.value))
    if data is None:
        return None  # Unknown unit data cannot establish a paid asset's value.
    minerals, gas = float(data._proto.mineral_cost), float(data._proto.vespene_cost)
    if minerals + gas <= 0:
        return None
    name = unit.type_id.name
    category = ("worker" if name in _WORKERS else "expansion" if name in _BASES
                else "structure" if unit.is_structure else "army")
    return RewardAsset(
        tag=int(unit.tag), mineral_cost=minerals, gas_cost=gas, category=category,
        health=float(unit.health), health_max=float(unit.health_max),
        shields=float(unit.shield), shields_max=float(unit.shield_max),
        completed=bool(unit.is_ready), type_id=name,
        counter_match=bool(own and category == "army" and unit.is_ready
                           and counter_match(int(unit.type_id.value), known_threats, bot.game_data)),
    )


def _idle(unit: Any) -> bool:
    # Read raw orders, avoiding Burnysc2's strict unknown-ability resolution.
    proto = getattr(unit, "_proto", None)
    return not proto.orders if proto is not None else bool(unit.is_idle)


def _can_produce(bot: Any, producer: Any, own: list[Any]) -> bool:
    # Warp-in cooldown and placement cannot be established by an empty order
    # queue. Skip those producers rather than call their cooldown "idle".
    for kind, info in TRAIN_INFO.get(producer.type_id, {}).items():
        if info.get("requires_placement_position"):
            continue
        data = bot.game_data.units.get(kind.value)
        if data is None or Attribute.Structure.value in data._proto.attributes:
            continue
        if info.get("requires_power") and not getattr(producer, "is_powered", False):
            continue
        requirement = info.get("required_building")
        if requirement is not None and not any(unit.is_ready and unit.type_id == requirement for unit in own):
            continue
        if info.get("requires_techlab") and not any(
            unit.is_ready and unit.type_id.name.endswith("TECHLAB")
            and unit.tag == getattr(producer, "add_on_tag", None) for unit in own
        ):
            continue
        if (bot.minerals >= data._proto.mineral_cost and bot.vespene >= data._proto.vespene_cost
                and bot.supply_left >= data._proto.food_required):
            return True
    return False


class RewardCollector:
    """Deduplicated per-frame snapshots and accrual across input/selection waits."""

    def __init__(self, config: RewardConfig | dict, reward_reference: dict | None = None):
        self.config = config if isinstance(config, RewardConfig) else RewardConfig.from_dict(config)
        self.engine = RewardEngine(self.config)
        self.last_loop: int | None = None
        self.pending = 0.0
        self.terminal_outcome = 0.0
        self._positions: dict[int, Any] = {}
        self._seen_loops: dict[int, int] = {}
        self._known_threats: set[int] = set()
        self.reward_reference = reward_reference
        self._completed_owned: dict[int, str] = {}
        self._last_worker_count: int | None = None
        self.finished = False

    def observe(self, bot: Any, own: list[Any], enemies: list[Any], *, camera_restricted: bool) -> None:
        loop = int(bot.state.game_loop)
        if loop == self.last_loop or self.finished:
            return
        if self.last_loop is not None and loop < self.last_loop:
            raise ValueError("Reward observation loop moved backwards")
        previous_counts = Counter(self._completed_owned.values())
        own_assets, enemy_assets = [], []
        next_threats = set()
        for units, destination, is_own in ((own, own_assets, True), (enemies, enemy_assets, False)):
            for unit in units:
                asset = _asset(bot, unit, self._known_threats, own=is_own)
                if asset is None:
                    continue
                destination.append(asset)
                self._positions[asset.tag] = unit.position
                self._seen_loops[asset.tag] = loop
                if is_own and asset.completed:
                    self._completed_owned[asset.tag] = asset.type_id
                if not is_own and asset.category == "army":
                    next_threats.add(int(unit.type_id.value))
        # Own completed upgrades are ordinary player HUD information, never an
        # enemy upgrade score or information from the opponent's raw state.
        for upgrade in getattr(bot.state, "upgrades", ()):
            data = bot.game_data.upgrades.get(int(upgrade.value))
            if data is not None:
                own_assets.append(RewardAsset(
                    tag=-int(upgrade.value) - 1, mineral_cost=float(data.cost.minerals),
                    gas_cost=float(data.cost.vespene), category="upgrade", type_id=upgrade.name))
        dead = frozenset(int(tag) for tag in getattr(bot.state, "dead_units", ())
                         if int(tag) in self._positions
                         and self._seen_loops[int(tag)] == self.last_loop
                         and bot.is_visible(self._positions[int(tag)])
                         and (not camera_restricted or bot.fairplay.on_screen(self._positions[int(tag)])))
        for tag in dead:
            self._completed_owned.pop(tag, None)
        score = getattr(bot.state, "score", None)
        eligible_own = [unit for unit in own if _eligible(unit) and unit.is_ready]
        workers = [unit for unit in eligible_own if unit.type_id.name in _WORKERS]
        producers = [unit for unit in eligible_own if unit.is_structure and _can_produce(bot, unit, own)]
        resources = [unit for unit in getattr(bot, "mineral_field", ())
                     if getattr(unit, "mineral_contents", 0) > 0]
        resources += [unit for unit in own if unit.is_ready
                      and unit.type_id.name in {"ASSIMILATOR", "REFINERY", "EXTRACTOR"}
                      and getattr(unit, "vespene_contents", 0) > 0]
        harvest_available = any(bot.is_visible(unit.position)
                                and (not camera_restricted or bot.fairplay.on_screen(unit)) for unit in resources)
        similarity, progress = None, 0.0
        if self.reward_reference is not None:
            from .replay_targets import frame_at, replay_similarity
            counts = Counter(self._completed_owned.values())
            worker = {"Protoss": "PROBE", "Terran": "SCV", "Zerg": "DRONE"}.get(bot.race.name)
            if worker is not None:
                counts[worker] = int(bot.supply_workers)  # Own worker HUD, not an off-screen unit query.
                previous_counts[worker] = self._last_worker_count if self._last_worker_count is not None else counts[worker]
            target = frame_at(self.reward_reference, float(bot.time))["counts"]
            similarity = replay_similarity(counts, target)
            if self.last_loop is not None:
                progress = max(0.0, similarity - replay_similarity(previous_counts, target))
        snapshot = RewardSnapshot(
            game_time=float(bot.time),
            collected_minerals=float(score.collected_minerals) if score is not None else None,
            collected_gas=float(score.collected_vespene) if score is not None else None,
            own_assets=tuple(own_assets), visible_enemies=tuple(enemy_assets), confirmed_dead_tags=dead,
            supply_blocked=bool(bot.supply_left < 1 and bot.supply_cap < 200),
            idle_workers=sum(_idle(unit) for unit in workers) if harvest_available else 0,
            idle_production=sum(_idle(unit) for unit in producers),
            replay_similarity=similarity, replay_progress=progress,
            minerals=float(bot.minerals), vespene=float(bot.vespene),
            supply_used=float(bot.supply_used) if hasattr(bot, "supply_used") else None,
        )
        self.pending += self.engine.update(snapshot).total
        self._known_threats.update(next_threats)  # Counter bonuses require an earlier observation.
        self._last_worker_count = int(bot.supply_workers)
        self.last_loop = loop

    def take(self) -> float:
        value, self.pending = self.pending, 0.0
        return value

    def finish(self, outcome: str) -> None:
        if not self.finished:
            self.terminal_outcome = self.engine.finish(outcome).total
            self.pending += self.terminal_outcome
            self.finished = True

    def correct_timeout(self) -> float:
        adjustment = self.engine.correct_timeout().total
        self.terminal_outcome = 0.0
        return adjustment
