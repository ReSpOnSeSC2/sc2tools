"""Released declarative criteria also consumed by their procedural tree slots.

Only genuine extracted criteria live here. Other presets remain explicitly
procedural in the admin catalog; empty legacy signatures are not definitions.
"""
from __future__ import annotations

ARCHON_DROP_PRISM_DEADLINE_SECONDS = 6 * 60


def _count(name, minimum, deadline):
    return {"kind": "count", "name": name, "category": "unit", "clock": "completion", "beforeSeconds": deadline, "min": minimum}


def _structure(name, deadline):
    # Existing tree has_building accepts a recorded construction start or a
    # completed observation when the start was unavailable. Presence, unlike a
    # count, cannot be inflated by init/born pairs of the same structure.
    return {"kind": "exists", "name": name, "category": "building", "clock": "recorded", "beforeSeconds": deadline}


RELEASED_PRESET_CRITERIA = {
    "PvZ - Archon Drop": [[
        {"kind": "first", "names": ["Stargate", "TwilightCouncil", "DarkShrine", "RoboticsFacility"], "category": "building", "clock": "recorded"},
        _structure("TemplarArchive", 540),
        _count("Archon", 2, 540),
        _count("WarpPrism", 1, ARCHON_DROP_PRISM_DEADLINE_SECONDS),
    ]],
    "PvZ - DT drop into Archon Drop": [[
        {"kind": "order", "names": ["TwilightCouncil", "DarkShrine"], "category": "building", "clock": "recorded"},
        _structure("DarkShrine", 540),
        _structure("RoboticsFacility", 540),
        _count("DarkTemplar", 3, 540),
        _count("Archon", 1, 540),
        _count("WarpPrism", 1, ARCHON_DROP_PRISM_DEADLINE_SECONDS),
    ]],
}


def matches_released_preset(name, context):
    """Keep the released tree's slot/precedence, with one shared predicate."""
    from .preset_policy import evaluate_conditions
    events = [*context.buildings, *context.units, *context.upgrades]
    return any(evaluate_conditions(group, events, context._detector) for group in RELEASED_PRESET_CRITERIA[name])
