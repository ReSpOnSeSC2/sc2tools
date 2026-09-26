"""One bounded Probe scouting trip from current camera observations.

The caller starts this only after the original scout MOVE is confirmed, filters
candidate waypoints against current visible/pathable screen terrain, and issues
every returned input through FairPlayController. This helper performs no engine
queries, looks up no units, and never orders an attack or another worker scout.
"""
from __future__ import annotations

import math
from numbers import Real

from sc2.ids.ability_id import AbilityId as A


WORKERS = {"PROBE", "SCV", "DRONE", "MULE"}
STATIC_DANGER = {"BUNKER", "PHOTONCANNON", "PLANETARYFORTRESS", "SPINECRAWLER", "AUTOTURRET"}


def _time(value):
    if isinstance(value, bool) or not isinstance(value, Real) or not math.isfinite(value) or value < 0:
        raise ValueError("Scout route requires finite nonnegative time")
    return float(value)


def _point(value):
    try:
        result = tuple(float(x) for x in value)
    except (TypeError, ValueError):
        return None
    return result if len(result) == 2 and all(math.isfinite(x) for x in result) else None


def _attack_intent(unit):
    try:
        return bool(getattr(unit, "is_attacking", False))
    except (KeyError, ValueError):
        # Reserved patch orders can fail Burnysc2's game_data lookup. Preserve
        # unknown intent separately; never assume such a worker is mining.
        return None


def _visible(unit, *, own):
    if (unit is None or not getattr(unit, "is_on_screen", False)
            or not getattr(unit, "is_visible", False) or getattr(unit, "is_snapshot", False)
            or getattr(unit, "is_mine", own) is not own):
        return None
    position = _point(unit.position)
    tag = getattr(unit, "tag", None)
    if position is None or type(tag) is not int or tag <= 0:
        return None
    health = float(getattr(unit, "health", 0)) + float(getattr(unit, "shield", 0))
    maximum = float(getattr(unit, "health_max", 0)) + float(getattr(unit, "shield_max", 0))
    if not math.isfinite(health) or not math.isfinite(maximum):
        return None
    return {"tag": tag, "position": position, "type": getattr(getattr(unit, "type_id", None), "name", None),
            "health": health, "maximum": maximum, "structure": bool(getattr(unit, "is_structure", False)),
            "ground_attack": bool(getattr(unit, "can_attack_ground", False)),
            "range": float(getattr(unit, "ground_range", 5) or 0),
            "attacking": _attack_intent(unit) if not own else None}


class CoachProbeRoute:
    """Confirmed single-source movement receipts, not an automatic input loop."""

    def __init__(self):
        self.mission = None
        self.designated_tag = None
        self.pending = None
        self.serial = 0
        self.last_now = 0.0
        self.next_input = 0.0

    def start(self, tag, home, destination, now, *, position=None):
        """Call only after the original one-Probe scout MOVE was accepted."""
        now = self._clock(now)
        if self.designated_tag is not None:
            return False
        home, destination, position = _point(home), _point(destination), _point(position)
        if type(tag) is not int or tag <= 0 or home is None or destination is None or position is None:
            raise ValueError("Confirmed scout needs its tag and previously observed origin/home/target")
        self.designated_tag = tag
        self.mission = {"tag": tag, "home": home, "destination": destination, "started": now,
            "deadline": now + 120, "status": "outbound", "look_started": None, "looks": 0,
            "last_seen": {"position": position, "time": now}, "last_health": None,
            "last_target": None, "last_move": now, "observed_points": [], "enemy_types": [],
            "return_reason": None, "camera_visits": 0, "next_camera": now + 8}
        return True

    def _clock(self, now):
        now = _time(now)
        if now < self.last_now:
            raise ValueError("Scout route time moved backwards")
        self.last_now = now
        return now

    def protected_tags(self, now):
        now = _time(now)
        if self.mission and self.mission["status"] != "finished" and now < self.mission["deadline"] + 15:
            return {self.designated_tag: self.mission["deadline"] + 15}
        return {}

    def candidate_waypoints(self, probe, enemies=(), now=None):
        """Unvalidated local candidates; caller must filter current screen terrain.

        No candidate authorizes movement until plan receives it in safe_points.
        Enemies/now are accepted for call symmetry; no hidden route is queried.
        """
        row = _visible(probe, own=True)
        if row is None or row["tag"] != self.designated_tag or row["type"] != "PROBE":
            return []
        x, y = row["position"]
        return [(x + 3 * math.cos(i * math.pi / 4), y + 3 * math.sin(i * math.pi / 4)) for i in range(8)]

    def _intent(self, name, now, position=None, *, reason, kind="command", **extra):
        self.serial += 1
        value = {"id": self.serial, "name": name, "kind": kind, "source_tags": [self.designated_tag]
            if kind == "command" else [], "position": list(position) if position is not None else None,
            "target_tag": None, "ability_id": A.MOVE_MOVE.value if kind == "command" else None,
            "selection_mode": "point", "minimap": name == "probe_scout_home",
            "requires_current_visible_ground": name in {"probe_scout_look", "probe_scout_evade"},
            "expires_at": now + 2, "reason": reason, **extra}
        self.pending = value
        return dict(value)

    def plan(self, probe, enemies, now, *, safe_points=(), camera=None, retreat=False):
        now = self._clock(now)
        mission = self.mission
        if mission is None or mission["status"] == "finished":
            return None
        if self.pending and now <= self.pending["expires_at"]:
            return None
        self.pending = None
        source = _visible(probe, own=True)
        if source is not None and (source["tag"] != self.designated_tag or source["type"] != "PROBE"):
            source = None
        enemies = [row for unit in enemies if (row := _visible(unit, own=False)) is not None]
        if now >= mission["deadline"] or retreat:
            mission["return_reason"] = "trip_time_limit" if not retreat else "defense_requested_return"
        if source is None:
            if now >= mission["deadline"] + 15:
                return self._intent("probe_scout_release", now, kind="release", reason="unobserved_trip_expired",
                                    resume_mining=False, observed_home=False)
            # Only a recent actually observed own position is eligible. Failed
            # camera visits cannot become an indefinite loop over a fogged base.
            seen = mission["last_seen"]
            if (mission["return_reason"] and now >= mission["next_camera"] and now - seen["time"] <= 8
                    and mission["camera_visits"] < 2 and _point(camera) is not None
                    and math.dist(_point(camera), seen["position"]) >= 4):
                return self._intent("probe_scout_camera", now, seen["position"], kind="camera",
                                    reason="brief_reacquire_recent_observed_probe")
            return None
        mission["last_seen"] = {"position": source["position"], "time": now}
        mission["enemy_types"] = sorted(set(mission["enemy_types"]) | {row["type"] for row in enemies if row["type"]})
        old_health = mission["last_health"]
        mission["last_health"] = source["health"]
        if ((old_health is not None and source["health"] < old_health - .5)
                or source["maximum"] > 0 and source["health"] / source["maximum"] < .6):
            mission["return_reason"] = "observed_probe_damage"
        threats = [row for row in enemies if (row["ground_attack"] or row["type"] in STATIC_DANGER)
            and math.dist(source["position"], row["position"]) <= max(4, row["range"] + 4)
            and (row["type"] not in WORKERS or row["attacking"] is not False
                 or math.dist(source["position"], row["position"]) <= 2)]
        if threats:
            mission["return_reason"] = "visible_enemy_threat"
        if mission["status"] == "outbound" and (math.dist(source["position"], mission["destination"]) <= 12
                or any(row["structure"] and math.dist(source["position"], row["position"]) <= 12 for row in enemies)):
            mission.update(status="looking", look_started=now)
        if (mission["look_started"] is not None and now - mission["look_started"] >= 35
                or mission["looks"] >= 6):
            mission["return_reason"] = mission["return_reason"] or "bounded_base_inspection_complete"
        returning = mission["return_reason"] is not None
        if returning and math.dist(source["position"], mission["home"]) <= 8:
            return self._intent("probe_scout_release", now, kind="release", reason="observed_home_arrival",
                                resume_mining=True, observed_home=True)
        if now < self.next_input:
            return None
        candidates = [_point(point) for point in safe_points]
        candidates = [point for point in candidates if point is not None and 1 <= math.dist(point, source["position"]) <= 3.1]
        if threats:
            safe = [point for point in candidates if all(math.dist(point, row["position"]) >=
                    math.dist(source["position"], row["position"]) + .5 for row in threats)]
            if safe:
                point = max(safe, key=lambda p: (min(math.dist(p, row["position"]) for row in threats),
                                                -math.dist(p, mission["home"])))
                return self._intent("probe_scout_evade", now, point, reason="leave_visible_threat_range")
        if returning:
            if mission["status"] == "returning" and now - mission["last_move"] < 8:
                return None
            return self._intent("probe_scout_home", now, mission["home"], reason=mission["return_reason"])
        if mission["status"] != "looking" or not candidates:
            return None
        target = mission["last_target"]
        if target is not None and math.dist(source["position"], target) > 1.5 and now - mission["last_move"] < 8:
            return None
        if not mission["observed_points"] or math.dist(source["position"], mission["observed_points"][-1]) >= 1:
            mission["observed_points"].append(source["position"])
        structures = [row for row in enemies if row["structure"]]
        center = min(structures, key=lambda row: math.dist(row["position"], source["position"]))["position"] if structures else mission["destination"]
        dx, dy = source["position"][0] - center[0], source["position"][1] - center[1]
        # Tangential visible movement inspects different sides of the observed
        # base, while novelty prevents repeated commands to the same corner.
        point = max(candidates, key=lambda p: (round(min(math.dist(p, prior) for prior in mission["observed_points"]), 3),
            -(p[0] - source["position"][0]) * dy + (p[1] - source["position"][1]) * dx))
        return self._intent("probe_scout_look", now, point, reason="inspect_next_visible_base_angle")

    def confirm(self, intent, accepted, now, *, actual_source_tags=None):
        now = self._clock(now)
        if self.pending is None or intent.get("id") != self.pending["id"] or not isinstance(accepted, bool):
            return False
        pending, self.pending = self.pending, None
        actual = set(pending["source_tags"] if actual_source_tags is None else actual_source_tags)
        if not accepted or now > pending["expires_at"] or actual != set(pending["source_tags"]):
            self.next_input = now + 2
            return False
        mission = self.mission
        if pending["kind"] == "release":
            mission.update(status="finished", finish_reason=pending["reason"], observed_home=pending["observed_home"])
        elif pending["kind"] == "camera":
            mission["camera_visits"] += 1
            mission["next_camera"] = now + 8
        else:
            mission.update(last_target=tuple(pending["position"]), last_move=now)
            if pending["name"] == "probe_scout_look":
                mission["looks"] += 1
            elif pending["name"] == "probe_scout_home":
                mission["status"] = "returning"
        self.next_input = now + 2
        return True

    def summary(self):
        return {"designated_tag": self.designated_tag, "mission": self.mission,
                "scope": "Current visible local waypoints; normal minimap home MOVE; no hidden path or death inference"}
