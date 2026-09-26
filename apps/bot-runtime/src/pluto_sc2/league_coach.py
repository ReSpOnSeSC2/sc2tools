"""Frozen replay-informed Protoss opponents for an optional league curriculum.

This is a scripted coach executor, not a model API or live Codex strategist.
Its only observations/actions remain those of CoachBot's human control gate.
Every match captures the entire opening and strategy before collection starts.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path
import random
import re

from .coach_opening import OpeningPlan
from .coach_opening_io import opening_snapshot
from .coach_orders import StrategyOrder
from .runner import write_json


PROFILE = "frozen-replay-coach-opponent-v1"
_ENVELOPE = {"schema", "game_id", "revision", "based_on_report", "issued_game_seconds",
             "valid_until_game_seconds"}


def _sha_bytes(raw):
    return hashlib.sha256(raw).hexdigest()


def _pinned_json(path, expected):
    path = Path(path).resolve()
    raw = path.read_bytes()
    if not isinstance(expected, str) or _sha_bytes(raw) != expected:
        raise ValueError("Frozen coached opponent source changed: " + str(path))
    return json.loads(raw.decode("utf-8"))


def _number(value, minimum, maximum, label):
    if type(value) not in (int, float) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError("Invalid coached opponent " + label)
    return float(value)


def configuration(path):
    """Missing/disabled config leaves existing league scheduling untouched."""
    path = Path(path)
    if not path.exists():
        return None
    raw = path.read_bytes()
    document = json.loads(raw.decode("utf-8"))
    fields = {"schema", "enabled", "every_n_cycles", "cycle_offset", "opening_library",
              "opening_library_sha256", "strategy_library", "strategy_library_sha256", "speed"}
    if (not isinstance(document, dict) or type(document.get("schema")) is not int
            or document["schema"] != 1 or type(document.get("enabled")) is not bool
            or set(document) - fields):
        raise ValueError("Invalid coached opponent configuration")
    if not document["enabled"]:
        return None
    if set(document) != fields:
        raise ValueError("Enabled coached opponent configuration requires every field")
    every, offset = document["every_n_cycles"], document["cycle_offset"]
    if type(every) is not int or not 2 <= every <= 100 or type(offset) is not int or not 0 <= offset < every:
        raise ValueError("Coached curriculum must preserve neural opponents in at least every other cycle")
    _number(document["speed"], .1, 50, "speed")
    for field in ("opening_library", "strategy_library"):
        if not isinstance(document[field], str) or not Path(document[field]).is_absolute():
            raise ValueError("Coached source paths must be absolute")
    return {**document, "configuration_sha256": _sha_bytes(raw), "configuration_path": str(path.resolve())}


def _strategy_order(strategy, game_id, revision, issued, expires):
    return StrategyOrder.from_dict({**strategy, "schema": 1, "game_id": game_id,
        "revision": revision, "based_on_report": 0, "issued_game_seconds": issued,
        "valid_until_game_seconds": expires})


def _validate_plan(plan):
    expected = {"id", "replay_id", "matchup", "opening_horizon_seconds", "phases"}
    if (not isinstance(plan, dict) or set(plan) != expected or not isinstance(plan["id"], str)
            or not 1 <= len(plan["id"]) <= 128 or plan["matchup"] not in {"PvP", "PvT", "PvZ"}
            or not isinstance(plan["replay_id"], str) or not re.fullmatch(r"[0-9a-f]{64}", plan["replay_id"])):
        raise ValueError("Invalid coached strategy plan identity")
    _number(plan["opening_horizon_seconds"], 60, 600, "opening horizon")
    phases = plan["phases"]
    if not isinstance(phases, list) or not 1 <= len(phases) <= 30:
        raise ValueError("Coached plan requires 1 to 30 phases")
    previous = -1
    for index, phase in enumerate(phases):
        if not isinstance(phase, dict) or set(phase) != {"starts_at", "min_attack_army_supply", "strategy"}:
            raise ValueError("Invalid coached strategy phase")
        starts = _number(phase["starts_at"], 0, 3600, "phase start")
        minimum_army = _number(phase["min_attack_army_supply"], 0, 150, "minimum attack army supply")
        if starts <= previous or (index == 0 and starts != 0):
            raise ValueError("Coached phases must start at zero and increase strictly")
        strategy = phase["strategy"]
        if not isinstance(strategy, dict) or set(strategy) & _ENVELOPE:
            raise ValueError("Coached phase cannot override strategy envelope")
        if strategy.get("stance") in {"attack", "pressure"} and minimum_army < 12:
            raise ValueError("Coached attack phases need at least 12 HUD army supply")
        _strategy_order(strategy, "validation", index + 1, starts, starts + 600)
        previous = starts


def freeze_opponent(config, learner_race, seed):
    """Select coach-side Pv<learner race>, and verify TRAIN/archive provenance.

    The caller owns the new match directory. No live league or replay file is
    edited here, and subsequent edits to source JSON cannot alter this object.
    """
    if learner_race not in {"Protoss", "Terran", "Zerg"}:
        raise ValueError("Coached learner race must be explicit")
    if type(seed) is not int or not 0 <= seed < 2**32:
        raise ValueError("Coached selection seed must be a 32-bit nonnegative integer")
    library = _pinned_json(config["strategy_library"], config["strategy_library_sha256"])
    if (not isinstance(library, dict) or set(library) != {"schema", "source_documents", "plans"}
            or type(library["schema"]) is not int or library["schema"] != 1
            or not isinstance(library["plans"], list) or not library["plans"]
            or not isinstance(library["source_documents"], list) or not library["source_documents"]):
        raise ValueError("Invalid coached strategy library")
    for source in library["source_documents"]:
        if (not isinstance(source, dict) or set(source) != {"path", "sha256"}
                or not isinstance(source["path"], str) or not Path(source["path"]).is_absolute()
                or _sha_bytes(Path(source["path"]).read_bytes()) != source["sha256"]):
            raise ValueError("Coached strategy provenance changed")
    identities = set()
    for plan in library["plans"]:
        _validate_plan(plan)
        if plan["id"] in identities:
            raise ValueError("Duplicate coached strategy plan id")
        identities.add(plan["id"])
    matchup = "Pv" + learner_race[0]
    plans = [plan for plan in library["plans"] if plan["matchup"] == matchup]
    if not plans:
        raise ValueError("Coached strategy library is missing matchup " + matchup)
    # Plans identify approved families. Uniform family selection avoids making
    # a family common merely because it has more reviewed replay examples.
    opening_library = _pinned_json(config["opening_library"], config["opening_library_sha256"])
    families = {}
    for plan in plans:
        candidates = [row for row in opening_library["protoss_candidates"] if row["replay_id"] == plan["replay_id"]]
        if len(candidates) != 1:
            raise ValueError("Coached plan needs exactly one matching opening candidate")
        family = candidates[0].get("site_build_label") or plan["id"]
        families.setdefault(family, []).append(plan)
    rng = random.Random(seed)
    family = rng.choice(sorted(families))
    plan = rng.choice(sorted(families[family], key=lambda row: row["id"]))
    opening = opening_snapshot(config["opening_library"], plan["replay_id"], learner_race,
                               plan["opening_horizon_seconds"], selection_seed=seed)
    if opening["source_library_sha256"] != config["opening_library_sha256"]:
        raise ValueError("Coached opening library changed while being frozen")
    # Validate executability now, before starting an engine process.
    OpeningPlan.from_candidate(opening["candidate"], opening["train_ids"], opening["validation_ids"],
                               matchup, horizon_seconds=opening["horizon_seconds"])
    return deepcopy({"schema": 1, "profile": PROFILE, "race": "Protoss", "learned_policy": False,
        "external_model_api": False, "live_codex_decisions": False, "max_apm": 200,
        "camera_restricted": True, "spatial_selection": True, "obeys_fog": True, "starting_workers": 8,
        "speed": config["speed"], "configuration_sha256": config["configuration_sha256"],
        "strategy_library_sha256": config["strategy_library_sha256"],
        "source_documents": library["source_documents"], "plan": plan, "opening": opening,
        "selection": {"seed": seed, "method": "uniform_build_family_then_plan",
                      "eligible_families": sorted(families), "selected_family": family},
        "rating_status": "unrated", "measured_mmr": None})


def select_opponent(output, state, learner_race, opponent_race, seed, schedule_length):
    config = configuration(Path(output) / "coach-opponent.json")
    if config is None or opponent_race != "Protoss":
        return None
    if (state["games"] // schedule_length) % config["every_n_cycles"] != config["cycle_offset"]:
        return None
    return freeze_opponent(config, learner_race, seed)


class FrozenStrategyMailbox:
    """Deterministic phase schedule; never reads a live strategy.json file.

    Only the game clock selects phases. The ordinary executor may adapt its
    permitted low-level actions to visible threats/resources. Renewal preserves
    StrategyOrder's 600-second contract without changing frozen plan contents.
    """

    def __init__(self, directory, game_id, plan, permitted_state=None):
        _validate_plan(plan)
        self.directory, self.game_id = Path(directory), game_id
        self.plan = deepcopy(plan)
        self.permitted_state = permitted_state
        self._last_revision = None
        self._last_key = None
        self._revision = 0
        self._status = {"game_id": game_id, "profile": PROFILE, "plan_id": plan["id"],
                        "last_status": "ready", "active_revision": None, "accepted_orders": 0,
                        "live_codex_decisions": False}

    @property
    def status(self):
        return dict(self._status)

    def poll(self, now, report_sequence):
        now = _number(now, 0, 86400, "game clock")
        phases = self.plan["phases"]
        index = max(i for i, phase in enumerate(phases) if phase["starts_at"] <= now)
        phase = phases[index]
        renewal = int((now - phase["starts_at"]) // 600)
        issued = phase["starts_at"] + renewal * 600
        expires = min(issued + 600, phases[index + 1]["starts_at"] if index + 1 < len(phases) else issued + 600)
        strategy = deepcopy(phase["strategy"])
        permitted = self.permitted_state() if self.permitted_state is not None else {}
        army_supply = permitted.get("army_supply", 0)
        _number(army_supply, 0, 1000, "own HUD army supply")
        defense_alert = bool(permitted.get("defense_alert", False))
        gate = "not_attacking"
        if strategy["stance"] in {"attack", "pressure"}:
            gate = ("current_defense_alert" if defense_alert else "insufficient_own_army"
                    if army_supply < phase["min_attack_army_supply"] else "ready")
            if gate != "ready":
                strategy["stance"] = "defend"
        key = (index, renewal, strategy["stance"], gate)
        if key != self._last_key:
            self._revision += 1
            self._last_key = key
        revision = self._revision
        order = _strategy_order(strategy, self.game_id, revision, issued, expires)
        if revision != self._last_revision:
            destination = self.directory / "frozen-strategy-orders" / f"{revision:06d}.json"
            if destination.exists():
                raise ValueError("Frozen strategy order audit already exists")
            write_json(destination, order.to_dict())
            self._last_revision = revision
            self._status["accepted_orders"] += 1
        self._status.update(last_status="frozen_schedule_active", active_revision=revision,
                            phase_index=index, plan_seconds=phase["starts_at"], attack_gate=gate,
                            own_army_supply=army_supply, minimum_army_supply=phase["min_attack_army_supply"],
                            defense_alert=defense_alert, requested_stance=phase["strategy"]["stance"],
                            active_stance=strategy["stance"])
        return order


def make_bot(frozen, directory, game_id, max_game_seconds):
    """Coach never receives an optimizer, learned policy, or record=True."""
    from .coach_bot import CoachBot
    if frozen.get("profile") != PROFILE or frozen.get("race") != "Protoss":
        raise ValueError("Invalid frozen coach opponent")
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    snapshot = deepcopy(frozen)
    snapshot_path = directory / "opponent.json"
    if snapshot_path.exists():
        raise ValueError("Coach opponent directory must be new")
    for index, source in enumerate(snapshot["source_documents"]):
        raw = Path(source["path"]).read_bytes()
        if _sha_bytes(raw) != source["sha256"]:
            raise ValueError("Coached strategy source changed before match start")
        destination = directory / "source-documents" / f"{index:02d}-{Path(source['path']).name}"
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(raw)
    write_json(snapshot_path, snapshot)
    opening = snapshot["opening"]
    plan = OpeningPlan.from_candidate(opening["candidate"], opening["train_ids"], opening["validation_ids"],
                                     opening["matchup"], horizon_seconds=opening["horizon_seconds"])
    class FrozenCoachBot(CoachBot):
        @property
        def control_summary(self):
            return {**super().control_summary, "brain": PROFILE, "live_codex_decisions": False,
                    "strategy_source": "immutable_reviewed_phase_schedule"}

    bot = FrozenCoachBot(directory, game_id, max_game_seconds=max_game_seconds, speed=snapshot["speed"], opening=plan)
    bot.mailbox = FrozenStrategyMailbox(directory, game_id, snapshot["plan"], permitted_state=lambda: {
        "army_supply": float(bot.supply_army), "defense_alert": bool(bot._defense_alert)})
    return bot


def opponent_record(frozen):
    """Compact match/checkpoint attribution; full source is saved beside replay."""
    return {"kind": "frozen_coach", "profile": PROFILE, "race": "Protoss",
            "plan_id": frozen["plan"]["id"], "source_replay_id": frozen["plan"]["replay_id"],
            "coach_matchup": frozen["plan"]["matchup"],
            "configuration_sha256": frozen["configuration_sha256"],
            "strategy_library_sha256": frozen["strategy_library_sha256"],
            "opening_library_sha256": frozen["opening"]["source_library_sha256"],
            "frozen_snapshot_sha256": _sha_bytes(json.dumps(frozen, sort_keys=True, allow_nan=False).encode()),
            "live_codex_decisions": False, "learned_policy": False, "rating_status": "unrated"}
