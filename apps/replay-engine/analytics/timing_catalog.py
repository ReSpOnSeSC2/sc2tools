"""Shared canonical catalog of key-timing buildings.

KEEP-IN-SYNC NOTICE
-------------------
This module is duplicated *verbatim* in two repos so the desktop app and
the web SPA share the same canonical taxonomy:

    C:\\SC2TOOLS\\reveal-sc2-opponent-main\\analytics\\timing_catalog.py
    C:\\SC2TOOLS\\SC2Replay-Analyzer\\analytics\\timing_catalog.py

The two copies MUST stay byte-identical. If you edit one, copy the result
straight into the other. A drift-check script is planned at
`scripts/check_shared_modules.py` (see Prompt 8 of
`median-key-timings-prompt-list.md`).

What this module gives you
--------------------------
- ``TimingToken`` dataclass: one row per key-timing building (Z/P/T).
- ``RACE_BUILDINGS``: the canonical ordered per-race list.
- ``relevant_tokens(my_race, opp_race)``: the union of both races' tokens
  in display order (own race first, opponent second). Used to filter the
  Median Key Timings UI to only show buildings that are actually relevant
  to the matchup that was played.
- ``matchup_label(my_race, opp_race)``: ``"PvZ"``-style label.

Run ``python -m analytics.timing_catalog`` to verify every ``icon_file``
referenced here actually exists on disk under
``SC2-Overlay/icons/buildings/`` (searches both repos). A missing icon is
a hard failure - we never ship with broken image paths.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple


# --------------------------------------------------------------------------
# Data model
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class TimingToken:
    """One key-timing building.

    Attributes
    ----------
    token:
        Substring matched against the building name in build-log lines by
        the existing ``_TIMING_RE`` matcher in ``opponent_profiler.py``.
        Must be specific enough not to collide with another building
        (e.g. ``"GreaterSpire"`` rather than ``"Spire"``, which would also
        match ``Spire``).
    display_name:
        Human-readable label shown in the UI (``"Spawning Pool"``).
    internal_name:
        Exact sc2reader unit name; used as the stable key for downstream
        consumers (``"SpawningPool"``).
    icon_file:
        Lowercase filename under ``SC2-Overlay/icons/buildings/``
        (``"spawningpool.png"``).
    tier:
        1 = tech opener, 2 = tech switch, 3 = late tech.
    category:
        One of ``"opener"``, ``"production"``, ``"tech"``, ``"expansion"``,
        ``"defense"``.
    """

    token: str
    display_name: str
    internal_name: str
    icon_file: str
    tier: int
    category: str


# --------------------------------------------------------------------------
# Per-race catalogs (canonical display order)
# --------------------------------------------------------------------------
#
# Order rules:
#   1. Bases / openers first (so the UI's first row is always intuitive).
#   2. Tier 1 production / standard tech next.
#   3. Tier 2 mid-game tech.
#   4. Tier 3 late-game tech last.
#
# Tokens are picked to be the most-specific unique substring of the
# sc2reader internal_name. Where two buildings share a stem (Spire /
# GreaterSpire, RoboticsFacility / RoboticsBay), the longer / more
# specific substring is used so the upstream substring matcher can
# distinguish them deterministically.

_ZERG: Tuple[TimingToken, ...] = (
    TimingToken("Hatchery",        "Hatchery",          "Hatchery",         "hatchery.png",         1, "expansion"),
    TimingToken("Pool",            "Spawning Pool",     "SpawningPool",     "spawningpool.png",     1, "tech"),
    TimingToken("Extractor",       "Extractor",         "Extractor",        "extractor.png",        1, "production"),
    TimingToken("Evolution",       "Evolution Chamber", "EvolutionChamber", "evolutionchamber.png", 1, "tech"),
    TimingToken("RoachWarren",     "Roach Warren",      "RoachWarren",      "roachwarren.png",      1, "production"),
    TimingToken("BanelingNest",    "Baneling Nest",     "BanelingNest",     "banelingnest.png",     2, "production"),
    TimingToken("Lair",            "Lair",              "Lair",             "lair.png",             2, "expansion"),
    TimingToken("HydraliskDen",    "Hydralisk Den",     "HydraliskDen",     "hydraliskden.png",     2, "production"),
    TimingToken("LurkerDen",       "Lurker Den",        "LurkerDen",        "lurkerden.png",        2, "production"),
    TimingToken("Spire",           "Spire",             "Spire",            "spire.png",            2, "production"),
    TimingToken("InfestationPit",  "Infestation Pit",   "InfestationPit",   "infestationpit.png",   2, "tech"),
    TimingToken("Nydus",           "Nydus Network",     "NydusNetwork",     "nydusnetwork.png",     2, "tech"),
    TimingToken("Hive",            "Hive",              "Hive",             "hive.png",             3, "expansion"),
    TimingToken("UltraliskCavern", "Ultralisk Cavern",  "UltraliskCavern",  "ultraliskcavern.png",  3, "production"),
    TimingToken("GreaterSpire",    "Greater Spire",     "GreaterSpire",     "greaterspire.png",     3, "production"),
)

_PROTOSS: Tuple[TimingToken, ...] = (
    TimingToken("Nexus",            "Nexus",             "Nexus",            "nexus.png",            1, "expansion"),
    TimingToken("Pylon",            "Pylon",             "Pylon",            "pylon.png",            1, "production"),
    TimingToken("Assimilator",      "Assimilator",       "Assimilator",      "assimilator.png",      1, "production"),
    TimingToken("Gateway",          "Gateway",           "Gateway",          "gateway.png",          1, "production"),
    TimingToken("WarpGate",         "Warp Gate",         "WarpGate",         "warpgate.png",         1, "production"),
    TimingToken("Forge",            "Forge",             "Forge",            "forge.png",            1, "tech"),
    TimingToken("Cybernetics",      "Cybernetics Core",  "CyberneticsCore",  "cyberneticscore.png",  1, "tech"),
    TimingToken("PhotonCannon",     "Photon Cannon",     "PhotonCannon",     "photoncannon.png",     1, "defense"),
    TimingToken("ShieldBattery",    "Shield Battery",    "ShieldBattery",    "shieldbattery.png",    1, "defense"),
    TimingToken("Twilight",         "Twilight Council",  "TwilightCouncil",  "twilightcouncil.png",  2, "tech"),
    TimingToken("RoboticsFacility", "Robotics Facility", "RoboticsFacility", "roboticsfacility.png", 2, "production"),
    TimingToken("Stargate",         "Stargate",          "Stargate",         "stargate.png",         2, "production"),
    TimingToken("TemplarArchive",   "Templar Archives",  "TemplarArchive",   "templararchive.png",   3, "tech"),
    TimingToken("DarkShrine",       "Dark Shrine",       "DarkShrine",       "darkshrine.png",       3, "tech"),
    TimingToken("RoboticsBay",      "Robotics Bay",      "RoboticsBay",      "roboticsbay.png",      3, "tech"),
    TimingToken("FleetBeacon",      "Fleet Beacon",      "FleetBeacon",      "fleetbeacon.png",      3, "tech"),
)

_TERRAN: Tuple[TimingToken, ...] = (
    TimingToken("CommandCenter",     "Command Center",     "CommandCenter",     "commandcenter.png",     1, "expansion"),
    TimingToken("OrbitalCommand",    "Orbital Command",    "OrbitalCommand",    "orbitalcommand.png",    1, "expansion"),
    TimingToken("SupplyDepot",       "Supply Depot",       "SupplyDepot",       "supplydepot.png",       1, "production"),
    TimingToken("Refinery",          "Refinery",           "Refinery",          "refinery.png",          1, "production"),
    TimingToken("Barracks",          "Barracks",           "Barracks",          "barracks.png",          1, "production"),
    TimingToken("EngineeringBay",    "Engineering Bay",    "EngineeringBay",    "engineeringbay.png",    1, "tech"),
    TimingToken("Bunker",            "Bunker",             "Bunker",            "bunker.png",            1, "defense"),
    TimingToken("MissileTurret",     "Missile Turret",     "MissileTurret",     "missileturret.png",     1, "defense"),
    TimingToken("Factory",           "Factory",            "Factory",           "factory.png",           2, "production"),
    TimingToken("GhostAcademy",      "Ghost Academy",      "GhostAcademy",      "ghostacademy.png",      2, "tech"),
    TimingToken("Starport",          "Starport",           "Starport",          "starport.png",          2, "production"),
    TimingToken("Armory",            "Armory",             "Armory",            "armory.png",            2, "tech"),
    TimingToken("FusionCore",        "Fusion Core",        "FusionCore",        "fusioncore.png",        3, "tech"),
    TimingToken("PlanetaryFortress", "Planetary Fortress", "PlanetaryFortress", "planetaryfortress.png", 3, "expansion"),
)


RACE_BUILDINGS: Dict[str, List[TimingToken]] = {
    "Z": list(_ZERG),
    "P": list(_PROTOSS),
    "T": list(_TERRAN),
}


# --------------------------------------------------------------------------
# Race normalization
# --------------------------------------------------------------------------

_RACE_ALIASES: Dict[str, str] = {
    "z": "Z", "zerg": "Z",
    "p": "P", "protoss": "P", "toss": "P",
    "t": "T", "terran": "T",
}


def normalize_race(race: object) -> str:
    """Return canonical 'Z'/'P'/'T', or '' if unknown / blank.

    Accepts ``"P"``, ``"p"``, ``"Protoss"``, ``"PROTOSS"``, ``"toss"``,
    ``None``, ``""``. Any other input returns ``""`` (the empty-string
    sentinel the rest of the module uses to mean "unknown race").
    """
    if race is None:
        return ""
    key = str(race).strip().lower()
    if not key:
        return ""
    return _RACE_ALIASES.get(key, "")


# Internal alias kept for any older import sites; prefer ``normalize_race``.
_normalize_race = normalize_race


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------


# Memoize: relevant_tokens() is called once per opponent-profile render.
# The cache is keyed by the canonicalized race pair so aliases collapse
# (e.g. ("Protoss", "z") and ("p", "Zerg") share an entry).
_relevant_cache: Dict[Tuple[str, str], Tuple[TimingToken, ...]] = {}


def relevant_tokens(my_race: str, opp_race: str) -> List[TimingToken]:
    """Return the union of tokens for both races in canonical display order.

    Own race first, then opponent race. Tokens whose ``internal_name``
    appears in both lists (none today, but future-proofed) are emitted
    once, in their first-seen position.

    Returns an empty list if either race is unknown or blank.
    """
    my = _normalize_race(my_race)
    opp = _normalize_race(opp_race)
    if not my or not opp:
        return []

    cache_key = (my, opp)
    cached = _relevant_cache.get(cache_key)
    if cached is not None:
        return list(cached)

    seen: set = set()
    out: List[TimingToken] = []
    for race in (my, opp):
        for tok in RACE_BUILDINGS[race]:
            if tok.internal_name in seen:
                continue
            seen.add(tok.internal_name)
            out.append(tok)

    _relevant_cache[cache_key] = tuple(out)
    return out


def matchup_label(my_race: object, opp_race: object) -> str:
    """Return a ``"PvZ"``-style matchup label.

    Returns ``""`` if either race is unknown.
    """
    my = _normalize_race(my_race)
    opp = _normalize_race(opp_race)
    if not my or not opp:
        return ""
    return f"{my}v{opp}"


# --------------------------------------------------------------------------
# Icon-existence self-test
# --------------------------------------------------------------------------
#
# Run as ``python -m analytics.timing_catalog`` from either repo root.
# Treats a missing icon as a hard failure (exit 1) so we never ship a
# catalog entry that would render a broken <img> in the UI.


def _candidate_icon_dirs() -> List[Path]:
    """Return all ``SC2-Overlay/icons/buildings/`` dirs that actually exist.

    Searches:
      - this file's own repo (``<repo>/SC2-Overlay/icons/buildings/``);
      - the sibling repo at the same parent level
        (``<sibling>/SC2-Overlay/icons/buildings/``);
      - the explicit reveal-sc2-opponent-main / SC2Replay-Analyzer
        siblings, in case the file is being run from a third location.
    """
    here = Path(__file__).resolve().parent  # .../<repo>/analytics
    repo_root = here.parent                 # .../<repo>
    parent = repo_root.parent               # .../SC2TOOLS  (typically)

    candidates = [
        repo_root / "SC2-Overlay" / "icons" / "buildings",
        parent / "reveal-sc2-opponent-main" / "SC2-Overlay" / "icons" / "buildings",
        parent / "SC2Replay-Analyzer" / "SC2-Overlay" / "icons" / "buildings",
    ]
    # Dedup while preserving order.
    seen: set = set()
    out: List[Path] = []
    for d in candidates:
        key = str(d)
        if key in seen:
            continue
        seen.add(key)
        if d.is_dir():
            out.append(d)
    return out


if __name__ == "__main__":
    import sys

    icon_dirs = _candidate_icon_dirs()
    if not icon_dirs:
        print(
            "FAIL: no SC2-Overlay/icons/buildings/ directory found near "
            f"{Path(__file__).resolve().parent.parent}",
            file=sys.stderr,
        )
        sys.exit(2)

    print(f"Searching {len(icon_dirs)} icon dir(s):")
    for d in icon_dirs:
        print(f"  {d}")

    missing: List[Tuple[str, str, str]] = []  # (race, internal_name, icon_file)
    total = 0
    for race, tokens in RACE_BUILDINGS.items():
        for tok in tokens:
            total += 1
            if not any((d / tok.icon_file).is_file() for d in icon_dirs):
                missing.append((race, tok.internal_name, tok.icon_file))

    if missing:
        print(f"\nFAIL - {len(missing)} of {total} icons missing:", file=sys.stderr)
        for race, name, icon in missing:
            print(f"  {race}: {name} -> {icon}", file=sys.stderr)
        sys.exit(1)

    print(f"\nOK - all {total} icons present.")

    # Public-API smoke checks. Cheap, but they catch obvious refactor breakage.
    pvz = relevant_tokens("Protoss", "z")
    assert pvz, "PvZ relevant_tokens should be non-empty"
    assert pvz[0].internal_name == "Nexus", \
        "Own race should appear first in relevant_tokens()"
    assert any(t.internal_name == "SpawningPool" for t in pvz), \
        "PvZ must include opponent's SpawningPool"
    assert all(t.internal_name != "Barracks" for t in pvz), \
        "PvZ must NOT include Barracks"

    zvt = relevant_tokens("Z", "Terran")
    assert zvt[0].internal_name == "Hatchery", \
        "ZvT should start with Hatchery (own race first)"
    assert any(t.internal_name == "Barracks" for t in zvt), \
        "ZvT must include opponent's Barracks"

    pvp = relevant_tokens("p", "P")
    assert pvp, "PvP should be non-empty"
    pvp_internal = [t.internal_name for t in pvp]
    assert len(pvp_internal) == len(set(pvp_internal)), \
        "Mirror matchup must not duplicate any building"

    assert matchup_label("p", "Z") == "PvZ", \
        "matchup_label normalization broken"
    assert matchup_label("Terran", "terran") == "TvT"
    assert matchup_label("???", "z") == "", \
        "unknown race should yield empty label"
    assert relevant_tokens("???", "Z") == [], \
        "unknown race should return empty list"
    assert relevant_tokens("Z", "") == [], \
        "blank opp race should return empty list"

    print("API smoke tests passed.")
