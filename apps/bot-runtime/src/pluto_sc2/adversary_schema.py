"""Separate race contracts for explicitly privileged learning opponents.

The Protoss player's human-interface contract is deliberately not imported or
changed here. Opponents may see their own entire army, but never fogged enemies.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json

PROFILE = "adversary-global-own-visible-enemy-v1"
HISTORY = 4
SCALARS = 20
GRID_SIZE = 8
GRID_CHANNELS = 6


@dataclass(frozen=True)
class RaceSpec:
    race: str
    worker: str
    bases: tuple[str, ...]
    buildings: tuple[str, ...]
    train: tuple[str, ...]
    morphs: tuple[str, ...]
    upgrades: tuple[str, ...]
    extras: tuple[str, ...]
    forms: tuple[str, ...]

    @property
    def own_types(self):
        return tuple(dict.fromkeys(self.buildings + self.train + self.morphs + self.forms))

    @property
    def action_names(self):
        return ("no_op", "harvest_minerals", "harvest_gas",
                *("build_" + s.lower() for s in self.buildings),
                *("train_" + s.lower() for s in self.train),
                *("morph_" + s.lower() for s in self.morphs),
                *("research_" + s.lower() for s in self.upgrades),
                "attack_enemy_base", "attack_visible_enemy", "defend", "retreat", "scout", *self.extras)

    @property
    def base_dim(self):
        return SCALARS + 2 * len(self.own_types) + len(self.upgrades) + 8 + GRID_SIZE**2 * GRID_CHANNELS

    @property
    def input_dim(self):
        return HISTORY * self.base_dim

    @property
    def action_dim(self):
        return len(self.action_names)

    @property
    def observation_size(self):
        return self.input_dim

    def metadata(self, **extra):
        return metadata(self.race, **extra)

    @property
    def schema_version(self):
        return self.race.lower() + "-adversary8-v1"


TERRAN = RaceSpec(
    "Terran", "SCV", ("COMMANDCENTER", "ORBITALCOMMAND", "PLANETARYFORTRESS"),
    ("COMMANDCENTER", "SUPPLYDEPOT", "REFINERY", "BARRACKS", "ENGINEERINGBAY", "BUNKER",
     "MISSILETURRET", "SENSORTOWER", "FACTORY", "GHOSTACADEMY", "ARMORY", "STARPORT", "FUSIONCORE"),
    ("SCV", "MARINE", "MARAUDER", "REAPER", "GHOST", "HELLION", "HELLIONTANK", "WIDOWMINE",
     "SIEGETANK", "CYCLONE", "THOR", "MEDIVAC", "VIKINGFIGHTER", "LIBERATOR", "RAVEN", "BANSHEE", "BATTLECRUISER"),
    ("ORBITALCOMMAND", "PLANETARYFORTRESS"),
    ("STIMPACK", "SHIELDWALL", "PUNISHERGRENADES", "BANSHEECLOAK",
     *(f"TERRANINFANTRYWEAPONSLEVEL{i}" for i in (1, 2, 3)),
     *(f"TERRANINFANTRYARMORSLEVEL{i}" for i in (1, 2, 3)),
     *(f"TERRANVEHICLEWEAPONSLEVEL{i}" for i in (1, 2, 3)),
     *(f"TERRANSHIPWEAPONSLEVEL{i}" for i in (1, 2, 3))),
    ("build_techlab_barracks", "build_reactor_barracks", "build_techlab_factory", "build_reactor_factory",
     "build_techlab_starport", "build_reactor_starport", "lower_depot", "raise_depot",
     "call_mule", "repair", "stim", "siege", "unsiege", "burrow_mine", "unburrow_mine",
     "lift_barracks", "land_barracks", "lift_factory", "land_factory", "lift_starport", "land_starport"),
    ("SUPPLYDEPOTLOWERED", "BARRACKSTECHLAB", "BARRACKSREACTOR", "FACTORYTECHLAB", "FACTORYREACTOR",
     "STARPORTTECHLAB", "STARPORTREACTOR", "BARRACKSFLYING", "FACTORYFLYING", "STARPORTFLYING",
     "SIEGETANKSIEGED", "WIDOWMINEBURROWED", "VIKINGASSAULT", "LIBERATORAG", "MULE"),
)
ZERG = RaceSpec(
    "Zerg", "DRONE", ("HATCHERY", "LAIR", "HIVE"),
    ("HATCHERY", "EXTRACTOR", "SPAWNINGPOOL", "EVOLUTIONCHAMBER", "ROACHWARREN", "BANELINGNEST",
     "SPINECRAWLER", "SPORECRAWLER", "HYDRALISKDEN", "INFESTATIONPIT", "SPIRE", "LURKERDENMP", "ULTRALISKCAVERN"),
    ("DRONE", "OVERLORD", "QUEEN", "ZERGLING", "ROACH", "HYDRALISK", "MUTALISK", "CORRUPTOR",
     "INFESTOR", "SWARMHOSTMP", "ULTRALISK", "VIPER"),
    ("LAIR", "HIVE", "GREATERSPIRE", "BANELING", "RAVAGER", "LURKERMP", "BROODLORD", "OVERSEER"),
    ("ZERGLINGMOVEMENTSPEED", "ZERGLINGATTACKSPEED", "GLIALRECONSTITUTION", "CENTRIFICALHOOKS",
     "EVOLVEMUSCULARAUGMENTS", "EVOLVEGROOVEDSPINES", "BURROW",
     *(f"ZERGMELEEWEAPONSLEVEL{i}" for i in (1, 2, 3)),
     *(f"ZERGMISSILEWEAPONSLEVEL{i}" for i in (1, 2, 3)),
     *(f"ZERGGROUNDARMORSLEVEL{i}" for i in (1, 2, 3)),
     *(f"ZERGFLYERWEAPONSLEVEL{i}" for i in (1, 2, 3))),
    ("inject_larva", "transfuse", "creep_tumor", "corrosive_bile", "burrow_lurker", "unburrow_lurker"),
    ("LARVA", "EGG", "BANELINGCOCOON", "RAVAGERCOCOON", "LURKERMPEGG", "BROODLORDCOCOON",
     "OVERLORDCOCOON", "LURKERMPBURROWED", "CREEPTUMOR", "CREEPTUMORBURROWED", "CREEPTUMORQUEEN"),
)


def get_spec(race: str) -> RaceSpec:
    try:
        return {"Terran": TERRAN, "Zerg": ZERG}[race]
    except KeyError as error:
        raise ValueError("Adversary race must be Terran or Zerg") from error


def metadata(race: str, *, max_apm: int = 600, step_mul: int = 2, **extra) -> dict:
    spec = get_spec(race)
    if type(max_apm) is not int or not 1 <= max_apm <= 10000 or type(step_mul) is not int or not 1 <= step_mul <= 8:
        raise ValueError("Invalid adversary APM or observation step")
    contract = dict(race=race, start_workers=8, profile=PROFILE, max_apm=max_apm, step_mul=step_mul,
                    fog_of_war=True, camera_restricted=False, observation_schema=spec.schema_version,
                    observation_size=spec.input_dim, action_names=list(spec.action_names),
                    action_hash=hashlib.sha256(json.dumps(spec.action_names).encode()).hexdigest())
    if any(key in contract and value != contract[key] for key, value in extra.items()):
        raise ValueError("Cannot override adversary contract fields")
    return {**contract, **extra}


def validate_metadata(value: dict, race: str, *, max_apm: int = 600, step_mul: int = 2) -> None:
    for key, expected in metadata(race, max_apm=max_apm, step_mul=step_mul).items():
        if value.get(key) != expected:
            raise ValueError(f"Adversary checkpoint contract mismatch for {key}")
