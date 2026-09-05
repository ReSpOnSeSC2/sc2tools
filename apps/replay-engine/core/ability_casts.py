"""Ability / spell cast extraction for the map playback viewer.

``map_playback_data.build_playback_data`` walks the replay for units,
buildings and stats. This module adds the layer the web replayer draws
on top of them — the spells. Each cast comes out as::

    {"owner": "me"|"opp", "ability": "<slug>", "t": <real seconds>,
     "x": <map cells>|None, "y": <map cells>|None,
     "targetUnitId": <int>|None, "casterUnitId": <int>,
     "casterUnitIds": [<int>, ...], "source": "command"}

Caster keys are optional. Selection masks and control-group recalls recover
identities; the frontend samples their observed tracks. An ambiguous or
unlocated order stays unplaced. Commands can be unsuccessful; confirmed live
effects come from the separate engine observation layer.

``targetUnitId`` is the one camelCase key in this module: it is part of
the documented cast contract the agent's compaction and the web
replayer were specified against, so it stays spelled that way.

Timestamps come from ``timebase.event_seconds`` — the same real
game-time scale ``extract_unit_tracks`` puts on every waypoint — so a
Psi Storm lands on exactly the clock of the Templar that cast it.
sc2reader's ``event.second`` (``frame // 16``) would run 1.4x fast on
LotV and drift the spells off the units.

Two sc2reader 1.8.0 behaviours shape the extraction. Both were
verified against the repo's ``calibration-replays/`` corpus rather
than read off documentation:

* ``UpdateTargetUnitCommandEvent`` / ``UpdateTargetPointCommandEvent``
  INHERIT ``ability_name`` from the player's previous targeted command
  (``sc2reader/engine/plugins/context.py``:
  ``handleUpdateTargetUnitCommandEvent``). A plain right-click drag
  therefore arrives named "CausticSpray" or "NexusMassRecall" and
  triples the apparent cast count. Across the corpus every such
  inherited event carries ``ability_link == 0`` and no genuine cast
  ever does, so the single ``has_ability and ability_link != 0`` test
  below drops all of them.

* The newest datapack sc2reader 1.8.0 ships is LotV build 80949;
  every modern replay (5.0.x, build 96xxx) falls back to it. SC2 5.0
  inserted an ability into the Nexus block, so modern ability_link
  723 — Chrono Boost — resolves against 80949's entry 723 and comes
  back named "NexusMassRecall". Every event that name lands on in the
  corpus targets a production or tech structure (Nexus, Gateway,
  Stargate, RoboticsFacility, CyberneticsCore, Forge, TwilightCouncil),
  which is Chrono Boost's target set; Strategic Recall targets a
  point. ``_disambiguate`` below splits the two on exactly that.
  Ability links below ~718 are unaffected — Psi Storm (178), EMP
  (243), Force Field (234), Blink (220), Fungal Growth and the rest
  all resolve correctly on modern builds.

``extract_ability_casts`` also returns the raw ability names it could
NOT map. That list is the input to the next patch's mapping update, so
it is surfaced rather than silently dropped.
"""

from __future__ import annotations

import math
from typing import Dict, List, Optional, Tuple

try:
    from .timebase import event_seconds_precise as event_seconds
except ImportError:  # pragma: no cover - see event_extractor for why
    from core.timebase import event_seconds_precise as event_seconds  # type: ignore

try:
    from sc2reader.events.game import (
        CommandEvent as _CommandEvent,
        SelectionEvent as _SelectionEvent,
    )
except Exception:  # pragma: no cover - sc2reader shimmed in unit tests
    _CommandEvent = None
    _SelectionEvent = None


# Raw sc2reader ``ability_name`` -> stable client-facing slug.
#
# Raw names drift between patches (and between sc2reader datapacks for
# the SAME patch), so the wire format never carries them. Every alias
# sc2reader 1.8.0 can emit for a covered ability is listed explicitly:
# the dict is the documentation, and a `grep PsiStorm` finds every
# spelling that feeds it. Names are taken from the union of the
# abilities sc2reader can actually name across all 22 of its bundled
# datapacks, cross-checked against what the calibration corpus emits.
ABILITY_SLUGS: Dict[str, str] = {
    # ---- Protoss ---------------------------------------------------
    "PsionicStorm": "PsiStorm",
    "PsiStorm": "PsiStorm",
    "Feedback": "Feedback",
    "ForceField": "ForceField",
    "GuardianShield": "GuardianShield",
    "GravitonBeam": "GravitonBeam",
    "Blink": "Blink",
    "DarkTemplarBlink": "Blink",
    # Zealot Charge is an autocast: the corpus never shows a manual
    # cast. Mapped anyway so a hotkeyed charge is drawn if one appears.
    # ``ResearchCharge`` / ``EvolveBurrowCharge`` are RESEARCH and are
    # deliberately absent — see _RESEARCH_NOT_CASTS.
    "Charge": "Charge",
    "TimeWarp": "TimeWarp",
    "TemporalField": "TimeWarp",
    "TemporalRift": "TimeWarp",
    "ChronoBoost": "ChronoBoost",
    "ChronoBoostEnergyCost": "ChronoBoost",
    # Chrono Boost on every build newer than datapack 80949; see the
    # module docstring and ``_disambiguate``.
    "NexusMassRecall": "ChronoBoost",
    "MassRecall": "MassRecall",
    "MassRecallMothership": "MassRecall",
    "MassRecallMothershipCore": "MassRecall",
    "MothershipMassRecall": "MassRecall",
    "MothershipCoreMassRecall": "MassRecall",
    "SingleRecall": "MassRecall",
    "ArbiterMPRecall": "MassRecall",
    "PurificationNova": "PurificationNova",
    "PurificationNovaTargeted": "PurificationNova",
    "PurificationNovaTargetted": "PurificationNova",  # sc2reader typo
    "Revelation": "Revelation",
    "RevelationMode": "Revelation",
    "OracleRevelation": "Revelation",
    "OracleRevelationMode": "Revelation",
    "PulsarBeam": "PulsarBeam",
    "PulsarCannon": "PulsarBeam",
    "OracleWeapon": "PulsarBeam",
    "BuildOracleStasisTrap": "StasisWard",
    "OracleStasisTrap": "StasisWard",
    "OracleStasisTrapBuild": "StasisWard",
    "OracleStasisTrapActivate": "StasisWard",

    # ---- Terran ----------------------------------------------------
    "EMP": "EMP",
    "EMPRound": "EMP",
    "Stimpack": "Stim",
    "StimpackMarauder": "Stim",
    "UseStimpack": "Stim",
    "StimpackRedirect": "Stim",
    "StimpackMarauderRedirect": "Stim",
    "ScannerSweep": "ScannerSweep",
    "CalldownMULE": "CalldownMULE",
    "SupplyDrop": "SupplyDrop",
    "ExtraSupplies": "SupplyDrop",
    "Yamato": "Yamato",
    "YamatoGun": "Yamato",
    "Snipe": "Snipe",
    "SnipeDoT": "Snipe",
    "SniperRound": "Snipe",
    "ChannelSnipe": "Snipe",
    # The strike itself. Arming the silo (``BuildNuke`` / ``TrainNuke``
    # / ``ArmSiloWithNuke``) is production, not a cast.
    "Nuke": "Nuke",
    "TacticalNukeStrike": "Nuke",
    "TacNukeStrike": "Nuke",
    "Salvage": "Salvage",
    "SalvageShared": "Salvage",
    "SalvageBunker": "Salvage",
    "SalvageBunkerRefund": "Salvage",
    "InterferenceMatrix": "InterferenceMatrix",
    "RavenScramblerMissile": "InterferenceMatrix",
    "AntiArmorMissile": "AntiArmorMissile",
    "RavenShredderMissile": "AntiArmorMissile",
    "WidowMineDetonate": "WidowMineDetonate",
    "WidowMineAttack": "WidowMineDetonate",
    "AttackWidowMine": "WidowMineDetonate",
    "TacticalJump": "TacticalJump",
    "Hyperjump": "TacticalJump",
    # Never emitted by any sc2reader 1.8.0 datapack (Lockdown left the
    # game with WoL). Kept so a future datapack lights it up for free.
    "Lockdown": "Lockdown",

    # ---- Zerg ------------------------------------------------------
    "FungalGrowth": "FungalGrowth",
    "Transfusion": "Transfusion",
    "Transfuse": "Transfusion",
    "SpawnLarva": "SpawnLarva",
    "RavagerCorrosiveBile": "CorrosiveBile",
    "CorrosiveBile": "CorrosiveBile",
    "BlindingCloud": "BlindingCloud",
    "ParasiticBomb": "ParasiticBomb",
    "ViperParasiticBombRelay": "ParasiticBomb",
    "Abduct": "Abduct",
    "CausticSpray": "CausticSpray",
    "Contaminate": "Contaminate",
    # ``EvolveNeuralParasite`` is the research and is deliberately absent.
    "NeuralParasite": "NeuralParasite",
    "InfestorNeuralParasite": "NeuralParasite",
    "SpawnChangeling": "SpawnChangeling",
    "SpawnChangelingTarget": "SpawnChangeling",
    "InfestedTerrans": "InfestedTerran",
    "InfestedTerransLayEgg": "InfestedTerran",
    "SpawnInfestedTerran": "InfestedTerran",
    "MorphToInfestedTerran": "InfestedTerran",

    # ---- Burrow / Unburrow (per-unit spellings) ---------------------
    # ``Burrow<Unit>`` / ``Unburrow<Unit>`` is the modern shape; the
    # Ravager keeps the older ``Down``/``Up`` pair. ``BurrowCharge*``
    # (Roach burrow-move) and ``EvolveBurrow`` / ``ResearchBurrow``
    # are NOT burrow toggles and are deliberately absent.
    "Burrow": "Burrow",
    "BurrowBaneling": "Burrow",
    "BurrowCreepTumor": "Burrow",
    "BurrowDrone": "Burrow",
    "BurrowHydralisk": "Burrow",
    "BurrowInfestedTerran": "Burrow",
    "BurrowInfestor": "Burrow",
    "BurrowLurker": "Burrow",
    "BurrowQueen": "Burrow",
    "BurrowRavagerDown": "Burrow",
    "BurrowRoach": "Burrow",
    "BurrowSwarmHost": "Burrow",
    "BurrowUltralisk": "Burrow",
    "BurrowWidowMine": "Burrow",
    "BurrowZergling": "Burrow",
    "DefilerMPBurrow": "Burrow",
    "Unburrow": "Unburrow",
    "BurrowRavagerUp": "Unburrow",
    "UnburrowBaneling": "Unburrow",
    "UnburrowDrone": "Unburrow",
    "UnburrowHydralisk": "Unburrow",
    "UnburrowInfestedTerran": "Unburrow",
    "UnburrowInfestor": "Unburrow",
    "UnburrowLurker": "Unburrow",
    "UnburrowQueen": "Unburrow",
    "UnburrowRoach": "Unburrow",
    "UnburrowSwarmHost": "Unburrow",
    "UnburrowUltralisk": "Unburrow",
    "UnburrowWidowMine": "Unburrow",
    "UnburrowZergling": "Unburrow",
    "DefilerMPUnburrow": "Unburrow",
}

# Every slug ABILITY_SLUGS can produce. Exported so the agent's
# compaction and the tests can assert the wire vocabulary without
# re-deriving it.
CAST_SLUGS = frozenset(ABILITY_SLUGS.values())

# Research / upgrade commands whose names look like the cast they
# unlock. They are absent from ABILITY_SLUGS on purpose — listed here
# so the omission reads as deliberate and a future edit does not
# "helpfully" add them back.
_RESEARCH_NOT_CASTS = frozenset({
    "ResearchPsiStorm", "ResearchPsiStormTech", "PsiStormTech",
    "ResearchBlink", "BlinkTech", "ResearchDarkTemplarBlinkUpgrade",
    "DarkTemplarBlinkUpgrade", "ResearchCharge", "ResearchStimpack",
    "ResearchBurrow", "EvolveBurrow", "EvolveBurrowCharge",
    "EvolveNeuralParasite", "ResearchGravitonCatapult",
    "ResearchKhaydarinAmulet", "BuildNuke", "TrainNuke",
    "ArmSiloWithNuke",
})

# Which unit actually casts a slug that arrives WITHOUT a map location
# (BasicCommandEvent). Used to pick the caster out of the player's
# active selection so a Stim or a Burrow can still be placed on the
# map. A slug absent here is never position-guessed — it goes out with
# x/y = None and the client only attaches it with a recorded identity.
_CASTER_UNITS: Dict[str, frozenset] = {
    "Stim": frozenset({"Marine", "Marauder"}),
    "GuardianShield": frozenset({"Sentry"}),
    "SpawnChangeling": frozenset({"Overseer"}),
    "PulsarBeam": frozenset({"Oracle"}),
    "Charge": frozenset({"Zealot"}),
    "Salvage": frozenset({"Bunker"}),
    "InterferenceMatrix": frozenset({"Raven"}),
    "AntiArmorMissile": frozenset({"Raven"}),
    "WidowMineDetonate": frozenset({"WidowMine"}),
    "Burrow": frozenset({
        "Baneling", "Drone", "Hydralisk", "Infestor", "Lurker", "Queen",
        "Ravager", "Roach", "SwarmHost", "Ultralisk", "WidowMine",
        "Zergling", "InfestedTerran",
    }),
    "Unburrow": frozenset({
        "Baneling", "Drone", "Hydralisk", "Infestor", "Lurker", "Queen",
        "Ravager", "Roach", "SwarmHost", "Ultralisk", "WidowMine",
        "Zergling", "InfestedTerran",
    }),
}

# A target command does not encode a caster tag. Resolve it only when
# exactly one compatible unit is selected; proximity is not evidence.
_CASTER_UNITS.update({
    "PsiStorm": frozenset({"HighTemplar"}),
    "Feedback": frozenset({"HighTemplar"}),
    "ForceField": frozenset({"Sentry"}),
    "Blink": frozenset({"Stalker", "DarkTemplar"}),
    "ChronoBoost": frozenset({"Nexus"}),
    "MassRecall": frozenset({"Nexus", "Mothership", "MothershipCore"}),
    "TimeWarp": frozenset({"Mothership", "MothershipCore"}),
    "PurificationNova": frozenset({"Disruptor"}),
    "Revelation": frozenset({"Oracle"}),
    "StasisWard": frozenset({"Oracle"}),
    "GravitonBeam": frozenset({"Phoenix"}),
    "CalldownMULE": frozenset({"OrbitalCommand", "OrbitalCommandFlying"}),
    "ScannerSweep": frozenset({"OrbitalCommand", "OrbitalCommandFlying"}),
    "SupplyDrop": frozenset({"OrbitalCommand", "OrbitalCommandFlying"}),
    "EMP": frozenset({"Ghost"}),
    "Snipe": frozenset({"Ghost"}),
    "Nuke": frozenset({"Ghost"}),
    "Yamato": frozenset({"Battlecruiser"}),
    "TacticalJump": frozenset({"Battlecruiser"}),
    "CorrosiveBile": frozenset({"Ravager"}),
    "FungalGrowth": frozenset({"Infestor"}),
    "NeuralParasite": frozenset({"Infestor"}),
    "InfestedTerran": frozenset({"Infestor"}),
    "Abduct": frozenset({"Viper"}),
    "BlindingCloud": frozenset({"Viper"}),
    "ParasiticBomb": frozenset({"Viper"}),
    "CausticSpray": frozenset({"Corruptor"}),
    "Contaminate": frozenset({"Overseer"}),
    "Transfusion": frozenset({"Queen"}),
    "SpawnLarva": frozenset({"Queen"}),
})

# These orders apply to every compatible selected unit. Other abilities
# use one selected caster; when several qualify its identity is unknown.
_GROUP_SELF_CASTS = frozenset({"Stim", "Burrow", "Unburrow", "PulsarBeam", "Salvage"})
_SELF_CASTS = _GROUP_SELF_CASTS | frozenset({"GuardianShield", "SpawnChangeling"})

# Cap on distinct unmapped names reported back. A corrupt or
# far-future replay must not turn the diagnostic into a memory leak.
_MAX_UNMAPPED = 50

# Commands that are unambiguously NOT spells: production, research,
# movement, cargo, structure placement. They are filtered out of the
# unmapped diagnostic so a genuinely new ability is not buried under
# 150 Attack commands and 40 TrainProbes.
#
# Caveat worth knowing before trusting the diagnostic blindly: a few
# real casts ARE named "Build…" (Oracle Stasis Ward is
# ``BuildOracleStasisTrap``). Those are already mapped, but a NEW
# Build-prefixed spell would be filtered here and would have to be
# found by scanning raw ability names directly.
_NON_CAST_PREFIXES = (
    "Build", "Train", "Morph", "Research", "Evolve", "Upgrade",
    "WarpIn", "Cancel", "Halt", "Rally", "Root", "Uproot",
    "Load", "Unload", "Lift", "Land", "Harvest", "Select",
    "Hallucination", "Hallucinate", "Spray",
)
_NON_CAST_EXACT = frozenset({
    "Attack", "AttackMove", "Move", "Patrol", "HoldPosition", "Stop",
    "ScanMove", "RightClick", "Gather", "ReturnCargo", "Repair",
    "Follow", "MULEGather", "MULERepair", "SmartCommand",
    "ArchonWarpSelection", "DroneHarvest",
})


def _is_cast_candidate(name: str) -> bool:
    """Could this unmapped raw name plausibly be a spell worth mapping?"""
    if not name:
        # An ability sc2reader could not name at all — keyed by link.
        # Always worth surfacing.
        return True
    if name in _NON_CAST_EXACT:
        return False
    return not name.startswith(_NON_CAST_PREFIXES)


def _resolve_pid(event) -> Optional[int]:
    """Owning player id for a game event.

    Mirrors ``event_extractor._resolve_command_pid_simple`` — kept
    local so this module does not reach into another module's private
    surface.
    """
    pl = getattr(event, "player", None)
    pid = getattr(pl, "pid", None) if pl is not None else None
    if pid:
        return pid
    for attr in ("control_player_id", "upkeep_player_id"):
        v = getattr(event, attr, None)
        if v:
            return v
    return None


def _disambiguate(slug: str, event) -> str:
    """Split the one raw name that means two different abilities.

    ``NexusMassRecall`` is Chrono Boost on every build newer than
    sc2reader's newest datapack (see the module docstring). The two are
    told apart structurally, which holds on ANY patch: Chrono Boost
    targets a structure (a TargetUnit command, so the event carries
    ``target_unit_id``), Strategic Recall targets a point.
    """
    if slug == "ChronoBoost" and getattr(event, "ability_name", "") == "NexusMassRecall":
        if not hasattr(event, "target_unit_id"):
            return "MassRecall"
    return slug


def _cast_location(event) -> Tuple[Optional[float], Optional[float]]:
    """Map coordinates a targeted command was issued at, or (None, None).

    ``location`` is an ``(x, y, z)`` tuple on TargetPoint and
    TargetUnit commands; ``x``/``y`` are already map cells (sc2reader
    divides the raw fixed-point value by 4096). BasicCommandEvents have
    no location at all, and a TargetUnit command on a unit hidden by
    fog of war reports (0, 0) — both come back as None.
    """
    loc = getattr(event, "location", None)
    if not isinstance(loc, (tuple, list)) or len(loc) < 2:
        return None, None
    try:
        x, y = float(loc[0]), float(loc[1])
    except (TypeError, ValueError):
        return None, None
    if not math.isfinite(x) or not math.isfinite(y) or not (x or y):
        return None, None
    return x, y


def _position_at(flat: List[float], t: float) -> Tuple[Optional[float], Optional[float]]:
    """Interpolate a flat ``[t, x, y, …]`` waypoint track at time ``t``.

    Clamps outside the track's range, matching how the web replayer
    interpolates the same arrays.
    """
    if not flat or len(flat) < 3:
        return None, None
    if t <= flat[0]:
        return float(flat[1]), float(flat[2])
    pt, px, py = flat[0], flat[1], flat[2]
    for i in range(3, len(flat) - 2, 3):
        ct, cx, cy = flat[i], flat[i + 1], flat[i + 2]
        if ct >= t:
            span = ct - pt
            if span <= 0:
                return float(cx), float(cy)
            f = (t - pt) / span
            return float(px + (cx - px) * f), float(py + (cy - py) * f)
        pt, px, py = ct, cx, cy
    return float(px), float(py)


def index_unit_tracks(tracks) -> Dict[int, Dict]:
    """``{unit_id: {name, born, died, waypoints}}`` from
    ``extract_unit_tracks``' output, for caster lookups."""
    index: Dict[int, Dict] = {}
    if not isinstance(tracks, dict):
        return index
    for key in ("my_units", "opp_units"):
        for u in (tracks.get(key) or []):
            if not isinstance(u, dict):
                continue
            uid = u.get("id")
            if uid is None:
                continue
            index[uid] = {
                "name": u.get("name") or "",
                "born": u.get("born") or 0.0,
                "died": u.get("died"),
                "waypoints": u.get("waypoints") or [],
                "forms": u.get("forms") or [],
            }
    return index


def _caster_ids(slug, selection, index, t, replay, frame) -> List[int]:
    """Compatible selected identities, never a nearby/random unit."""
    wanted = _CASTER_UNITS.get(slug)
    if not wanted or not selection:
        return []
    candidates = []
    objects = getattr(replay, "objects", None) or {}
    for uid in selection:
        rec = index.get(uid)
        if rec is not None:
            if t < rec["born"] or (rec["died"] is not None and t >= rec["died"]):
                continue
            name = rec["name"]
            for form in rec["forms"]:
                if form.get("t", 0) <= t:
                    name = form.get("name") or name
        else:
            # Structures are not in unit_tracks. sc2reader's object type
            # history records their actual type at the command's frame.
            obj = objects.get(uid)
            if obj is None:
                continue
            born = getattr(obj, "started_at", None)
            died = getattr(obj, "died_at", None)
            if (born is not None and frame < born) or (died is not None and frame >= died):
                continue
            name = ""
            for at, unit_type in (getattr(obj, "type_history", None) or {}).items():
                if at <= frame:
                    name = getattr(unit_type, "name", "")
            if not name:
                continue
        name = name.replace("Burrowed", "").replace("LurkerMP", "Lurker")
        if name not in wanted:
            continue
        candidates.append(uid)
    return candidates if slug in _GROUP_SELF_CASTS or len(candidates) == 1 else []


def _deselect(ids, event) -> List[int]:
    """Apply SC2 selection masks to the *existing* selection."""
    mode = getattr(event, "mask_type", "None")
    data = list(getattr(event, "mask_data", []) or [])
    if mode in (None, "None"):
        return list(ids)
    if mode == "Mask":
        return [uid for i, uid in enumerate(ids) if i >= len(data) or not data[i]]
    if mode == "OneIndices":
        removed = set(data)
        return [uid for i, uid in enumerate(ids) if i not in removed]
    if mode == "ZeroIndices":
        return [ids[i] for i in data if isinstance(i, int) and 0 <= i < len(ids)]
    return []


def _update_selection(event, groups) -> bool:
    """Track selection deltas and control group set/add/recall commands."""
    is_selection = _SelectionEvent is not None and isinstance(event, _SelectionEvent)
    update = getattr(event, "update_type", None)
    if not is_selection and update not in (0, 1, 2, 4, 5):
        return False
    pid = _resolve_pid(event)
    group = getattr(event, "control_group", -1)
    if not pid or not isinstance(group, int) or not 0 <= group <= 10:
        return True
    banks = groups.setdefault(pid, {})
    if is_selection:
        previous = banks.get(group, []) if hasattr(event, "mask_type") else []
        remaining = _deselect(previous, event)
        banks[group] = sorted(set(remaining + list(getattr(event, "new_unit_ids", []) or [])))
    elif update == 2:
        banks[10] = _deselect(banks.get(group, []), event)
    else:
        active = banks.get(10, [])
        existing = _deselect(banks.get(group, []), event) if update in (1, 5) else []
        banks[group] = sorted(set(existing + active))
        if update in (4, 5):
            # Ctrl/Alt group steal removes selected tags from other banks.
            for bank in list(banks):
                if bank not in (group, 10):
                    banks[bank] = [uid for uid in banks[bank] if uid not in active]
    return True


def extract_ability_casts(replay, my_pid, unit_tracks=None) -> Dict:
    """Walk the replay's command events and pull out the spell casts.

    Returns ``{"casts": [...], "unmapped": {raw_name: count}}``,
    where ``unmapped`` holds the ability names that looked like spells
    but had no slug — the input to the next mapping update. Obvious
    non-casts (production, research, movement) are filtered out of it
    by ``_is_cast_candidate``.

    ``unit_tracks`` is ``extract_unit_tracks``' return value. It is used
    to validate caster identities and type at the command time. Self-cast
    abilities keep null coordinates; the renderer uses that exact identity's
    observed position instead of creating another interpolation here.

    Casts come back sorted by time. Every failure is contained to the
    single event that caused it — playback is additive and a weird
    event must not cost the caller the whole payload.
    """
    casts: List[Dict] = []
    unmapped: Dict[str, int] = {}
    if _CommandEvent is None:
        return {"casts": casts, "unmapped": unmapped}

    index = index_unit_tracks(unit_tracks)
    selections: Dict[int, Dict[int, List[int]]] = {}

    for ev in (getattr(replay, "events", None) or []):
        try:
            if _update_selection(ev, selections):
                continue

            if not isinstance(ev, _CommandEvent):
                continue
            # Drops right-clicks (link 0) AND the Update*CommandEvents
            # that inherit a previous cast's name — see module docstring.
            if not getattr(ev, "has_ability", False):
                continue
            link = getattr(ev, "ability_link", 0) or 0
            if link == 0:
                continue
            if (getattr(ev, "flag", None) or {}).get("set_autocast"):
                continue
            pid = _resolve_pid(ev)
            if not pid:
                continue

            raw = getattr(ev, "ability_name", "") or ""
            slug = ABILITY_SLUGS.get(raw)
            if slug is None:
                # Surface it: today's unknown name is next patch's
                # mapping entry. Abilities sc2reader could not name at
                # all are keyed by link so they stay actionable.
                if not _is_cast_candidate(raw):
                    continue
                key = raw or "<link {0}>".format(link)
                if key in unmapped:
                    unmapped[key] += 1
                elif len(unmapped) < _MAX_UNMAPPED:
                    unmapped[key] = 1
                continue

            slug = _disambiguate(slug, ev)
            t = float(event_seconds(ev, replay))
            if not math.isfinite(t) or t < 0:
                continue
            x, y = _cast_location(ev)
            target_id = getattr(ev, "target_unit_id", None) or None
            caster_ids = _caster_ids(
                slug, selections.get(pid, {}).get(10, []), index, t,
                replay, getattr(ev, "frame", 0),
            )
            cast = {
                "owner": "me" if pid == my_pid else "opp",
                "ability": slug,
                "t": t,
                "x": x,
                "y": y,
                "targetUnitId": target_id,
                # Replay commands include unsuccessful orders. This is
                # evidence of an order, not engine-confirmed impact/buff.
                "source": "command",
            }
            if len(caster_ids) == 1:
                cast["casterUnitId"] = caster_ids[0]
            elif caster_ids:
                cast["casterUnitIds"] = caster_ids
            casts.append(cast)
        except Exception:
            continue

    casts.sort(key=lambda c: c["t"])
    return {"casts": casts, "unmapped": unmapped}
