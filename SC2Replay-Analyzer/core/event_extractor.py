"""Event extraction from sc2reader replays.

`extract_events(replay, my_pid)` is the canonical pass over a replay's tracker
events. It flattens unit/building/upgrade events into plain dictionaries that
the detectors and analytics layers consume. The constants in this module
(KNOWN_BUILDINGS, MORPH_BUILDINGS, SKIP_UNITS, SKIP_BUILDINGS) act as the
filter that prevents noise (workers, larva, locusts, etc.) from polluting
downstream feature extraction.
"""

import sys
from typing import Dict, List, Optional, Set, Tuple

try:
    from sc2reader.events.tracker import (
        UnitBornEvent,
        UnitInitEvent,
        UnitDoneEvent,
        UpgradeCompleteEvent,
        UnitTypeChangeEvent,
        PlayerStatsEvent,  # re-exported for callers (graph extraction)
    )
    # UnitDiedEvent is the canonical "building/unit was destroyed" tracker event.
    # Some sc2reader builds spell it differently or omit it entirely; fall back
    # gracefully so the macro extractor can still run.
    try:
        from sc2reader.events.tracker import UnitDiedEvent  # type: ignore
    except ImportError:  # pragma: no cover
        UnitDiedEvent = None  # type: ignore
except ImportError:  # pragma: no cover - sc2reader is required
    # Defer the tkinter messagebox to the import-time error path so headless
    # tooling (CI, migrations, tests) can still import this module.
    try:
        import tkinter as _tk
        from tkinter import messagebox as _mb
        _root = _tk.Tk()
        _root.withdraw()
        _mb.showerror(
            "Missing Library",
            "Could not import 'sc2reader'.\nPlease install it using: pip install sc2reader",
        )
    except Exception:
        print("Missing library 'sc2reader'. Install with: pip install sc2reader", file=sys.stderr)
    sys.exit(1)


KNOWN_BUILDINGS: Set[str] = {
    "Nexus", "Pylon", "Assimilator", "Gateway", "Forge", "CyberneticsCore",
    "PhotonCannon", "ShieldBattery", "TwilightCouncil", "Stargate",
    "RoboticsFacility", "RoboticsBay", "TemplarArchive", "DarkShrine",
    "FleetBeacon", "WarpGate", "CommandCenter", "CommandCenterFlying",
    "OrbitalCommand", "OrbitalCommandFlying", "PlanetaryFortress", "SupplyDepot",
    "SupplyDepotLowered", "Refinery", "Barracks", "BarracksFlying", "Factory",
    "FactoryFlying", "Starport", "StarportFlying", "EngineeringBay", "Armory",
    "GhostAcademy", "FusionCore", "TechLab", "Reactor", "BarracksTechLab",
    "BarracksReactor", "FactoryTechLab", "FactoryReactor", "StarportTechLab",
    "StarportReactor", "MissileTurret", "SensorTower", "Bunker", "Hatchery",
    "Lair", "Hive", "SpawningPool", "EvolutionChamber", "Extractor", "RoachWarren",
    "BanelingNest", "SpineCrawler", "SporeCrawler", "HydraliskDen", "LurkerDen",
    "InfestationPit", "Spire", "GreaterSpire", "NydusNetwork", "NydusCanal",
    "UltraliskCavern", "CreepTumor", "CreepTumorBurrowed", "CreepTumorQueen",
}

MORPH_BUILDINGS: Set[str] = {
    "Lair", "Hive", "GreaterSpire", "OrbitalCommand", "PlanetaryFortress",
    "WarpGate", "LurkerDen",
}

SKIP_UNITS: Set[str] = {
    "MULE", "Larva", "LocustMP", "Probe", "SCV", "Drone", "Egg", "BroodlingEscort",
    "Broodling", "Changeling", "ChangelingMarine", "ChangelingMarineShield",
    "ChangelingZergling", "ChangelingZealot", "InfestedTerran", "AutoTurret",
    "PointDefenseDrone", "Interceptor", "AdeptPhaseShift", "Overlord",
    "OverseerCocoon", "BanelingCocoon", "RavagerCocoon", "LurkerCocoon",
    "TransportOverlordCocoon",
}

SKIP_BUILDINGS: Set[str] = {
    "SupplyDepot", "SupplyDepotLowered", "CreepTumor",
    "CreepTumorBurrowed", "CreepTumorQueen", "ShieldBattery",
}


def _clean_building_name(raw_name: str) -> str:
    for prefix in ("Protoss", "Terran", "Zerg"):
        raw_name = raw_name.replace(prefix, "")
    for suffix in ("Lower", "Upper"):
        raw_name = raw_name.replace(suffix, "")
    return raw_name.strip()


def _get_owner_pid(event) -> Optional[int]:
    for attr in ('control_pid', 'pid'):
        pid = getattr(event, attr, None)
        if pid is not None and pid > 0:
            return pid
    unit = getattr(event, 'unit', None)
    if unit is not None:
        owner = getattr(unit, 'owner', None)
        if owner is not None and getattr(owner, 'pid', None) and owner.pid > 0:
            return owner.pid
    player = getattr(event, 'player', None)
    if player is not None and getattr(player, 'pid', None) and player.pid > 0:
        return player.pid
    return None


def _get_unit_type_name(event) -> Optional[str]:
    name = getattr(event, 'unit_type_name', None)
    if name:
        return name
    unit = getattr(event, 'unit', None)
    if unit is not None:
        return getattr(unit, 'name', None)
    return None


def extract_events(replay, my_pid: int) -> Tuple[List[Dict], List[Dict], Dict]:
    """Walk a replay's tracker events and split them by player.

    Returns `(my_events, opp_events, stats)`. Each event is a dict with `type`
    in {"building", "unit", "upgrade"} plus a `time` (game seconds) and
    optional `x`/`y` for spatial events. Iteration is wrapped in try/except so
    a corrupt tracker stream still yields whatever it managed to read.
    """
    my_events: List[Dict] = []
    opp_events: List[Dict] = []
    stats = {'total': 0, 'pid_failed': 0, 'processed': 0, 'errors': 0}
    event_source = getattr(replay, 'tracker_events', None) or replay.events

    try:
        for event in event_source:
            stats['total'] += 1
            if isinstance(event, UnitInitEvent):
                pid = _get_owner_pid(event)
                raw = _get_unit_type_name(event)
                if pid is None or raw is None:
                    stats['pid_failed'] += 1
                    continue
                clean = _clean_building_name(raw)
                x = getattr(event, 'x', 0)
                y = getattr(event, 'y', 0)

                if clean in SKIP_BUILDINGS:
                    continue
                if clean in KNOWN_BUILDINGS:
                    evt = {'type': 'building', 'subtype': 'init', 'name': clean, 'time': event.second, 'x': x, 'y': y}
                    (my_events if pid == my_pid else opp_events).append(evt)
                    stats['processed'] += 1

            elif isinstance(event, UnitBornEvent):
                pid = _get_owner_pid(event)
                raw = _get_unit_type_name(event)
                if pid is None or raw is None:
                    stats['pid_failed'] += 1
                    continue
                clean = _clean_building_name(raw)
                x = getattr(event, 'x', 0)
                y = getattr(event, 'y', 0)

                is_building = clean in KNOWN_BUILDINGS
                if is_building:
                    if clean in SKIP_BUILDINGS:
                        continue
                    evt = {'type': 'building', 'subtype': 'born', 'name': clean, 'time': event.second, 'x': x, 'y': y}
                else:
                    if clean in SKIP_UNITS:
                        continue
                    evt = {'type': 'unit', 'name': clean, 'time': event.second, 'x': x, 'y': y}
                (my_events if pid == my_pid else opp_events).append(evt)
                stats['processed'] += 1

            elif isinstance(event, UnitTypeChangeEvent):
                pid = _get_owner_pid(event)
                raw = _get_unit_type_name(event)
                if pid is None or raw is None:
                    continue
                clean = _clean_building_name(raw)
                x = getattr(event.unit, 'x', 0) if getattr(event, 'unit', None) else 0
                y = getattr(event.unit, 'y', 0) if getattr(event, 'unit', None) else 0

                if clean in KNOWN_BUILDINGS and clean in MORPH_BUILDINGS:
                    if clean in SKIP_BUILDINGS:
                        continue
                    evt = {'type': 'building', 'subtype': 'morph', 'name': clean, 'time': event.second, 'x': x, 'y': y}
                    (my_events if pid == my_pid else opp_events).append(evt)
                    stats['processed'] += 1

            elif isinstance(event, UnitDoneEvent):
                pid = _get_owner_pid(event)
                raw = _get_unit_type_name(event)
                if pid is None or raw is None:
                    continue
                clean = _clean_building_name(raw)
                x = getattr(event.unit, 'x', 0) if getattr(event, 'unit', None) else 0
                y = getattr(event.unit, 'y', 0) if getattr(event, 'unit', None) else 0

                if clean in KNOWN_BUILDINGS:
                    pass
                elif clean not in SKIP_UNITS:
                    evt = {'type': 'unit', 'name': clean, 'time': event.second, 'x': x, 'y': y}
                    (my_events if pid == my_pid else opp_events).append(evt)
                    stats['processed'] += 1

            elif isinstance(event, UpgradeCompleteEvent):
                pid = _get_owner_pid(event)
                name = getattr(event, 'upgrade_type_name', None)
                if pid is None or name is None:
                    stats['pid_failed'] += 1
                    continue
                evt = {'type': 'upgrade', 'name': name, 'time': event.second}
                (my_events if pid == my_pid else opp_events).append(evt)
                stats['processed'] += 1
    except Exception:
        stats['errors'] += 1
        # Graceful exit from broken iterator
        pass

    return my_events, opp_events, stats


# ---------------------------------------------------------------------------
# Macro-event extraction
# ---------------------------------------------------------------------------
# These sets describe production buildings and town-halls for the macro
# engine. Kept here rather than in `analytics.macro_score` so the extractor
# only walks the tracker stream once even if multiple analytics modules
# care about the same shapes.
_PRODUCTION_BUILDING_TYPES: Set[str] = {
    "Barracks", "Factory", "Starport",
    "Gateway", "WarpGate", "RoboticsFacility", "Stargate",
    "Hatchery", "Lair", "Hive",
}

_BASE_TYPES: Set[str] = {
    # Zerg town-halls (morph chain)
    "Hatchery", "Lair", "Hive",
    # Protoss town-halls
    "Nexus",
    # Terran town-halls (morph chain)
    "CommandCenter", "OrbitalCommand", "PlanetaryFortress",
}

_INTERESTING_ABILITIES: Set[str] = {
    # Zerg: queen inject. sc2reader has used both names across versions.
    "InjectLarva", "SpawnLarva", "QueenSpawnLarva",
    # Protoss: chrono boost. New (LotV) and old names.
    "ChronoBoostEnergyCost", "ChronoBoost",
    # Terran: MULE.
    "CalldownMULE",
}

# Substring buckets for the macro ability counter. Modern sc2reader
# replays sometimes report ability names like "Effect_ChronoBoost",
# "QueenMP_SpawnLarva" or other engine-internal variants depending on
# replay version. Substring matching is much more forgiving than the
# exact-name set above and keeps the macro engine working across the
# Wings/HotS/LotV/balance-test patch zoo. The exact set is still tried
# first as a fast path.
_INJECT_TOKENS: Tuple[str, ...] = ("inject", "spawnlarva")
_CHRONO_TOKENS: Tuple[str, ...] = ("chronoboost", "chrono",)
_MULE_TOKENS: Tuple[str, ...] = ("calldownmule", "mule",)


def _normalize_ability_name(event) -> Optional[str]:
    """Best-effort extraction of the canonical ability name.

    Tries (1) ``event.ability_name`` (sc2reader's parsed display name),
    (2) ``event.ability.name`` (the wrapped Ability object), and
    (3) ``event.ability_link``-keyed fallback by lowercasing whatever
    string-y attr we can find. Returns the name or None.
    """
    name = getattr(event, "ability_name", None)
    if name:
        return name
    ability = getattr(event, "ability", None)
    if ability is not None:
        n = getattr(ability, "name", None)
        if n:
            return n
        # Some sc2reader versions wrap as a dict-like with a build_name.
        n = getattr(ability, "build_name", None)
        if n:
            return n
    # Last resort: cast a couple of common alt attributes to string.
    for attr in ("ability_command_name", "ability_id"):
        v = getattr(event, attr, None)
        if v:
            return str(v)
    return None


def _classify_macro_ability(name: str) -> Optional[str]:
    """Bucket an ability name into 'inject' / 'chrono' / 'mule' or None.

    Exact-match against ``_INTERESTING_ABILITIES`` first (fast path),
    then a lowercased substring search against the token lists. This is
    the entry-point that lets us survive ability-name churn across SC2
    patches.
    """
    if not name:
        return None
    if name in _INTERESTING_ABILITIES:
        if "Inject" in name or "SpawnLarva" in name:
            return "inject"
        if "Chrono" in name:
            return "chrono"
        if "MULE" in name:
            return "mule"
    low = name.lower()
    if any(tok in low for tok in _INJECT_TOKENS):
        return "inject"
    if any(tok in low for tok in _CHRONO_TOKENS):
        return "chrono"
    if any(tok in low for tok in _MULE_TOKENS):
        return "mule"
    return None


def _resolve_unit_id(event) -> Optional[int]:
    """Return the most stable unit-id we can pull off a tracker event."""
    unit = getattr(event, "unit", None)
    if unit is not None:
        uid = getattr(unit, "id", None)
        if uid is not None:
            return uid
    return getattr(event, "unit_id", None)


def extract_macro_events(replay, my_pid: int) -> Dict:
    """Walk the replay once and pull every event the macro engine needs.

    Returns a dict with the following keys:

      ``ability_events``       List[{ability_name, time}]
                               Filtered to InjectLarva / ChronoBoostEnergyCost
                               / CalldownMULE for ``my_pid``.

      ``stats_events``         List[{time, food_used, food_made,
                               minerals_current, vespene_current, food_workers,
                               minerals_collection_rate,
                               vespene_collection_rate}] for ``my_pid``.

      ``production_buildings`` List[{name, unit_id, born_time, died_time}]
                               Production buildings (Barracks, Gateway, etc.)
                               and town-halls. ``died_time`` defaults to
                               game_length when no death event was seen.

      ``bases``                List of the same shape, filtered to town-halls
                               (Hatchery/Lair/Hive, Nexus, CC/OC/PF). Used by
                               inject / chrono / MULE expectations.

      ``unit_births``          List[{name, time, unit_id}] of every non-
                               building unit owned by ``my_pid``. Used for
                               idle-production heuristics.

      ``game_length_sec``      Game length in seconds (for capping died_time).

    The function is wrapped in a broad try/except so corrupt tracker streams
    still return a partial bundle. Building type changes (Hatchery -> Lair ->
    Hive, CC -> OC -> PF) are followed by ``UnitTypeChangeEvent`` so the same
    `unit_id` records pick up the new ``name``.
    """
    out: Dict[str, list] = {
        "ability_events": [],
        "stats_events": [],
        "production_buildings": [],
        "bases": [],
        "unit_births": [],
    }
    gl = getattr(replay, "game_length", None)
    game_end = gl.seconds if gl is not None and hasattr(gl, "seconds") else 0
    out["game_length_sec"] = game_end

    # Track building lifetimes by unit_id so morphs are followed naturally.
    lifetimes: Dict[int, Dict] = {}

    tracker = getattr(replay, "tracker_events", None) or []
    try:
        for event in tracker:
            try:
                if isinstance(event, PlayerStatsEvent):
                    pid = getattr(event, "pid", None)
                    if pid is None:
                        player = getattr(event, "player", None)
                        pid = getattr(player, "pid", None) if player else None
                    if pid != my_pid:
                        continue
                    out["stats_events"].append({
                        "time": getattr(event, "second", 0),
                        "food_used": getattr(event, "food_used", 0),
                        "food_made": getattr(event, "food_made", 0),
                        "minerals_current": getattr(event, "minerals_current", 0),
                        "vespene_current": getattr(event, "vespene_current", 0),
                        "food_workers": getattr(event, "food_workers", 0),
                        "minerals_collection_rate":
                            getattr(event, "minerals_collection_rate", 0),
                        "vespene_collection_rate":
                            getattr(event, "vespene_collection_rate", 0),
                    })
                    continue

                if isinstance(event, (UnitBornEvent, UnitInitEvent, UnitDoneEvent)):
                    pid = _get_owner_pid(event)
                    if pid != my_pid:
                        continue
                    raw = _get_unit_type_name(event)
                    if not raw:
                        continue
                    clean = _clean_building_name(raw)
                    t = int(getattr(event, "second", 0))
                    uid = _resolve_unit_id(event)

                    if clean in KNOWN_BUILDINGS:
                        # For Zerg, UnitBornEvent IS completion (drone morph).
                        # For Protoss/Terran, UnitDoneEvent is completion.
                        # We accept whichever fires first as the operational
                        # timestamp.
                        is_completion = (
                            isinstance(event, UnitDoneEvent)
                            or (isinstance(event, UnitBornEvent)
                                and clean in _BASE_TYPES)
                        )
                        if is_completion and uid is not None:
                            entry = lifetimes.get(uid)
                            if entry is None:
                                lifetimes[uid] = {
                                    "name": clean, "born": t, "died": None,
                                }
                            else:
                                entry["born"] = min(entry.get("born", t), t)
                                entry["name"] = clean
                    else:
                        if (clean not in SKIP_UNITS
                                and isinstance(event, UnitBornEvent)):
                            out["unit_births"].append({
                                "name": clean, "time": t, "unit_id": uid,
                            })
                    continue

                if isinstance(event, UnitTypeChangeEvent):
                    pid = _get_owner_pid(event)
                    if pid != my_pid:
                        continue
                    raw = _get_unit_type_name(event)
                    if not raw:
                        continue
                    clean = _clean_building_name(raw)
                    uid = _resolve_unit_id(event)
                    if uid in lifetimes and clean in KNOWN_BUILDINGS:
                        lifetimes[uid]["name"] = clean
                    continue

                if UnitDiedEvent is not None and isinstance(event, UnitDiedEvent):
                    uid = _resolve_unit_id(event)
                    if uid in lifetimes:
                        lifetimes[uid]["died"] = int(getattr(event, "second", 0))
                    continue
            except Exception:
                # Swallow per-event errors and keep walking.
                continue
    except Exception:
        # Iterator gave up - return whatever we collected.
        pass

    # Game-event pass for ability uses (inject / chrono / MULE).
    #
    # Robust to ability-name churn: we use ``_classify_macro_ability``
    # which both checks the exact ``_INTERESTING_ABILITIES`` set AND
    # falls back to substring matching ("chrono", "inject"/"spawnlarva",
    # "mule"). That fixes the long-standing "0/119 chronos" bug in
    # modern LotV replays where the ability surfaces as e.g.
    # "ChronoBoostEnergyCost" / "Effect_ChronoBoost" / "QueenMP_SpawnLarva"
    # depending on patch.
    #
    # We also categorize each match so the breakdown popup can show
    # per-discipline counts without re-walking the events.
    game_events = getattr(replay, "events", None) or []
    out.setdefault("ability_counts",
                   {"inject": 0, "chrono": 0, "mule": 0, "other": 0})
    try:
        for event in game_events:
            try:
                pid = getattr(event, "pid", None)
                if pid is None:
                    player = getattr(event, "player", None)
                    pid = getattr(player, "pid", None) if player else None
                if pid != my_pid:
                    continue
                name = _normalize_ability_name(event)
                if not name:
                    continue
                bucket = _classify_macro_ability(name)
                if bucket is None:
                    continue
                out["ability_events"].append({
                    "ability_name": name,
                    "category": bucket,
                    "time": int(getattr(event, "second", 0)),
                })
                out["ability_counts"][bucket] += 1
            except Exception:
                continue
    except Exception:
        pass

    # Materialize lifetime records.
    for uid, info in lifetimes.items():
        born = int(info.get("born") or 0)
        died = info.get("died")
        died_time = int(died) if died is not None else int(game_end or born)
        record = {
            "unit_id": uid,
            "name": info.get("name", "?"),
            "born_time": born,
            "died_time": died_time,
        }
        out["production_buildings"].append(record)
        if record["name"] in _BASE_TYPES:
            out["bases"].append(record)

    return out
