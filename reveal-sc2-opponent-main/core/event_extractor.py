"""
Event extraction from sc2reader replays.

Pulls structured building / unit / upgrade events out of a parsed
replay and partitions them by owner pid into "my events" and
"opponent events". Used by both the analyzer (post-game classification)
and the live overlay watcher (live build-order capture).

The functions here are intentionally tolerant of broken replays --
we wrap the iterator in a try/except so a single corrupt event
won't kill the whole extract.
"""

from typing import Dict, List, Optional, Tuple

from sc2reader.events.tracker import (
    UnitBornEvent,
    UnitInitEvent,
    UnitDoneEvent,
    UpgradeCompleteEvent,
    UnitTypeChangeEvent,
    PlayerStatsEvent,
)
# UnitDiedEvent is the canonical "building/unit was destroyed" tracker event.
# Some sc2reader builds spell it differently or omit it entirely; fall back
# gracefully so the macro extractor can still run.
try:
    from sc2reader.events.tracker import UnitDiedEvent  # type: ignore
except ImportError:  # pragma: no cover
    UnitDiedEvent = None  # type: ignore

from .build_definitions import (
    KNOWN_BUILDINGS,
    MORPH_BUILDINGS,
    SKIP_UNITS,
    SKIP_BUILDINGS,
)


def _clean_building_name(raw_name: str) -> str:
    """Strip race prefixes and Lower/Upper suffixes from sc2reader unit names."""
    for prefix in ("Protoss", "Terran", "Zerg"):
        raw_name = raw_name.replace(prefix, "")
    for suffix in ("Lower", "Upper"):
        raw_name = raw_name.replace(suffix, "")
    return raw_name.strip()


def _get_owner_pid(event) -> Optional[int]:
    """Resolve the owning player pid from a tracker event, with fallbacks."""
    for attr in ("control_pid", "pid"):
        pid = getattr(event, attr, None)
        if pid is not None and pid > 0:
            return pid
    unit = getattr(event, "unit", None)
    if unit is not None:
        owner = getattr(unit, "owner", None)
        if owner is not None and getattr(owner, "pid", None) and owner.pid > 0:
            return owner.pid
    player = getattr(event, "player", None)
    if player is not None and getattr(player, "pid", None) and player.pid > 0:
        return player.pid
    return None


def _get_unit_type_name(event) -> Optional[str]:
    """Return the unit_type_name from an event, falling back to event.unit.name."""
    name = getattr(event, "unit_type_name", None)
    if name:
        return name
    unit = getattr(event, "unit", None)
    if unit is not None:
        return getattr(unit, "name", None)
    return None


def extract_events(replay, my_pid: int) -> Tuple[List[Dict], List[Dict], Dict]:
    """
    Walk the replay's tracker events and partition them into my/opponent
    event lists. Returns (my_events, opp_events, stats_dict).

    Each event dict has the form:
        building: {type, subtype, name, time, x, y}
        unit:     {type, name, time, x, y}
        upgrade:  {type, name, time}
    """
    my_events: List[Dict] = []
    opp_events: List[Dict] = []
    stats = {"total": 0, "pid_failed": 0, "processed": 0, "errors": 0}
    event_source = getattr(replay, "tracker_events", None) or replay.events

    # Safe iteration to avoid generator crash on broken replays
    try:
        for event in event_source:
            stats["total"] += 1

            if isinstance(event, UnitInitEvent):
                pid = _get_owner_pid(event)
                raw = _get_unit_type_name(event)
                if pid is None or raw is None:
                    stats["pid_failed"] += 1
                    continue
                clean = _clean_building_name(raw)
                x = getattr(event, "x", 0)
                y = getattr(event, "y", 0)

                if clean in SKIP_BUILDINGS:
                    continue
                if clean in KNOWN_BUILDINGS:
                    evt = {
                        "type": "building",
                        "subtype": "init",
                        "name": clean,
                        "time": event.second,
                        "x": x,
                        "y": y,
                    }
                    (my_events if pid == my_pid else opp_events).append(evt)
                    stats["processed"] += 1

            elif isinstance(event, UnitBornEvent):
                pid = _get_owner_pid(event)
                raw = _get_unit_type_name(event)
                if pid is None or raw is None:
                    stats["pid_failed"] += 1
                    continue
                clean = _clean_building_name(raw)
                x = getattr(event, "x", 0)
                y = getattr(event, "y", 0)

                is_building = clean in KNOWN_BUILDINGS
                if is_building:
                    if clean in SKIP_BUILDINGS:
                        continue
                    evt = {
                        "type": "building",
                        "subtype": "born",
                        "name": clean,
                        "time": event.second,
                        "x": x,
                        "y": y,
                    }
                else:
                    if clean in SKIP_UNITS:
                        continue
                    evt = {
                        "type": "unit",
                        "name": clean,
                        "time": event.second,
                        "x": x,
                        "y": y,
                    }
                (my_events if pid == my_pid else opp_events).append(evt)
                stats["processed"] += 1

            elif isinstance(event, UnitTypeChangeEvent):
                pid = _get_owner_pid(event)
                raw = _get_unit_type_name(event)
                if pid is None or raw is None:
                    continue
                clean = _clean_building_name(raw)
                x = getattr(event.unit, "x", 0) if getattr(event, "unit", None) else 0
                y = getattr(event.unit, "y", 0) if getattr(event, "unit", None) else 0

                if clean in KNOWN_BUILDINGS and clean in MORPH_BUILDINGS:
                    if clean in SKIP_BUILDINGS:
                        continue
                    evt = {
                        "type": "building",
                        "subtype": "morph",
                        "name": clean,
                        "time": event.second,
                        "x": x,
                        "y": y,
                    }
                    (my_events if pid == my_pid else opp_events).append(evt)
                    stats["processed"] += 1

            elif isinstance(event, UnitDoneEvent):
                pid = _get_owner_pid(event)
                raw = _get_unit_type_name(event)
                if pid is None or raw is None:
                    continue
                clean = _clean_building_name(raw)
                x = getattr(event.unit, "x", 0) if getattr(event, "unit", None) else 0
                y = getattr(event.unit, "y", 0) if getattr(event, "unit", None) else 0

                if clean in KNOWN_BUILDINGS:
                    pass
                elif clean not in SKIP_UNITS:
                    evt = {
                        "type": "unit",
                        "name": clean,
                        "time": event.second,
                        "x": x,
                        "y": y,
                    }
                    (my_events if pid == my_pid else opp_events).append(evt)
                    stats["processed"] += 1

            elif isinstance(event, UpgradeCompleteEvent):
                pid = _get_owner_pid(event)
                name = getattr(event, "upgrade_type_name", None)
                if pid is None or name is None:
                    stats["pid_failed"] += 1
                    continue
                evt = {"type": "upgrade", "name": name, "time": event.second}
                (my_events if pid == my_pid else opp_events).append(evt)
                stats["processed"] += 1

    except Exception:
        # Graceful exit from broken iterator; still return what we got
        stats["errors"] += 1

    return my_events, opp_events, stats


# ---------------------------------------------------------------------------
# Macro-event extraction
# ---------------------------------------------------------------------------
# These sets describe production buildings and town-halls for the macro
# engine. Kept here rather than in `analytics.macro_score` so the extractor
# only walks the tracker stream once even if multiple analytics modules
# care about the same shapes.
_PRODUCTION_BUILDING_TYPES = {
    "Barracks", "Factory", "Starport",
    "Gateway", "WarpGate", "RoboticsFacility", "Stargate",
    "Hatchery", "Lair", "Hive",
}

_BASE_TYPES = {
    # Zerg town-halls (morph chain)
    "Hatchery", "Lair", "Hive",
    # Protoss town-halls
    "Nexus",
    # Terran town-halls (morph chain)
    "CommandCenter", "OrbitalCommand", "PlanetaryFortress",
}

_INTERESTING_ABILITIES = {
    "InjectLarva", "SpawnLarva", "QueenSpawnLarva",
    "ChronoBoostEnergyCost", "ChronoBoost",
    "CalldownMULE",
}


# Substring buckets for the macro ability counter. Modern sc2reader
# replays sometimes report ability names like "Effect_ChronoBoost",
# "QueenMP_SpawnLarva" or other engine-internal variants depending on
# replay version. Substring matching is much more forgiving than the
# exact-name set above and keeps the macro engine working across the
# Wings/HotS/LotV/balance-test patch zoo. The exact set is still tried
# first as a fast path.
_INJECT_TOKENS = ("inject", "spawnlarva")
_CHRONO_TOKENS = ("chronoboost", "chrono",)
_MULE_TOKENS = ("calldownmule", "mule",)

def _normalize_ability_name(event):
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

def _classify_macro_ability(name: str):
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


def _resolve_unit_id(event):
    """Return the most stable unit-id we can pull off a tracker event."""
    unit = getattr(event, "unit", None)
    if unit is not None:
        uid = getattr(unit, "id", None)
        if uid is not None:
            return uid
    return getattr(event, "unit_id", None)


def _resolve_command_pid(event):
    """Return the player slot id (1-indexed) that *issued* a game/command event.

    sc2reader's game-event ``event.pid`` is the *user_id* (0-indexed user
    position), which does NOT match ``replay.players[i].pid`` (1-indexed
    player slot). Comparing the two directly silently mis-attributes every
    cast — and on any replay where the user was player slot 2, every cast
    gets dropped (e.pid is 0 or 1, never 2), producing the long-standing
    "0 chronos / 0 injects / 0 MULEs" symptom.

    Resolution order, most → least authoritative:

      1. ``event.player.pid``   — sc2reader-resolved Player object slot.
      2. ``event.control_player_id`` — the player owning the unit being
         commanded; matches ``player.pid`` for normal play. Skip the
         ``0`` value, which means "no/unknown owner" (e.g. neutral or
         pre-game system events).
      3. ``event.upkeep_player_id`` — same idea, supply payer.

    Tracker events (``PlayerStatsEvent``, ``UnitBornEvent`` …) already
    expose the canonical player slot via ``event.pid`` and are handled by
    the existing ``_get_owner_pid`` helper — this function is specifically
    for command/ability events on ``replay.events``.
    """
    player = getattr(event, "player", None)
    pl_pid = getattr(player, "pid", None) if player is not None else None
    if pl_pid:
        return pl_pid
    for attr in ("control_player_id", "upkeep_player_id"):
        v = getattr(event, attr, None)
        if v:
            return v
    return None


def extract_macro_events(replay, my_pid: int) -> Dict:
    """Walk the replay once and pull every event the macro engine needs.

    Returns a dict containing 'ability_events' (filtered Inject / Chrono /
    MULE), 'stats_events' (PlayerStatsEvent rows for `my_pid`),
    'production_buildings' (each {name, unit_id, born_time, died_time}),
    'bases' (the same shape filtered to town-halls), 'unit_births' (every
    non-building unit born for `my_pid`), and 'game_length_sec'.

    Kept backward compatible: callers of `extract_events` are unaffected.
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
                continue
    except Exception:
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
                pid = _resolve_command_pid(event)
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


def build_log_lines(
    my_events: List[Dict],
    cutoff_seconds: Optional[int] = None,
    dedupe_units: bool = False,
) -> List[str]:
    """
    Format a list of events as build-order log lines.

    Each line is "[m:ss] Name". If cutoff_seconds is given, only events
    at or before that game-time are included.

    dedupe_units (default False) trims duplicate unit lines so a clean
    build-order display shows only the FIRST time each unit type appears
    (so we don't get 50 zergling lines). Buildings and upgrades are NOT
    deduplicated -- each building is a meaningful tech step. Used by the
    post-game build-timeline widget to avoid swamping the screen.
    """
    lines: List[str] = []
    seen_units: set = set()
    for e in sorted(my_events, key=lambda x: x.get("time", 0)):
        t = e.get("time", 0)
        if cutoff_seconds is not None and t > cutoff_seconds:
            break
        if dedupe_units and e.get("type") == "unit":
            uname = e.get("name", "")
            if uname in seen_units:
                continue
            seen_units.add(uname)
        m = int(t // 60)
        s = int(t % 60)
        lines.append(f"[{m}:{s:02d}] {e.get('name', '?')}")
    return lines


# ---------------------------------------------------------------------------
# Unit movement tracks (for the playback viewer)
# ---------------------------------------------------------------------------
# Combine three sources to get plausible per-unit movement:
#   1. UnitBornEvent / UnitInitEvent  -> initial position waypoint
#   2. UnitPositionsEvent             -> true-position waypoints (sparse,
#                                        only damaged units, every 15s)
#   3. TargetPointCommandEvent + the issuing player's current selection
#      (tracked from SelectionEvent)  -> destination-point waypoints
#   4. UnitDiedEvent                  -> died_t (unit disappears)
# The browser linearly interpolates between consecutive waypoints to render
# each unit at the current scrub time.

try:
    from sc2reader.events.game import (
        TargetPointCommandEvent as _TargetPointCommandEvent,
        SelectionEvent as _SelectionEvent,
    )
except Exception:  # pragma: no cover
    _TargetPointCommandEvent = None
    _SelectionEvent = None

try:
    from sc2reader.events.tracker import UnitPositionsEvent as _UnitPositionsEvent
except Exception:  # pragma: no cover
    _UnitPositionsEvent = None


def _resolve_command_pid_simple(event):
    pl = getattr(event, "player", None)
    pid = getattr(pl, "pid", None) if pl is not None else None
    if pid:
        return pid
    for attr in ("control_player_id", "upkeep_player_id"):
        v = getattr(event, attr, None)
        if v:
            return v
    return None



# ---------------------------------------------------------------------------
# Unit name normalization for the playback viewer
# ---------------------------------------------------------------------------
# sc2reader emits a lot of variants (morphed, sieged, burrowed, "MP" suffix,
# warp-in stage, etc). Map them all to a single canonical name so the
# frontend can look up a single PNG icon per unit type.
_UNIT_NAME_ALIASES = {
    # Terran
    "SiegeTank": "SiegeTank",          "SiegeTankSieged": "SiegeTank",
    "VikingFighter": "Viking",         "VikingAssault": "Viking",
    "HellionTank": "Hellbat",          "Hellion": "Hellion",
    "ThorAP": "Thor",                  "ThorAA": "Thor",
    "WidowMineBurrowed": "WidowMine",
    "LiberatorAG": "Liberator",        "Liberator": "Liberator",
    # Protoss
    "WarpPrismPhasing": "WarpPrism",   "WarpPrism": "WarpPrism",
    "ZealotWarp": "Zealot",            "StalkerWarp": "Stalker",
    "SentryWarp": "Sentry",            "AdeptWarp": "Adept",
    "DarkTemplarWarp": "DarkTemplar",  "HighTemplarWarp": "HighTemplar",
    "ImmortalWarp": "Immortal",        "ColossusWarp": "Colossus",
    "ObserverSiegeMode": "Observer",
    # Zerg -- the "MP" suffix shows up in modern LotV replays
    "BanelingMP": "Baneling",          "BanelingBurrowed": "Baneling",
    "RoachBurrowed": "Roach",          "RoachMP": "Roach",
    "ZerglingBurrowed": "Zergling",
    "HydraliskBurrowed": "Hydralisk",
    "InfestorBurrowed": "Infestor",
    "LurkerMP": "Lurker",              "LurkerMPBurrowed": "Lurker",
    "Lurker": "Lurker",                "LurkerBurrowed": "Lurker",
    "RavagerBurrowed": "Ravager",
    "SwarmHostMP": "SwarmHost",        "SwarmHostMPBurrowed": "SwarmHost",
    "QueenBurrowed": "Queen",
    "BroodLordCocoon": "BroodLord",
    "OverseerSiegeMode": "Overseer",   "OverlordTransport": "Overlord",
    "OverlordTransportCocoon": "Overlord",
    "BroodLord": "BroodLord",
}

# What to NEVER track for movement: workers (too noisy), one-frame fluff,
# spell summons, and cocoons (they're transient morphs). Overlord, Overseer,
# Queen STAY in -- they move and are tactically interesting.
_SKIP_FOR_TRACKING = {
    "MULE", "Larva", "Egg", "Drone", "Probe", "SCV",
    "Broodling", "BroodlingEscort",
    "Changeling", "ChangelingMarine", "ChangelingMarineShield",
    "ChangelingZergling", "ChangelingZealot",
    "InfestedTerran",
    "AutoTurret", "PointDefenseDrone", "Interceptor", "AdeptPhaseShift",
    "OverseerCocoon", "BanelingCocoon", "RavagerCocoon", "LurkerCocoon",
    "TransportOverlordCocoon", "BroodLordCocoon",
    "LocustMP", "LocustMPFlying",
    "Spray", "SprayProtoss", "SprayTerran", "SprayZerg",
    # Building cocoons that sneak into the unit stream
    "BanelingNestCocoon", "GreaterSpireCocoon",
}

def _canonical_unit_name(raw):
    """Map a raw sc2reader unit_type_name to its canonical playback name."""
    if not raw:
        return raw
    name = _clean_building_name(raw)
    return _UNIT_NAME_ALIASES.get(name, name)


def extract_unit_tracks(replay, my_pid):
    """Walk the replay once and produce per-unit movement tracks.

    Returns ``{"my_units": [...], "opp_units": [...]}``. Each entry::

        {"id": int, "name": str, "born": float, "died": float|None,
         "waypoints": [t0, x0, y0, t1, x1, y1, ...]}   # flat for compactness

    Buildings and SKIP_UNITS are filtered out.
    """
    units = {}
    selections = {}

    tracker = getattr(replay, "tracker_events", None) or []
    try:
        for ev in tracker:
            try:
                if isinstance(ev, (UnitBornEvent, UnitInitEvent)):
                    pid = _get_owner_pid(ev)
                    raw = _get_unit_type_name(ev)
                    if pid is None or raw is None:
                        continue
                    name = _canonical_unit_name(raw)
                    if name in KNOWN_BUILDINGS:
                        continue
                    if name in _SKIP_FOR_TRACKING:
                        continue
                    uid = getattr(ev, "unit_id", None)
                    if uid is None:
                        u = getattr(ev, "unit", None)
                        uid = getattr(u, "id", None) if u is not None else None
                    if uid is None:
                        continue
                    t = float(getattr(ev, "second", 0.0))
                    x = float(getattr(ev, "x", 0) or 0)
                    y = float(getattr(ev, "y", 0) or 0)
                    rec = units.get(uid)
                    if rec is None:
                        units[uid] = {
                            "name": name, "owner_pid": pid, "born": t,
                            "died": None,
                            "waypoints": ([(t, x, y)] if (x or y) else []),
                        }
                    else:
                        rec["name"] = name
                        rec["owner_pid"] = pid
                        rec["born"] = min(rec["born"], t)
                        if x or y:
                            rec["waypoints"].append((t, x, y))

                elif _UnitPositionsEvent is not None and isinstance(ev, _UnitPositionsEvent):
                    t = float(getattr(ev, "second", 0.0))
                    for (uid, (x, y)) in (getattr(ev, "positions", []) or []):
                        rec = units.get(uid)
                        if rec is None:
                            continue
                        # sc2reader stores grid units / 4. Normalize to cells.
                        rec["waypoints"].append((t, float(x) / 4.0, float(y) / 4.0))

                elif UnitDiedEvent is not None and isinstance(ev, UnitDiedEvent):
                    uid = getattr(ev, "unit_id", None)
                    if uid is None:
                        u = getattr(ev, "unit", None)
                        uid = getattr(u, "id", None) if u is not None else None
                    rec = units.get(uid)
                    if rec is not None:
                        rec["died"] = float(getattr(ev, "second", 0.0))

                elif isinstance(ev, UnitTypeChangeEvent):
                    uid = getattr(ev, "unit_id", None)
                    if uid is None:
                        u = getattr(ev, "unit", None)
                        uid = getattr(u, "id", None) if u is not None else None
                    rec = units.get(uid)
                    raw = _get_unit_type_name(ev)
                    if rec is not None and raw:
                        c = _canonical_unit_name(raw)
                        if c not in KNOWN_BUILDINGS and c not in _SKIP_FOR_TRACKING:
                            rec["name"] = c
            except Exception:
                continue
    except Exception:
        pass

    # Game-event pass: track selection + emit destination waypoints.
    if _TargetPointCommandEvent is not None and _SelectionEvent is not None:
        for ev in (getattr(replay, "events", None) or []):
            try:
                if isinstance(ev, _SelectionEvent):
                    if getattr(ev, "control_group", -1) != 10:
                        continue
                    pid = _resolve_command_pid_simple(ev)
                    if not pid:
                        continue
                    new_ids = list(getattr(ev, "new_unit_ids", []) or [])
                    if new_ids:
                        selections[pid] = set(new_ids)
                    continue
                if isinstance(ev, _TargetPointCommandEvent):
                    pid = _resolve_command_pid_simple(ev)
                    if not pid:
                        continue
                    sel = selections.get(pid)
                    if not sel:
                        continue
                    t = float(getattr(ev, "second", 0.0))
                    x = float(getattr(ev, "x", 0) or 0)
                    y = float(getattr(ev, "y", 0) or 0)
                    if not (x or y):
                        continue
                    for uid in sel:
                        rec = units.get(uid)
                        if rec is None or rec.get("owner_pid") != pid:
                            continue
                        if rec.get("died") is not None and t > rec["died"]:
                            continue
                        rec["waypoints"].append((t, x, y))
            except Exception:
                continue

    my_units, opp_units = [], []
    for uid, rec in units.items():
        wps = rec["waypoints"]
        if not wps:
            continue
        wps.sort(key=lambda p: p[0])
        compact = [wps[0]]
        for (t, x, y) in wps[1:]:
            (pt, px, py) = compact[-1]
            if abs(x - px) < 0.5 and abs(y - py) < 0.5 and (t - pt) < 30:
                continue
            compact.append((t, x, y))
        flat = []
        for (t, x, y) in compact:
            flat.extend([round(t, 2), round(x, 2), round(y, 2)])
        out = {
            "id": uid,
            "name": rec["name"],
            "born": round(rec["born"], 2),
            "died": (round(rec["died"], 2) if rec["died"] is not None else None),
            "waypoints": flat,
        }
        (my_units if rec["owner_pid"] == my_pid else opp_units).append(out)

    return {"my_units": my_units, "opp_units": opp_units}
