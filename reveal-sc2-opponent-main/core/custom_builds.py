"""
Loader for user-defined Spawning Tool build orders.

The custom_builds.json file lets the user describe a build using a
small rules engine (building / unit / unit_max / upgrade / proxy)
without touching Python code. Both the OpponentStrategyDetector and
the UserBuildDetector evaluate these rules first, and only fall
through to the hardcoded race-specific logic if no custom rule
matches.
"""

import os
import json
from typing import Dict, List

from .paths import CUSTOM_BUILDS_FILE


_DEFAULT_DATA = {
    "instructions": (
        "Add custom Spawning Tool build orders here. "
        "'target' can be 'Opponent' or 'Self'. "
        "'race' is Zerg, Protoss, or Terran. "
        "'matchup' can be 'vs Zerg', 'vs Protoss', 'vs Terran', or 'vs Any'. "
        "Rules types: 'building', 'unit', 'unit_max', 'upgrade', 'proxy'."
    ),
    "builds": [
        {
            "name": "Zerg - 12 Pool (Custom Engine Example)",
            "target": "Opponent",
            "race": "Zerg",
            "matchup": "vs Any",
            "description": "Custom JSON definition of a 12 pool.",
            "rules": [
                {"type": "building", "name": "SpawningPool", "time_lt": 55},
                {"type": "unit_max", "name": "Drone", "count": 13, "time_lt": 60},
            ],
        }
    ],
}


def initialize_custom_builds() -> None:
    """Create custom_builds.json with a default example if it doesn't exist."""
    if os.path.exists(CUSTOM_BUILDS_FILE):
        return
    try:
        from core.atomic_io import atomic_write_json
        atomic_write_json(CUSTOM_BUILDS_FILE, _DEFAULT_DATA, indent=4)
    except Exception as exc:  # pragma: no cover
        print(f"[CustomBuilds] Failed to initialize: {exc}")


def load_custom_builds() -> Dict[str, List[Dict]]:
    """
    Load custom builds, partitioned by target.

    Returns:
        {"Opponent": [...], "Self": [...]}
    """
    builds: Dict[str, List[Dict]] = {"Opponent": [], "Self": []}
    if not os.path.exists(CUSTOM_BUILDS_FILE):
        return builds
    try:
        with open(CUSTOM_BUILDS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        for b in data.get("builds", []):
            target = b.get("target")
            if target in builds:
                builds[target].append(b)
    except Exception as exc:
        print(f"[CustomBuilds] Failed to load: {exc}")
    return builds


# Initialize on import so the file always exists for the GUI.
initialize_custom_builds()
