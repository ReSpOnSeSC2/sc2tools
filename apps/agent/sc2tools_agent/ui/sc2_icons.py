"""Offline StarCraft entity icons shared by native Companion views."""

from __future__ import annotations

from pathlib import Path
import re


_DIRECTORIES = {"unit": "units", "building": "buildings", "upgrade": "upgrades", "race": "races"}
_ALIASES = {
    "blinktech": "blink", "stimpack": "stim", "shieldwall": "combatshield",
    "punishergrenades": "concussive", "concussiveshells": "concussive",
    "psistormtech": "psistorm", "psionicstorm": "psistorm",
    "adeptpiercingattack": "resonatingglaives", "darktemplarblinkupgrade": "shadowstride",
    "zerglingmovementspeed": "metabolicboost", "zerglingmetabolicboost": "metabolicboost",
    "zerglingattackspeed": "adrenalglands", "overlordspeed": "pneumatizedcarapace",
    "centrificalhooks": "centrifugalhooks", "evolvemuscularaugments": "muscularaugments",
    "evolvegroovedspines": "groovedspines", "lurkerrange": "seismicspines",
    "diggingclaws": "adaptivetalons", "bansheecloak": "cloak", "cloakingfield": "cloak",
    "templararchives": "templararchive", "lurkermpden": "lurkerden", "lurkermp": "lurker",
    "banelingcocoon": "baneling", "ravagercocoon": "ravager", "broodlordcocoon": "broodlord",
    "siegetanksieged": "siegetank", "vikingassault": "viking", "vikingfighter": "viking",
    "thorap": "thor", "liberatorag": "liberator", "widowmineburrowed": "widowmine",
    "lurkerburrowed": "lurker", "lurkermpburrowed": "lurker", "swarmhostmp": "swarmhost",
    "swarmhostburrowedmp": "swarmhost", "overseersiegemode": "overseer",
    "observersiegemode": "observer", "warpprismphasing": "warpprism",
    "overlordtransport": "overlord", "overlordcocoon": "overlord",
    "banelingburrowed": "baneling", "droneburrowed": "drone", "hydraliskburrowed": "hydralisk",
    "infestorburrowed": "infestor", "queenburrowed": "queen", "ravagerburrowed": "ravager",
    "roachburrowed": "roach", "ultraliskburrowed": "ultralisk", "zerglingburrowed": "zergling",
    "supplydepotlowered": "supplydepot", "barracksflying": "barracks",
    "factoryflying": "factory", "starportflying": "starport",
    "commandcenterflying": "commandcenter", "orbitalcommandflying": "orbitalcommand",
    "spinecrawleruprooted": "spinecrawler", "sporecrawleruprooted": "sporecrawler",
}


def icon_root():
    packaged = Path(__file__).resolve().parent / "assets" / "sc2"
    return packaged if packaged.is_dir() else Path(__file__).resolve().parents[3] / "web" / "public" / "icons" / "sc2"


def icon_token(name, kind):
    token = re.sub(r"[^a-z0-9]", "", name.lower()) if isinstance(name, str) else ""
    if kind == "race":
        return {"p": "protoss", "t": "terran", "z": "zerg", "r": "random"}.get(token, token)
    addon = re.fullmatch(r"(?:barracks|factory|starport)(techlab|reactor)", token)
    if kind == "building" and addon:
        return addon.group(1)
    tiered = re.fullmatch(r"(.+?)level([1-3])", token)
    if kind == "upgrade" and tiered:
        family, tier = tiered.groups()
        family = re.sub(r"^terranvehicleandship(?:plating|armors?)$", "terranvehiclearmor", family)
        family = re.sub(r"^terranshiparmors?$", "terranvehiclearmor", family)
        family = re.sub(r"armors$", "armor", family)
        family = re.sub(r"^zerg(melee|missile|flyer)(?:weapons|attacks)$", r"zerg\1attacks", family)
        family = re.sub(r"^zerg(ground|flyer)(?:armor|carapace)$", r"zerg\1carapace", family)
        return family + tier
    return _ALIASES.get(token, token)


def icon_paths(name, kind, *, root=None):
    """Prefer the declared kind, then exact bundled names in other namespaces."""
    asset_root = Path(root) if root is not None else icon_root()
    kinds = list(_DIRECTORIES)
    if isinstance(kind, str) and kind in _DIRECTORIES:
        kinds.remove(kind)
        kinds.insert(0, kind)
    for candidate_kind in kinds:
        token = icon_token(name, candidate_kind)
        if not token:
            continue
        for extension in (".png", ".svg"):
            path = asset_root / _DIRECTORIES[candidate_kind] / (token + extension)
            if path.is_file():
                yield path


def load_icon(name, kind, *, QtGui, root=None):
    for path in icon_paths(name, kind, root=root):
        icon = QtGui.QIcon(str(path))
        if not icon.pixmap(38, 38).isNull():
            return icon
    return QtGui.QIcon()
