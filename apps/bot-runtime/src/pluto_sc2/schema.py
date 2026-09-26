"""Versioned, SC2-independent feature/action contract shared by play and replays.

Changing ordering or normalization requires a new schema version. The spatial
grid is camera-relative; enemy features contain currently visible, detectable
units only. History provides short-term memory without privileged replay data.
"""
from __future__ import annotations

from collections import deque
import numpy as np

SCHEMA_VERSION = "protoss-screen8-v1"
HISTORY_LENGTH = 4
GRID_SIZE = 8
GRID_CHANNELS = 6

BUILD_TYPES = (
    "NEXUS", "PYLON", "ASSIMILATOR", "GATEWAY", "CYBERNETICSCORE", "FORGE",
    "TWILIGHTCOUNCIL", "ROBOTICSFACILITY", "STARGATE", "ROBOTICSBAY",
    "FLEETBEACON", "TEMPLARARCHIVE", "DARKSHRINE", "PHOTONCANNON", "SHIELDBATTERY",
)
TRAIN_TYPES = (
    "PROBE", "ZEALOT", "STALKER", "ADEPT", "SENTRY", "IMMORTAL", "OBSERVER",
    "WARPPRISM", "COLOSSUS", "DISRUPTOR", "PHOENIX", "VOIDRAY", "ORACLE",
    "TEMPEST", "CARRIER", "HIGHTEMPLAR", "DARKTEMPLAR",
)
RESEARCH_UPGRADES = (
    "WARPGATERESEARCH", "BLINKTECH", "CHARGE", "PSISTORMTECH",
    "ADEPTPIERCINGATTACK", "EXTENDEDTHERMALLANCE",
    "PROTOSSGROUNDWEAPONSLEVEL1", "PROTOSSGROUNDWEAPONSLEVEL2", "PROTOSSGROUNDWEAPONSLEVEL3",
    "PROTOSSGROUNDARMORSLEVEL1", "PROTOSSGROUNDARMORSLEVEL2", "PROTOSSGROUNDARMORSLEVEL3",
    "PROTOSSAIRWEAPONSLEVEL1", "PROTOSSAIRWEAPONSLEVEL2", "PROTOSSAIRWEAPONSLEVEL3",
    "PROTOSSAIRARMORSLEVEL1", "PROTOSSAIRARMORSLEVEL2", "PROTOSSAIRARMORSLEVEL3",
    "PROTOSSSHIELDSLEVEL1", "PROTOSSSHIELDSLEVEL2", "PROTOSSSHIELDSLEVEL3",
)
OWN_TYPE_NAMES = BUILD_TYPES + TRAIN_TYPES + ("WARPGATE", "WARPPRISMPHASING", "ARCHON")
SCALAR_NAMES = (
    "time", "minerals", "vespene", "supply_used", "supply_cap", "supply_army",
    "supply_workers", "supply_left", "idle_workers", "army_health", "army_shields",
    "ready_bases", "idle_producers", "mineral_saturation", "gas_saturation",
    "start_x", "start_y", "enemy_start_x", "enemy_start_y", "enemy_terran",
    "enemy_zerg", "enemy_protoss", "enemy_random", "visible_enemy_count",
    "camera_x", "camera_y", "apm_budget",
)
ENEMY_ROLE_NAMES = ("worker", "ground_army", "air_army", "structure", "detector", "cloaked", "ground_dps", "air_dps")
BASE_OBSERVATION_SIZE = len(SCALAR_NAMES) + 2 * len(OWN_TYPE_NAMES) + len(RESEARCH_UPGRADES) + len(ENEMY_ROLE_NAMES) + GRID_CHANNELS * GRID_SIZE * GRID_SIZE
OBSERVATION_SIZE = BASE_OBSERVATION_SIZE * HISTORY_LENGTH

ACTION_NAMES = (
    "no_op", "harvest_minerals", "harvest_gas",
    *(f"build_{name.lower()}" for name in BUILD_TYPES),
    *(f"train_{name.lower()}" for name in TRAIN_TYPES),
    *(f"research_{name.lower()}" for name in RESEARCH_UPGRADES),
    "morph_warpgate", "morph_gateway", "phase_warpprism", "unphase_warpprism",
    "attack_enemy_base", "attack_visible_enemy", "defend", "retreat", "scout",
    "blink_retreat", "guardian_shield", "psionic_storm", "chrono_boost",
    "feedback", "force_field", "oracle_beam_on", "oracle_beam_off",
    "voidray_alignment", "purification_nova", "morph_archon",
    "camera_home", "camera_army", "camera_enemy_start", "camera_north",
    "camera_south", "camera_east", "camera_west",
)
ACTION_TO_INDEX = {name: index for index, name in enumerate(ACTION_NAMES)}


class ObservationStack:
    """Oldest-to-newest history, zero padded at the beginning of each episode."""

    def __init__(self, history_length: int = HISTORY_LENGTH):
        if history_length != HISTORY_LENGTH:
            raise ValueError(f"Schema {SCHEMA_VERSION} requires history_length={HISTORY_LENGTH}")
        self._frames: deque[np.ndarray] = deque(maxlen=history_length)

    def reset(self) -> None:
        self._frames.clear()

    def push(self, observation: np.ndarray) -> np.ndarray:
        frame = np.asarray(observation, dtype=np.float32)
        if frame.shape != (BASE_OBSERVATION_SIZE,) or not np.isfinite(frame).all():
            raise ValueError(f"Expected finite observation of shape ({BASE_OBSERVATION_SIZE},)")
        self._frames.append(frame.copy())
        padding = [np.zeros(BASE_OBSERVATION_SIZE, dtype=np.float32)] * (HISTORY_LENGTH - len(self._frames))
        return np.concatenate(padding + list(self._frames))


def replay_action_for_ability(ability_name: str, unit_type_name: str | None = None) -> int | None:
    """Map SC2 ability enum names to policy labels; targets refine combat elsewhere.

    Unknown abilities are intentionally omitted, never mislabeled as no-op. Raw
    SMART orders require target inspection by the importer to distinguish gather
    from movement/attack. Generic upgrade abilities require level refinement.
    """
    name = ability_name.upper().replace("ABILITYID.", "")
    exact = {
        "MORPH_WARPGATE": "morph_warpgate", "MORPH_GATEWAY": "morph_gateway",
        "MORPH_WARPPRISMPHASINGMODE": "phase_warpprism",
        "MORPH_WARPPRISMTRANSPORTMODE": "unphase_warpprism",
        "EFFECT_BLINK_STALKER": "blink_retreat", "EFFECT_BLINK": "blink_retreat",
        "GUARDIANSHIELD_GUARDIANSHIELD": "guardian_shield",
        "PSISTORM_PSISTORM": "psionic_storm", "EFFECT_CHRONOBOOSTENERGYCOST": "chrono_boost",
        "FEEDBACK_FEEDBACK": "feedback", "FORCEFIELD_FORCEFIELD": "force_field",
        "BEHAVIOR_PULSARBEAMON": "oracle_beam_on", "BEHAVIOR_PULSARBEAMOFF": "oracle_beam_off",
        "EFFECT_VOIDRAYPRISMATICALIGNMENT": "voidray_alignment",
        "EFFECT_PURIFICATIONNOVA": "purification_nova", "MORPH_ARCHON": "morph_archon",
        "RESEARCH_WARPGATE": "research_warpgateresearch", "RESEARCH_BLINK": "research_blinktech",
        "RESEARCH_CHARGE": "research_charge", "RESEARCH_PSISTORM": "research_psistormtech",
        "RESEARCH_ADEPTRESONATINGGLAIVES": "research_adeptpiercingattack",
        "RESEARCH_EXTENDEDTHERMALLANCE": "research_extendedthermallance",
    }
    if name in exact:
        return ACTION_TO_INDEX[exact[name]]
    for unit in BUILD_TYPES:
        if name in {f"PROTOSSBUILD_{unit}", f"BUILD_{unit}"}:
            return ACTION_TO_INDEX[f"build_{unit.lower()}"]
    for unit in TRAIN_TYPES:
        if name.endswith("_" + unit) and any(token in name for token in ("TRAIN", "WARPGATE")):
            return ACTION_TO_INDEX[f"train_{unit.lower()}"]
    for upgrade in RESEARCH_UPGRADES:
        ability_upgrade = upgrade.replace("ARMORSLEVEL", "ARMORLEVEL")
        if name in {f"RESEARCH_{ability_upgrade}", f"FORGERESEARCH_{ability_upgrade}", f"CYBERNETICSCORERESEARCH_{ability_upgrade}"}:
            return ACTION_TO_INDEX[f"research_{upgrade.lower()}"]
    if name in {"ATTACK", "ATTACK_ATTACK", "ATTACK_ATTACKTOWARDS"}:
        return ACTION_TO_INDEX["attack_visible_enemy"]
    if name in {"MOVE", "MOVE_MOVE"}:
        return ACTION_TO_INDEX["scout" if unit_type_name in {"PROBE", "OBSERVER"} else "retreat"]
    return None
