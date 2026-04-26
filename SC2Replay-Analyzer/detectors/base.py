"""Base class shared by `OpponentStrategyDetector` and `UserBuildDetector`.

Provides geometric helpers (`_is_proxy`, `_is_far_proxy`) and a generic
custom-rule evaluator so user-authored builds in `custom_builds.json` can be
matched without writing Python.
"""

import math
from typing import Dict, List, Tuple


class BaseStrategyDetector:
    def __init__(self, custom_builds: List[Dict]):
        self.custom_builds = custom_builds

    def _get_main_base_loc(self, buildings: List[Dict]) -> Tuple[float, float]:
        town_halls = [b for b in buildings if b['name'] in (
            "Nexus", "Hatchery", "CommandCenter", "OrbitalCommand", "PlanetaryFortress"
        )]
        if not town_halls:
            return (0, 0)
        town_halls.sort(key=lambda x: x['time'])
        return (town_halls[0].get('x', 0), town_halls[0].get('y', 0))

    def _is_proxy(self, building: Dict, main_loc: Tuple[float, float], threshold: float = 50.0) -> bool:
        x, y = building.get('x', 0), building.get('y', 0)
        dist = math.sqrt((x - main_loc[0]) ** 2 + (y - main_loc[1]) ** 2)
        return dist > threshold

    def _is_far_proxy(self, unit_or_building: Dict, main_loc: Tuple[float, float], threshold: float = 80.0) -> bool:
        x, y = unit_or_building.get('x', 0), unit_or_building.get('y', 0)
        dist = math.sqrt((x - main_loc[0]) ** 2 + (y - main_loc[1]) ** 2)
        return dist > threshold

    def check_custom_rules(
        self,
        rules: List[Dict],
        buildings: List[Dict],
        units: List[Dict],
        upgrades: List[Dict],
        main_loc: Tuple[float, float],
    ) -> bool:
        for rule in rules:
            rtype = rule.get("type")
            name = rule.get("name")
            time_lt = rule.get("time_lt", 9999)

            if rtype == "building":
                count = sum(1 for b in buildings if b['name'] == name and b['time'] <= time_lt)
                if count < rule.get("count", 1):
                    return False
            elif rtype == "unit":
                count = sum(1 for u in units if u['name'] == name and u['time'] <= time_lt)
                if count < rule.get("count", 1):
                    return False
            elif rtype == "unit_max":
                count = sum(1 for u in units if u['name'] == name and u['time'] <= time_lt)
                if count > rule.get("count", 999):
                    return False
            elif rtype == "upgrade":
                if not any(name in u['name'] and u['time'] <= time_lt for u in upgrades):
                    return False
            elif rtype == "proxy":
                dist = rule.get("dist", 50)
                if not any(
                    b['name'] == name and b['time'] <= time_lt and self._is_proxy(b, main_loc, dist)
                    for b in buildings
                ):
                    return False
        return True
