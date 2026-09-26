"""Replay inspection, causal action extraction, and grouped imitation learning.

SC2 itself reconstructs fog-limited observations. Archive metadata alone cannot
reconstruct a playable state. Labels project human commands onto the bot's
strategic action vocabulary; they do not reproduce cursor positions or micro.
"""

from __future__ import annotations

import asyncio
from collections import Counter
from dataclasses import dataclass
from functools import lru_cache
import hashlib
import importlib.util
import html
import json
import math
import os
from pathlib import Path
import re
import tempfile
from typing import Any, Iterable, Sequence
import zipfile

import numpy as np

from .schema import ACTION_NAMES, ACTION_TO_INDEX, OBSERVATION_SIZE, SCHEMA_VERSION


class ReplayError(ValueError):
    """An input replay or dataset cannot safely be used for training."""


def _text(value: Any) -> str:
    return value.decode("utf-8", errors="replace") if isinstance(value, bytes) else str(value)


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


@lru_cache(maxsize=1)
def _metadata_protocol():
    """Load Blizzard's self-describing metadata decoder on Python 3.12+.

    s2protocol.versions still imports the removed ``imp`` module in some
    releases. Loading its generated module with importlib avoids monkeypatching
    Python. Only versioned header/details/tracker records use the latest schema;
    version-specific bitpacked command events are never guessed.
    """
    import s2protocol

    folder = Path(s2protocol.__file__).parent / "versions"
    candidates = list(folder.glob("protocol[0-9]*.py"))
    if not candidates:
        raise ReplayError("s2protocol has no generated replay decoders.")
    latest = max(candidates, key=lambda path: int(path.stem.removeprefix("protocol")))
    specification = importlib.util.spec_from_file_location("_pluto_replay_metadata_protocol", latest)
    if specification is None or specification.loader is None:
        raise ReplayError("Could not load the replay metadata decoder.")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def _race(value: Any) -> str:
    race = _text(value)
    return {"prot": "Protoss", "terr": "Terran", "zerg": "Zerg", "rand": "Random"}.get(race.casefold(), race)


def _player_name(value: Any) -> str:
    name = html.unescape(_text(value)).replace("<sp/>", "")
    return re.sub(r"^<[^>]*>", "", name).strip()


def _starting_workers(archive: Any) -> dict[int, int]:
    """Count tracker births at loop zero for eligibility, never policy inputs."""
    contents = archive.read_file("replay.tracker.events")
    if not contents:
        return {}
    live_workers: dict[tuple[int, int], int] = {}
    participants: set[int] = set()
    for event in _metadata_protocol().decode_replay_tracker_events(contents):
        if event["_gameloop"] > 0:
            break
        event_type = event["_event"].rsplit(".", 1)[-1]
        if event_type == "SPlayerSetupEvent":
            participants.add(int(event["m_playerId"]))
        elif event_type in {"SUnitBornEvent", "SUnitInitEvent"}:
            owner = int(event.get("m_upkeepPlayerId", 0))
            if owner and _text(event.get("m_unitTypeName", "")).upper() in {"PROBE", "SCV", "DRONE"}:
                live_workers[(event["m_unitTagIndex"], event["m_unitTagRecycle"])] = owner
        elif event_type == "SUnitDiedEvent":
            live_workers.pop((event["m_unitTagIndex"], event["m_unitTagRecycle"]), None)
    counts = Counter(live_workers.values())
    return {player: counts[player] for player in participants}


def inspect_replay(path: str | Path) -> dict[str, Any]:
    """Read actual MPQ metadata without starting SC2 or guessing the player."""
    path = Path(path).expanduser().resolve()
    if not path.is_file():
        raise ReplayError(f"Replay does not exist: {path}")
    if path.suffix.lower() != ".sc2replay":
        raise ReplayError(f"Expected an .SC2Replay file: {path}")
    try:
        import mpyq

        archive = mpyq.MPQArchive(str(path))
        raw_metadata = archive.read_file("replay.gamemetadata.json")
        metadata = json.loads(raw_metadata.decode("utf-8")) if raw_metadata else {}
        players = [
            {
                "player_id": int(player["PlayerID"]),
                "name": _player_name(player.get("Name", "")),
                "race": _race(player.get("AssignedRace", player.get("Race", ""))),
                "result": _text(player.get("Result", "Unknown")),
            }
            for player in metadata.get("Players", [])
        ]
        base_build = metadata.get("BaseBuild")
        protocol = _metadata_protocol()
        header = protocol.decode_replay_header(archive.header["user_data_header"]["content"])
        details = protocol.decode_replay_details(archive.read_file("replay.details"))
        game_loops = header.get("m_elapsedGameLoops")
        game_speed_id = details.get("m_gameSpeed")
        loops_per_second = {0: 9.6, 1: 12.8, 2: 16.0, 3: 19.2, 4: 22.4}.get(game_speed_id)
        if not players or not base_build or any(not player["name"] for player in players) or not metadata.get("MapName"):
            try:
                version = header["m_version"]
                base_build = base_build or version["m_baseBuild"]
                if not players:
                    players = [
                        {
                            "player_id": index + 1,
                            "name": _player_name(player.get("m_name", "")),
                            "race": _race(player.get("m_race", "")),
                            "result": {1: "Win", 2: "Loss"}.get(player.get("m_result"), "Unknown"),
                        }
                        for index, player in enumerate(details["m_playerList"])
                    ]
                elif len(players) == len(details["m_playerList"]):
                    for player, detail in zip(sorted(players, key=lambda entry: entry["player_id"]), details["m_playerList"]):
                        player["name"] = _player_name(detail.get("m_name", player["name"]))
                        # Metadata's assigned race has a language-independent enum.
                        if not player["race"]:
                            player["race"] = _race(detail.get("m_race", ""))
                metadata.setdefault("MapName", _text(details.get("m_title", "Unknown")))
            except (ImportError, KeyError, AttributeError, ValueError) as exc:
                raise ReplayError(
                    "Replay lacks modern metadata and its protocol could not be decoded. "
                    "Install a compatible s2protocol release or use a recent SC2 replay."
                ) from exc
        if not players or len({p["player_id"] for p in players}) != len(players):
            raise ReplayError("Replay player metadata is missing or ambiguous.")
        worker_warning = None
        try:
            starting_workers = _starting_workers(archive)
        except Exception as exc:
            starting_workers = {}
            worker_warning = f"Initial worker count unavailable in tracker metadata: {exc}"
        for player in players:
            player["starting_workers"] = starting_workers.get(player["player_id"])
        return {
            "path": str(path),
            "replay_id": _hash_file(path),
            "map_name": _text(metadata.get("MapName", "Unknown")),
            "game_version": _text(metadata.get("GameVersion", "Unknown")),
            "base_build": int(str(base_build).removeprefix("Base")),
            "data_version": metadata.get("DataVersion"),
            "duration_seconds": round(game_loops / loops_per_second, 3) if game_loops is not None and loops_per_second else None,
            "metadata_duration": metadata.get("Duration"),
            "game_speed": {0: "Slower", 1: "Slow", 2: "Normal", 3: "Fast", 4: "Faster"}.get(game_speed_id, "Unknown"),
            "game_loops": game_loops,
            "map_cache_hashes": [handle[8:].hex() for handle in details.get("m_cacheHandles", []) if handle[:4] == b"s2ma"],
            "players": players,
            "starting_workers_source": "initial tracker events; verified again from SC2 observation during extraction",
            "inspection_warning": worker_warning,
        }
    except ReplayError:
        raise
    except Exception as exc:
        raise ReplayError(f"Could not inspect replay {path.name}: {exc}") from exc


def select_player(
    info: dict[str, Any], player_name: str | None = None, player_id: int | None = None
) -> dict[str, Any]:
    """Require explicit identity, then verify that the selected player is Protoss."""
    if player_name is None and player_id is None:
        raise ReplayError("Select your player with --player-name or --player-id; no player is assumed.")
    if player_id is not None and player_id < 1:
        raise ReplayError("Player ID must be positive; observer ID 0 exposes both sides.")
    candidates = list(info.get("players", []))
    if player_name is not None:
        candidates = [p for p in candidates if p["name"].casefold() == player_name.casefold()]
    if player_id is not None:
        candidates = [p for p in candidates if p["player_id"] == player_id]
    if len(candidates) != 1:
        names = ", ".join(f'{p["player_id"]}: {p["name"]} ({p["race"]})' for p in info.get("players", []))
        raise ReplayError(f"Player selection must match exactly one player. Available: {names}")
    player = candidates[0]
    if player["race"].casefold() != "protoss":
        raise ReplayError(f'Selected player {player["name"]!r} has race {player["race"]!r}; Protoss is required.')
    return player


@dataclass
class ReplayDataset:
    observations: np.ndarray
    masks: np.ndarray
    actions: np.ndarray
    replay_ids: np.ndarray
    game_loops: np.ndarray
    action_game_loops: np.ndarray
    metadata: dict[str, Any]

    def __len__(self) -> int:
        return len(self.actions)


def _validate_dataset(data: ReplayDataset) -> ReplayDataset:
    from .contract import validate_metadata

    try:
        validate_metadata(data.metadata)
    except ValueError as exc:
        raise ReplayError(f"Dataset contract is incompatible: {exc}") from exc
    n = len(data.actions)
    if n == 0:
        raise ReplayError("Dataset contains no examples.")
    if data.metadata.get("schema_version") != SCHEMA_VERSION:
        raise ReplayError("Dataset schema version does not match this bot; re-extract the replays.")
    if data.metadata.get("action_names") != list(ACTION_NAMES):
        raise ReplayError("Dataset action vocabulary does not match this bot.")
    if data.metadata.get("source") != "sc2_replay_observations":
        raise ReplayError("Dataset must declare actual SC2 replay observations as its source.")
    if data.metadata.get("expected_start_workers") != 8 or data.metadata.get("fog_of_war") is not True:
        raise ReplayError("Dataset must use eight-worker starts and player fog of war.")
    if data.metadata.get("fairplay_version") != "spatial-200apm-v1":
        raise ReplayError("Dataset must use the current camera and 200 APM restrictions.")
    if data.observations.shape != (n, OBSERVATION_SIZE):
        raise ReplayError(f"Expected observations shape ({n}, {OBSERVATION_SIZE}), got {data.observations.shape}.")
    if data.observations.dtype.kind != "f" or not np.isfinite(data.observations).all():
        raise ReplayError("Observations must contain finite floating-point values.")
    if data.masks.shape != (n, len(ACTION_NAMES)) or data.masks.dtype.kind != "b":
        raise ReplayError("Action masks have an invalid shape or are not boolean.")
    if data.actions.shape != (n,) or data.actions.dtype.kind not in "iu":
        raise ReplayError("Actions must be a one-dimensional integer array.")
    if np.any(data.actions < 0) or np.any(data.actions >= len(ACTION_NAMES)):
        raise ReplayError("Dataset has an action outside the policy vocabulary.")
    if not data.masks[np.arange(n), data.actions].all():
        raise ReplayError("Dataset labels include actions masked out at their observation.")
    if data.replay_ids.shape != (n,) or data.replay_ids.dtype.kind != "U":
        raise ReplayError("Replay IDs must be a one-dimensional Unicode array, never Python objects.")
    if any(len(value) != 64 or any(char not in "0123456789abcdef" for char in value) for value in np.unique(data.replay_ids)):
        raise ReplayError("Replay IDs must be SHA-256 content hashes.")
    for field in (data.game_loops, data.action_game_loops):
        if field.shape != (n,) or field.dtype.kind not in "iu" or np.any(field < 0):
            raise ReplayError("Frame timestamps must be nonnegative one-dimensional integer arrays.")
    if np.any(data.action_game_loops <= data.game_loops):
        raise ReplayError("Every action must follow its stored observation; future-state labels are rejected.")
    return data


def save_dataset(path: str | Path, data: ReplayDataset) -> None:
    """Validate and atomically replace an NPZ containing no pickled objects."""
    _validate_dataset(data)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(mode="wb", dir=path.parent, prefix=path.name + ".", suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            np.savez_compressed(
                stream,
                observations=data.observations.astype(np.float32),
                masks=data.masks,
                actions=data.actions.astype(np.int64),
                replay_ids=data.replay_ids,
                game_loops=data.game_loops.astype(np.int64),
                action_game_loops=data.action_game_loops.astype(np.int64),
                metadata=np.asarray(json.dumps(data.metadata, allow_nan=False, sort_keys=True)),
            )
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def load_dataset(path: str | Path) -> ReplayDataset:
    """Read arrays with pickle disabled and reject malformed/incompatible data."""
    fields = {"observations", "masks", "actions", "replay_ids", "game_loops", "action_game_loops", "metadata"}
    try:
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            if len(entries) != len(fields) or sum(item.file_size for item in entries) > 4 * 1024**3:
                raise ReplayError("Dataset archive has unexpected entries or exceeds the 4 GiB safety limit.")
        with np.load(path, allow_pickle=False) as arrays:
            if set(arrays.files) != fields:
                raise ReplayError("Dataset fields do not match the required schema.")
            metadata_array = arrays["metadata"]
            if metadata_array.shape != () or metadata_array.dtype.kind != "U":
                raise ReplayError("Dataset metadata must be a scalar JSON string.")
            metadata = json.loads(str(metadata_array))
            if not isinstance(metadata, dict):
                raise ReplayError("Dataset metadata must be a JSON object.")
            dataset = ReplayDataset(metadata=metadata, **{field: arrays[field] for field in fields - {"metadata"}})
        return _validate_dataset(dataset)
    except ReplayError:
        raise
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile) as exc:
        raise ReplayError(f"Could not read dataset {path}: {exc}") from exc


def grouped_split(
    replay_ids: np.ndarray, validation_fraction: float = 0.2, seed: int = 1,
    strata: dict[str, str] | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Split whole replay hashes so adjacent frames never leak into validation."""
    if not math.isfinite(validation_fraction) or not 0 <= validation_fraction < 1:
        raise ReplayError("Validation fraction must be in [0, 1).")
    unique = np.unique(replay_ids)
    if strata is not None:
        if any(str(replay) not in strata for replay in unique):
            raise ReplayError("Stratified splitting requires a matchup for every replay.")
        groups = sorted({strata[str(replay)] for replay in unique})
        rng = np.random.default_rng(seed)
        validation_ids = []
        for group in groups:
            members = unique[[strata[str(replay)] == group for replay in unique]]
            if validation_fraction and len(members) < 2:
                raise ReplayError(f"Matchup {group} needs at least two replays for independent validation.")
            if validation_fraction:
                count = min(len(members) - 1, max(1, math.ceil(len(members) * validation_fraction)))
                validation_ids.extend(rng.permutation(members)[:count].tolist())
        validation = np.isin(replay_ids, validation_ids)
        return np.flatnonzero(~validation), np.flatnonzero(validation)
    if len(unique) < 2 or validation_fraction == 0:
        return np.arange(len(replay_ids)), np.empty(0, dtype=np.int64)
    unique = np.random.default_rng(seed).permutation(unique)
    count = min(len(unique) - 1, max(1, math.ceil(len(unique) * validation_fraction)))
    validation = np.isin(replay_ids, unique[:count])
    return np.flatnonzero(~validation), np.flatnonzero(validation)


def _replay_matchups(dataset: ReplayDataset, *, required: bool = False) -> dict[str, str]:
    """Derive matchup only from verified participant identities in source metadata."""
    matchups = {}
    for report in dataset.metadata.get("replays", []):
        selected = report.get("selected_player", {})
        players = report.get("players", [])
        opponents = [player for player in players if player.get("player_id") != selected.get("player_id")]
        if selected.get("race") == "Protoss" and len(players) == 2 and len(opponents) == 1:
            race = {"Terran": "T", "Protoss": "P", "Zerg": "Z"}.get(opponents[0].get("race"))
            if race:
                replay_id = report["replay_id"]
                matchup = "Pv" + race
                if replay_id in matchups and matchups[replay_id] != matchup:
                    raise ReplayError("Conflicting matchup metadata for the same replay.")
                matchups[replay_id] = matchup
    if required and any(str(replay) not in matchups for replay in np.unique(dataset.replay_ids)):
        raise ReplayError("Matchup balancing/stratification requires verified two-player metadata for every replay.")
    return matchups


def _matchup_weights(sample_matchups: np.ndarray, indices: np.ndarray, enabled: bool) -> dict[str, float]:
    counts = Counter(sample_matchups[indices].tolist())
    return {name: len(indices) / (len(counts) * count) if enabled else 1.0
            for name, count in sorted(counts.items())}


def _replay_outcomes(dataset: ReplayDataset, *, required: bool = False) -> dict[str, str]:
    outcomes = {report['replay_id']: report['selected_player']['result']
                for report in dataset.metadata.get('replays', [])
                if report.get('selected_player', {}).get('result') in ('Win', 'Loss')}
    if required and any(str(replay) not in outcomes for replay in np.unique(dataset.replay_ids)):
        raise ReplayError('Outcome stratification requires an unambiguous selected-player Win/Loss for every replay.')
    return outcomes


def _cap_idle(rows: list[tuple], idle_fraction: float, seed: int) -> list[tuple]:
    if not math.isfinite(idle_fraction) or not 0 <= idle_fraction < 1:
        raise ReplayError("Idle fraction must be in [0, 1).")
    idle = ACTION_TO_INDEX["no_op"]
    non_idle = [i for i, row in enumerate(rows) if row[2] != idle]
    idle_indices = [i for i, row in enumerate(rows) if row[2] == idle]
    limit = int(len(non_idle) * idle_fraction / (1 - idle_fraction))
    keep = set(non_idle)
    if idle_indices and limit:
        keep.update(np.random.default_rng(seed).choice(idle_indices, size=min(limit, len(idle_indices)), replace=False).tolist())
    return [row for index, row in enumerate(rows) if index in keep]


def _project_commands(
    response: Any, previous_loop: int, unit_types: dict[int, str], selected_types: list[str],
    *, screen_context: dict | None = None, eligible_actions: set[int] | None = None,
) -> tuple[list[tuple[int, int]], Counter]:
    """Read successful returned actions, never future state or tracker events."""
    from sc2.ids.ability_id import AbilityId
    from .schema import replay_action_for_ability

    projected: list[tuple[int, int]] = []
    counts: Counter = Counter()
    def distance(first, second):
        return math.hypot(first[0] - second[0], first[1] - second[1])

    def on_screen(point):
        if screen_context is None:
            return True
        camera = screen_context["camera"]
        return abs(point[0] - camera[0]) < 12 and abs(point[1] - camera[1]) < 6.75

    for action_index, action in enumerate(response.actions):
        raw = action.action_raw
        command = None
        producer = None
        spatial = False
        target = None
        target_type = None
        camera_target = None
        if raw.HasField("camera_move"):
            point = raw.camera_move.center_world_space
            camera_target = (point.x, point.y)
        elif action.action_feature_layer.HasField("camera_move") and screen_context is not None:
            point = action.action_feature_layer.camera_move.center_minimap
            width, height = screen_context["map_size"]
            scale = max(width, height) / 64
            camera_target = (point.x * scale, height - point.y * scale)
        if camera_target is not None:
            if screen_context is None or int(action.game_loop) <= previous_loop:
                counts["camera_actions_without_context"] += 1
                continue
            if eligible_actions is not None and action_index not in eligible_actions:
                counts["actions_over_200_apm"] += 1
                continue
            camera = screen_context["camera"]
            if distance(camera_target, screen_context["start"]) < 6:
                label = "camera_home"
            elif distance(camera_target, screen_context["enemy_start"]) < 6:
                label = "camera_enemy_start"
            elif screen_context.get("remembered_army") is not None and distance(camera_target, screen_context["remembered_army"]) < 6:
                label = "camera_army"
            elif distance(camera_target, camera) >= 2:
                dx, dy = camera_target[0] - camera[0], camera_target[1] - camera[1]
                label = ("camera_east" if dx > 0 else "camera_west") if abs(dx) >= abs(dy) else ("camera_north" if dy > 0 else "camera_south")
            else:
                counts["small_camera_moves_ignored"] += 1
                continue
            projected.append((int(action.game_loop), ACTION_TO_INDEX[label]))
            counts["projectable_camera_actions"] += 1
            continue
        if raw.HasField("unit_command"):
            command = raw.unit_command
            types = {unit_types[tag] for tag in command.unit_tags if tag in unit_types}
            producer = next(iter(types)) if len(types) == 1 else None
            if screen_context is not None and (not command.unit_tags or any(tag not in unit_types for tag in command.unit_tags)):
                counts["offscreen_producer_commands"] += 1
                counts["commands_seen"] += 1
                continue
            if command.HasField("target_world_space_pos"):
                target = (command.target_world_space_pos.x, command.target_world_space_pos.y)
            elif command.target_unit_tag:
                if screen_context is not None:
                    target_type = screen_context["entity_types"].get(command.target_unit_tag)
                    target = screen_context["positions"].get(command.target_unit_tag)
                    if target is None:
                        counts["offscreen_or_hidden_target_commands"] += 1
                        counts["commands_seen"] += 1
                        continue
        elif action.action_feature_layer.HasField("unit_command"):
            command = action.action_feature_layer.unit_command
            producer = selected_types[0] if selected_types and len(set(selected_types)) == 1 else None
            spatial = True
        elif action.action_render.HasField("unit_command"):
            # RGB and feature-layer coordinates are different spaces.
            counts["unsupported_render_commands"] += 1
            counts["commands_seen"] += 1
            continue
        if command is None:
            counts["ui_actions_ignored"] += 1
            continue
        counts["commands_seen"] += 1
        if int(action.game_loop) <= previous_loop:
            counts["commands_without_prior_observation"] += 1
            continue
        if eligible_actions is not None and action_index not in eligible_actions:
            counts["actions_over_200_apm"] += 1
            continue
        if spatial and screen_context is not None:
            if not selected_types:
                counts["offscreen_or_unknown_selection_commands"] += 1
                continue
            if command.HasField("target_screen_coord"):
                point = command.target_screen_coord
                x, y = screen_context["camera"]
                target = (x + (point.x - 64) * 24 / 128, y - (point.y - 36) * 24 / 128)
                nearby = [(distance(target, position), tag) for tag, position in screen_context["positions"].items()]
                if nearby:
                    nearest_distance, nearest_tag = min(nearby)
                    if nearest_distance < 1.5:
                        target_type = screen_context["entity_types"].get(nearest_tag)
            elif command.HasField("target_minimap_coord"):
                point = command.target_minimap_coord
                width, height = screen_context["map_size"]
                scale = max(width, height) / 64
                target = (point.x * scale, height - point.y * scale)
        if not spatial and target is not None and not on_screen(target):
            counts["offscreen_or_hidden_target_commands"] += 1
            continue
        try:
            ability = AbilityId(command.ability_id).name
        except ValueError:
            counts["unsupported_commands"] += 1
            counts[f"unsupported_ability_id_{command.ability_id}"] += 1
            continue
        label = replay_action_for_ability(ability, producer)
        if screen_context is not None:
            if ability.startswith("HARVEST_GATHER") or ability == "SMART":
                if target_type and "MINERALFIELD" in target_type:
                    label = ACTION_TO_INDEX["harvest_minerals"]
                elif target_type == "ASSIMILATOR":
                    label = ACTION_TO_INDEX["harvest_gas"]
                else:
                    label = None
            if ability in {"MOVE", "MOVE_MOVE", "EFFECT_BLINK", "EFFECT_BLINK_STALKER"}:
                if producer in {"PROBE", "OBSERVER"} and ability.startswith("MOVE"):
                    label = ACTION_TO_INDEX["scout"]
                elif target is not None and distance(target, screen_context["start"]) < distance(screen_context["camera"], screen_context["start"]) - 1:
                    label = ACTION_TO_INDEX["blink_retreat" if "BLINK" in ability else "retreat"]
                else:
                    label = None
            if ability in {"ATTACK", "ATTACK_ATTACK", "ATTACK_ATTACKTOWARDS"}:
                if target is not None and distance(target, screen_context["enemy_start"]) < 6:
                    label = ACTION_TO_INDEX["attack_enemy_base"]
                elif target is not None and distance(target, screen_context["start"]) < 8:
                    label = ACTION_TO_INDEX["defend"]
                elif screen_context["enemy_visible"] and target is not None and on_screen(target):
                    label = ACTION_TO_INDEX["attack_visible_enemy"]
                else:
                    label = None
        if label is None:
            counts["unsupported_commands"] += 1
            counts[f"unsupported_{ability}"] += 1
        else:
            projected.append((int(action.game_loop), label))
            counts["projectable_commands"] += 1
    return sorted(projected, key=lambda item: item[0]), counts


def _preceding_snapshot(snapshots: list[tuple], action_loop: int) -> tuple | None:
    """SC2 reports a command's issue loop, which can equal the last observation.

    We conservatively use an earlier snapshot instead of assuming an ordering
    for two events carrying the same timestamp.
    """
    return next((snapshot for snapshot in reversed(snapshots) if snapshot[0] < action_loop), None)


async def _extract_one(info: dict, player: dict, step_mul: int, expected_start_workers: int = 8) -> tuple[list[tuple], dict]:
    # Imports are intentionally lazy: metadata inspection does not need a game.
    from s2clientprotocol import sc2api_pb2 as sc_pb
    from sc2.bot_ai import BotAI
    from sc2.game_state import GameState
    from sc2.paths import Paths, latest_executeble
    from .fairplay import ActionBudget, FairPlayController, HumanClient, configure_interface
    from .runner import ManagedSC2Process
    from .sc2_adapter import encode_observation, legal_action_mask
    from .schema import ObservationStack

    rows_by_loop: dict[int, tuple] = {}
    occupied_loops: set[int] = set()
    counts: Counter = Counter()
    if not info.get("data_version"):
        raise ReplayError("This replay lacks DataVersion; exact-version playback cannot be guaranteed. Use a modern replay.")
    base_directory = f'Base{info["base_build"]}'
    if not (Paths.BASE / "Versions" / base_directory).is_dir() or not latest_executeble(Paths.BASE / "Versions", base_directory).is_file():
        raise ReplayError(f'SC2 {base_directory} is not installed. Open this replay in Battle.net SC2 to download its exact historical build, then retry.')
    async with ManagedSC2Process(fullscreen=False, base_build=base_directory, data_hash=info["data_version"]) as server:
        ping = await server.ping()
        if ping.ping.base_build != info["base_build"] or ping.ping.data_version.upper() != info["data_version"].upper():
            raise ReplayError("SC2 launched a different replay build or data version; refusing incompatible playback.")
        request = sc_pb.RequestStartReplay(
            replay_data=Path(info["path"]).read_bytes(),
            observed_player_id=player["player_id"],
            disable_fog=False,
            realtime=False,
            options=sc_pb.InterfaceOptions(
                raw=True, score=True, show_cloaked=False, show_burrowed_shadows=False,
                show_placeholders=False, raw_affects_selection=False,
            ),
        )
        configure_interface(request.options)
        started = await server._execute(start_replay=request)
        if started.start_replay.HasField("error"):
            raise ReplayError(
                f'Replay playback failed for build {info["base_build"]}: '
                f'{started.start_replay.error_details or started.start_replay.error}. '
                "Open this replay once in Battle.net SC2 to download its historical game build and map, then retry."
            )
        client = HumanClient(server._ws)
        client.game_step = step_mul
        await client._execute(obs_action=sc_pb.RequestObserverAction(actions=[sc_pb.ObserverAction(
            camera_follow_player=sc_pb.ActionObserverCameraFollowPlayer(player_id=player["player_id"])
        )]))
        bot = BotAI()
        bot._initialize_variables()
        bot._pluto_replay_mode = True
        bot.fairplay = FairPlayController()
        # Expert selection events belong to the demonstration timeline, not to
        # the bot's pending-selection state. Otherwise valid human commands are
        # masked out just because a human selected their producer a moment ago.
        demonstration_budget = ActionBudget()
        game_data = await client.get_game_data()
        game_info = await client.get_game_info()
        actual = [p for p in game_info.players if p.id == player["player_id"]]
        if len(actual) != 1 or actual[0].actual_race is None or actual[0].actual_race.name != "Protoss":
            raise ReplayError("SC2 playback did not confirm the selected player's Protoss race.")
        bot._prepare_start(client, player["player_id"], game_info, game_data, realtime=False, base_build=info["base_build"])
        stack = ObservationStack()
        previous = None
        snapshots: list[tuple] = []
        first = True
        completed = False
        while True:
            response = await client.observation()
            state = GameState(response.observation)
            if previous is not None:
                old_loop, old_observation, old_mask, old_types, old_selected, old_screen = previous
                for index in sorted(range(len(response.observation.actions)), key=lambda index: response.observation.actions[index].game_loop):
                    action = response.observation.actions[index]
                    timestamp = action.game_loop / 22.4
                    if timestamp < demonstration_budget.last_observed:
                        counts["demonstration_inputs_without_monotonic_timestamp"] += 1
                    elif not demonstration_budget.consume(timestamp):
                        counts["demonstration_inputs_faster_than_bot_limit"] += 1
                groups: dict[int, list[tuple[int, Any]]] = {}
                for index, action in enumerate(response.observation.actions):
                    relevant = any(part.HasField(field) for part in (action.action_raw, action.action_feature_layer, action.action_render)
                                   for field in ("unit_command", "camera_move"))
                    if not relevant:
                        counts["ui_actions_ignored"] += 1
                        continue
                    source = _preceding_snapshot(snapshots, action.game_loop)
                    if source is None:
                        counts["actions_without_prior_observation"] += 1
                        continue
                    groups.setdefault(source[0], []).append((index, action))
                for source_loop, actions in groups.items():
                    source = next(snapshot for snapshot in snapshots if snapshot[0] == source_loop)
                    _, source_observation, source_mask, source_types, source_selected, source_screen = source
                    occupied_loops.add(source_loop)
                    grouped_response = sc_pb.ResponseObservation(actions=[action for _, action in actions])
                    projected, command_counts = _project_commands(
                        grouped_response, source_loop, source_types, source_selected,
                        screen_context=source_screen,
                    )
                    counts.update(command_counts)
                    legal = [(loop, label) for loop, label in projected if source_mask[label]]
                    counts["commands_masked_at_prior_observation"] += len(projected) - len(legal)
                    existing = rows_by_loop.get(source_loop)
                    if existing is not None and existing[2] == ACTION_TO_INDEX["no_op"]:
                        # A same-loop command can arrive one observation after a
                        # tentative idle label; replace it, never keep both.
                        del rows_by_loop[source_loop]
                        existing = None
                    if legal:
                        action_loop, label = legal[0]
                        if existing is None or action_loop < existing[5]:
                            rows_by_loop[source_loop] = (source_observation, source_mask, label, info["replay_id"], source_loop, action_loop)
                        counts["additional_commands_in_same_interval"] += len(legal) - (1 if existing is None else 0)
                if state.game_loop <= old_loop and not response.observation.player_result:
                    raise ReplayError("SC2 replay stopped advancing before a result was reached.")
                if old_loop not in occupied_loops and old_loop not in rows_by_loop and state.game_loop > old_loop:
                    rows_by_loop[old_loop] = (old_observation, old_mask, ACTION_TO_INDEX["no_op"], info["replay_id"], old_loop, state.game_loop)
                counts["observation_intervals"] += 1
            if response.observation.player_result:
                completed = True
                break
            if state.common.player_id != player["player_id"]:
                raise ReplayError("SC2 returned a different perspective; refusing potentially omniscient observations.")
            proto_info = await client._execute(game_info=sc_pb.RequestGameInfo())
            bot._prepare_step(state, proto_info)
            if first:
                bot._prepare_first_step()
                if state.game_loop > 1:
                    raise ReplayError("First replay observation is after the initial game loop; starting worker count cannot be verified.")
                if len(bot.workers) != expected_start_workers:
                    raise ReplayError(f'Expected an eight-worker Protoss start, but {info["path"]} begins with {len(bot.workers)} workers; this replay is not eligible for version 1.')
                counts["starting_workers"] = len(bot.workers)
                first = False
            camera = state.observation_raw.player.camera
            if not camera.HasField("x") or not camera.HasField("y"):
                raise ReplayError("SC2 did not expose the selected replay player's camera; screen-limited extraction cannot proceed.")
            bot.fairplay.sync_camera(bot)
            observation = stack.push(encode_observation(bot))
            mask = await legal_action_mask(bot)
            own = [u for u in bot.all_own_units if bot.fairplay.on_screen(u)]
            enemies = [u for u in bot.enemy_units + bot.enemy_structures if u.is_visible and bot.fairplay.on_screen(u)]
            entities = own + enemies + [u for u in bot.mineral_field + bot.vespene_geyser if u.is_visible and bot.fairplay.on_screen(u)]
            types = {u.tag: u.type_id.name for u in own}
            all_selected = [u for u in bot.all_own_units if u.is_selected]
            selected = [u.type_id.name for u in all_selected] if all(u.tag in types for u in all_selected) else []
            screen = {"camera": (camera.x, camera.y), "start": tuple(bot.start_location),
                      "enemy_start": tuple(bot.enemy_start_locations[0] if bot.enemy_start_locations else bot.game_info.map_center),
                      "map_size": tuple(bot.game_info.map_size), "positions": {u.tag: tuple(u.position) for u in entities},
                      "entity_types": {u.tag: u.type_id.name for u in entities}, "enemy_visible": bool(enemies),
                      "remembered_army": tuple(bot._pluto_last_army_position) if hasattr(bot, "_pluto_last_army_position") else None}
            previous = (state.game_loop, observation.copy(), mask.copy(), types, selected, screen)
            snapshots.append(previous)
            snapshots = snapshots[-3:]
            await client.step()
        if not completed:
            raise ReplayError("Replay extraction ended before the game result; no dataset was written.")
    return [rows_by_loop[loop] for loop in sorted(rows_by_loop)], dict(counts)


def _rows_dataset(rows: list[tuple], metadata: dict) -> ReplayDataset:
    if not rows:
        raise ReplayError("No usable replay examples were extracted.")
    columns = list(zip(*rows))
    return ReplayDataset(
        observations=np.asarray(columns[0], dtype=np.float32), masks=np.asarray(columns[1], dtype=bool),
        actions=np.asarray(columns[2], dtype=np.int64), replay_ids=np.asarray(columns[3], dtype="U64"),
        game_loops=np.asarray(columns[4], dtype=np.int64), action_game_loops=np.asarray(columns[5], dtype=np.int64), metadata=metadata,
    )


def _extraction_metadata(reports: list[dict], idle_fraction: float, seed: int, **extra) -> dict:
    from .contract import model_metadata

    return model_metadata(
        schema_version=SCHEMA_VERSION, source="sc2_replay_observations", fog_of_war=True,
        expected_start_workers=8, camera="follow selected replay player; camera-limited tactical observations",
        alignment="observation strictly precedes action; first legal projected action per interval",
        extractor_version="causal-screen-projection-v8", idle_fraction_max=idle_fraction, seed=seed,
        pacing="Expert input pacing is diagnostic; one projected intention per snapshot; runtime enforces 200 APM.",
        placement_masks="Replay placement masks approximate valid footprints from the current visible screen; live SC2 validates placements.",
        replays=reports,
        limitations="Strategic command categories only. Human cursor targets, control groups, and exact micro are not imitated; unsupported commands are counted and excluded.",
        **extra,
    )


def _replay_cache_key(info: dict, player: dict, idle_fraction: float, seed: int) -> str:
    metadata = _extraction_metadata([], idle_fraction, seed)
    identity = {"replay_id": info["replay_id"], "player_id": player["player_id"], **metadata}
    return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()


def extract_replays(
    paths: Sequence[str | Path], output: str | Path,
    player_name: str | None = None, player_id: int | None = None,
    step_mul: int = 8, idle_fraction: float = 0.25, seed: int = 1, expected_start_workers: int = 8,
    cache_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Cache each fully reconstructed replay, then atomically publish the batch.

    A later replay failure preserves completed shards for retry; an incomplete
    final dataset never replaces an existing output.
    """
    from loguru import logger

    if isinstance(step_mul, bool) or not isinstance(step_mul, int) or step_mul != 8:
        raise ReplayError("Version 1 requires step_mul=8 so replay and policy history have the same cadence.")
    if not 0 <= idle_fraction < 1:
        raise ReplayError("Idle fraction must be in [0, 1).")
    if not paths:
        raise ReplayError("Provide at least one .SC2Replay file.")
    if expected_start_workers != 8:
        raise ReplayError("Version 1 only supports eight-worker Protoss starts.")
    infos = [inspect_replay(path) for path in paths]
    # Validate every selection before launching any game instance.
    selections = [(info, select_player(info, player_name, player_id)) for info in infos]
    for info, player in selections:
        if info.get("game_speed", "Faster") != "Faster":
            raise ReplayError("Version 1 requires Faster game speed for its fixed game-time action budget.")
        worker_count = player.get("starting_workers")
        if worker_count is not None and worker_count != expected_start_workers:
            raise ReplayError(
                f'{Path(info["path"]).name}: {player["name"]} starts with {worker_count} workers; '
                "version 1 requires an eight-worker Protoss start. This replay was rejected before launching SC2."
            )
    rows: list[tuple] = []
    reports = []
    seen: set[str] = set()
    cache_directory = Path(cache_dir) if cache_dir is not None else Path(output).parent / "replay-cache"
    for info, player in selections:
        if info["replay_id"] in seen:
            continue
        seen.add(info["replay_id"])
        cache_key = _replay_cache_key(info, player, idle_fraction, seed)
        cache_path = cache_directory / f"{cache_key}.npz"
        if cache_path.is_file():
            try:
                shard = load_dataset(cache_path)
                shard_reports = shard.metadata.get("replays", [])
                if shard.metadata.get("extraction_cache_key") != cache_key or not np.all(shard.replay_ids == info["replay_id"]):
                    raise ReplayError("Cached replay identity or configuration does not match.")
                if len(shard_reports) != 1 or shard_reports[0]["selected_player"]["player_id"] != player["player_id"]:
                    raise ReplayError("Cached player perspective is incompatible.")
                rows.extend(zip(shard.observations, shard.masks, shard.actions, shard.replay_ids, shard.game_loops, shard.action_game_loops))
                reports.append({**shard_reports[0], **info, "selected_player": player, "cache_hit": True})
                logger.info("Reused validated replay {}: {} samples", Path(info["path"]).name, len(shard))
                continue
            except (ReplayError, KeyError, TypeError) as exc:
                logger.warning("Ignoring invalid replay cache {}: {}", cache_path.name, exc)
        logger.info("Extracting replay {} for {}", Path(info["path"]).name, player["name"])
        try:
            replay_rows, counts = asyncio.run(_extract_one(info, player, step_mul, expected_start_workers))
        except ReplayError:
            raise
        except Exception as exc:
            raise ReplayError(
                f'Could not reconstruct {Path(info["path"]).name} with SC2 build {info["base_build"]} '
                f'({type(exc).__name__}: {exc}). '
                "No replacement dataset was saved; completed replay caches remain available. "
                "If SC2 reports a missing version or map, open this replay in Battle.net SC2 to retrieve it before retrying."
            ) from exc
        if not any(row[2] != ACTION_TO_INDEX["no_op"] for row in replay_rows):
            raise ReplayError(f'No supported, legal human commands were extracted from {info["path"]}.')
        retained = _cap_idle(replay_rows, idle_fraction, seed)
        rows.extend(retained)
        report = {**info, "selected_player": player, "counts": counts, "samples": len(retained), "idle_samples_removed": len(replay_rows) - len(retained), "cache_hit": False}
        reports.append(report)
        shard_metadata = _extraction_metadata([report], idle_fraction, seed, extraction_cache_key=cache_key)
        save_dataset(cache_path, _rows_dataset(retained, shard_metadata))
        logger.info("Completed replay {}: {} samples; {} projected commands; {} projected camera actions",
                    Path(info["path"]).name, len(retained), counts.get("projectable_commands", 0), counts.get("projectable_camera_actions", 0))
    metadata = _extraction_metadata(reports, idle_fraction, seed)
    dataset = _rows_dataset(rows, metadata)
    save_dataset(output, dataset)
    return {"output": str(Path(output).resolve()), "samples": len(dataset), **metadata}


def _merge_datasets(paths: Sequence[str | Path]) -> ReplayDataset:
    if not paths:
        raise ReplayError("Provide at least one dataset path.")
    datasets = [load_dataset(path) for path in paths]
    extraction_fields = ("extractor_version", "alignment", "pacing", "placement_masks")
    reference = {field: datasets[0].metadata.get(field) for field in extraction_fields}
    for dataset in datasets[1:]:
        if any(dataset.metadata.get(field) != value for field, value in reference.items()):
            raise ReplayError("Datasets use different extraction rules; re-import them with the same extractor before combining them.")
    names = ("observations", "masks", "actions", "replay_ids", "game_loops", "action_game_loops")
    arrays = {name: np.concatenate([getattr(dataset, name) for dataset in datasets]) for name in names}
    # Re-importing the same replay/dataset must not silently reweight its examples.
    keys = np.rec.fromarrays([arrays["replay_ids"], arrays["game_loops"], arrays["action_game_loops"], arrays["actions"]])
    _, first_indices = np.unique(keys, return_index=True)
    arrays = {name: array[np.sort(first_indices)] for name, array in arrays.items()}
    metadata = dict(datasets[0].metadata)
    reports = {}
    for dataset in datasets:
        for report in dataset.metadata.get("replays", []):
            key = (report["replay_id"], report["selected_player"]["player_id"])
            reports[key] = report
    metadata["replays"] = list(reports.values())
    return _validate_dataset(ReplayDataset(**arrays, metadata=metadata))


def _imitation_objective(logits, labels, gameplay_lookup, gameplay_loss_weight: float, sample_weights=None):
    """Normalize per-example gameplay emphasis without changing labels/masks."""
    import torch
    from torch.nn import functional as F

    losses = F.cross_entropy(logits, labels, reduction="none")
    weights = torch.where(gameplay_lookup[labels], gameplay_loss_weight, 1.0)
    if sample_weights is not None:
        weights = weights * sample_weights
    return (losses * weights).sum() / weights.sum(), losses, weights


def _checkpoint_training_ancestry(metadata: dict) -> tuple[list[str], bool]:
    """Collect known training exposure without declaring legacy history complete."""
    known: set[str] = set()

    def add_ids(values: Any) -> None:
        if not isinstance(values, list) or any(not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value) for value in values):
            raise ReplayError("Checkpoint training ancestry must contain replay SHA256 identifiers.")
        known.update(values)

    if "train_replay_ids" in metadata:
        add_ids(metadata["train_replay_ids"])
    reference = metadata.get("reference_source")
    if isinstance(reference, dict) and "train_replay_ids" in reference:
        add_ids(reference["train_replay_ids"])
    ancestry = metadata.get("training_ancestry")
    if ancestry is None:
        return sorted(known), False
    if (not isinstance(ancestry, dict) or type(ancestry.get("version")) is not int
            or ancestry["version"] != 1 or not isinstance(ancestry.get("complete"), bool)):
        raise ReplayError("Checkpoint training ancestry is malformed or unsupported.")
    add_ids(ancestry.get("known_train_replay_ids"))
    return sorted(known), ancestry["complete"]


def pretrain(
    dataset_paths: Sequence[str | Path], checkpoint_path: str | Path,
    epochs: int = 20, batch_size: int = 128, learning_rate: float = 3e-4,
    validation_fraction: float = 0.2, seed: int = 1, hidden_dim: int = 256,
    resume: str | Path | None = None, device: str = "cpu", gameplay_loss_weight: float = 1.0,
    stratify_matchups: bool = False, balance_matchups: bool = False, stratify_outcomes: bool = False,
) -> dict[str, Any]:
    """Imitate projected actions using a whole-replay train/validation split."""
    import torch
    from .learning import Policy, load_checkpoint, save_checkpoint
    from .contract import model_metadata, validate_metadata

    if epochs < 1 or batch_size < 1 or hidden_dim < 1 or not math.isfinite(learning_rate) or learning_rate <= 0:
        raise ReplayError("Epochs, batch size, hidden dimension and learning rate must be positive.")
    if not math.isfinite(gameplay_loss_weight) or gameplay_loss_weight <= 0:
        raise ReplayError("Gameplay loss weight must be finite and positive.")
    if stratify_outcomes and not stratify_matchups:
        raise ReplayError('Outcome stratification requires matchup stratification as well.')
    dataset = _merge_datasets(dataset_paths)
    matchups = _replay_matchups(dataset, required=stratify_matchups or balance_matchups)
    outcomes = _replay_outcomes(dataset, required=stratify_outcomes)
    strata = ({replay: matchup + '|' + outcomes[replay] for replay, matchup in matchups.items()}
              if stratify_outcomes else matchups)
    sample_matchups = np.asarray([matchups.get(str(replay), "Unknown") for replay in dataset.replay_ids])
    train_indices, validation_indices = grouped_split(
        dataset.replay_ids, validation_fraction, seed, strata=strata if stratify_matchups else None)
    train_ids = sorted(np.unique(dataset.replay_ids[train_indices]).tolist())
    validation_ids = sorted(np.unique(dataset.replay_ids[validation_indices]).tolist())
    train_matchup_weights = _matchup_weights(sample_matchups, train_indices, balance_matchups)
    validation_matchup_weights = _matchup_weights(sample_matchups, validation_indices, balance_matchups)
    matchup_split = {}
    for matchup in sorted(set(sample_matchups.tolist())):
        matchup_split[matchup] = {
            "train_replay_ids": [replay for replay in train_ids if matchups.get(replay, "Unknown") == matchup],
            "validation_replay_ids": [replay for replay in validation_ids if matchups.get(replay, "Unknown") == matchup],
            "train_samples": int(np.count_nonzero(sample_matchups[train_indices] == matchup)),
            "validation_samples": int(np.count_nonzero(sample_matchups[validation_indices] == matchup)),
            "train_outcomes": dict(Counter(outcomes.get(replay, 'Unknown') for replay in train_ids if matchups.get(replay, 'Unknown') == matchup)),
            "validation_outcomes": dict(Counter(outcomes.get(replay, 'Unknown') for replay in validation_ids if matchups.get(replay, 'Unknown') == matchup)),
        }
    split_metadata = {"strategy": ("whole_replay_stratified_by_matchup_and_outcome" if stratify_outcomes else
                                   "whole_replay_stratified_by_matchup" if stratify_matchups else "whole_replay_random"),
                      "matchups": matchup_split, "balanced_matchup_loss": balance_matchups,
                      "train_matchup_weights": train_matchup_weights,
                      "validation_matchup_weights": validation_matchup_weights,
                      "weighting": "Inverse sample frequency within each split, multiplied by gameplay-command weight; normalized by sum of combined weights."}
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    initialization = None
    known_prior_ids: list[str] = []
    ancestry_complete = True
    if resume:
        resume_path = Path(resume).expanduser().resolve()
        resume_digest = _hash_file(resume_path)
        checkpoint = load_checkpoint(resume_path, expected_input_dim=OBSERVATION_SIZE, expected_action_dim=len(ACTION_NAMES))
        if _hash_file(resume_path) != resume_digest:
            raise ReplayError("Initialization checkpoint changed while loading; retry with a stable checkpoint.")
        validate_metadata(checkpoint["metadata"])
        known_prior_ids, ancestry_complete = _checkpoint_training_ancestry(checkpoint["metadata"])
        overlap = sorted(set(validation_ids) & set(known_prior_ids))
        if overlap:
            raise ReplayError(
                "Validation replays overlap the initialization checkpoint's known training ancestry: "
                + ", ".join(overlap)
                + ". Keep the earlier held-out split or use new validation replays."
            )
        initialization = {
            "path": str(resume_path), "sha256": resume_digest,
            "stage": checkpoint["metadata"].get("stage"),
            "known_prior_train_replay_ids": known_prior_ids,
            "training_history_complete": ancestry_complete,
        }
        policy = checkpoint["policy"]
    else:
        policy = Policy(OBSERVATION_SIZE, len(ACTION_NAMES), hidden_dim)
    ancestry = {"version": 1, "known_train_replay_ids": sorted(set(known_prior_ids) | set(train_ids)),
                "complete": ancestry_complete}
    validation_status = ("held_out_from_recorded_training" if ancestry_complete else "prior_training_unknown") if validation_ids else "not_available"
    validation_provenance = {"status": validation_status, "known_training_overlap": [],
                             "training_history_complete": ancestry_complete}
    policy.to(device)
    optimizer = torch.optim.Adam(policy.parameters(), lr=learning_rate)
    history: list[dict[str, Any]] = []
    best_loss = float("inf")
    best_epoch = 0

    def batches(indices: np.ndarray, matchup_weights: dict[str, float]) -> Iterable[tuple]:
        for offset in range(0, len(indices), batch_size):
            batch = indices[offset:offset + batch_size]
            yield (
                torch.as_tensor(dataset.observations[batch], dtype=torch.float32, device=device),
                torch.as_tensor(dataset.masks[batch], dtype=torch.bool, device=device),
                torch.as_tensor(dataset.actions[batch], dtype=torch.long, device=device),
                torch.as_tensor([matchup_weights[name] for name in sample_matchups[batch]], dtype=torch.float32, device=device),
                sample_matchups[batch],
            )

    train_histogram = dict(sorted(Counter(ACTION_NAMES[int(label)] for label in dataset.actions[train_indices]).items()))
    validation_histogram = dict(sorted(Counter(ACTION_NAMES[int(label)] for label in dataset.actions[validation_indices]).items()))
    gameplay_lookup = torch.as_tensor([name != "no_op" and not name.startswith("camera_") for name in ACTION_NAMES], dtype=torch.bool, device=device)
    for epoch in range(1, epochs + 1):
        policy.train()
        total_loss = 0.0
        total_weighted_loss = 0.0
        total_weight = 0.0
        total_correct = 0
        for obs, masks, labels, sample_weights, _ in batches(rng.permutation(train_indices), train_matchup_weights):
            logits, _ = policy(obs)
            logits = logits.masked_fill(~masks, torch.finfo(logits.dtype).min)
            loss, losses, weights = _imitation_objective(logits, labels, gameplay_lookup, gameplay_loss_weight, sample_weights)
            if not torch.isfinite(loss):
                raise ReplayError("Imitation loss became nonfinite; no invalid checkpoint was saved.")
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(policy.parameters(), 1.0)
            optimizer.step()
            total_loss += float(losses.detach().sum())
            total_weighted_loss += float((losses.detach() * weights).sum())
            total_weight += float(weights.sum())
            total_correct += int((logits.argmax(dim=1) == labels).sum())
        record = {"epoch": epoch, "train_loss": total_loss / len(train_indices),
                  "train_weighted_loss": total_weighted_loss / total_weight,
                  "train_accuracy": total_correct / len(train_indices), "validation_status": validation_status}
        policy.eval()
        matchup_metrics = {name: {"samples": 0, "loss_sum": 0.0, "correct": 0,
                                  "gameplay_samples": 0, "gameplay_correct": 0}
                           for name in validation_matchup_weights}
        if len(validation_indices):
            validation_loss = 0.0
            validation_weighted_loss = 0.0
            validation_weight = 0.0
            validation_correct = 0
            gameplay_correct = 0
            gameplay_count = 0
            with torch.no_grad():
                for obs, masks, labels, sample_weights, batch_matchups in batches(validation_indices, validation_matchup_weights):
                    logits, _ = policy(obs)
                    logits = logits.masked_fill(~masks, torch.finfo(logits.dtype).min)
                    _, losses, weights = _imitation_objective(logits, labels, gameplay_lookup, gameplay_loss_weight, sample_weights)
                    validation_loss += float(losses.sum())
                    validation_weighted_loss += float((losses * weights).sum())
                    validation_weight += float(weights.sum())
                    correct = logits.argmax(dim=1) == labels
                    validation_correct += int(correct.sum())
                    gameplay = gameplay_lookup[labels]
                    gameplay_correct += int(correct[gameplay].sum())
                    gameplay_count += int(gameplay.sum())
                    for name in set(batch_matchups.tolist()):
                        belonging = torch.as_tensor(batch_matchups == name, dtype=torch.bool, device=device)
                        metrics = matchup_metrics[name]
                        metrics["samples"] += int(belonging.sum())
                        metrics["loss_sum"] += float(losses[belonging].sum())
                        metrics["correct"] += int(correct[belonging].sum())
                        metrics["gameplay_samples"] += int((gameplay & belonging).sum())
                        metrics["gameplay_correct"] += int(correct[gameplay & belonging].sum())
            record.update(validation_loss=validation_loss / len(validation_indices), validation_accuracy=validation_correct / len(validation_indices),
                          validation_weighted_loss=validation_weighted_loss / validation_weight,
                          validation_gameplay_accuracy=gameplay_correct / gameplay_count if gameplay_count else None,
                          validation_gameplay_samples=gameplay_count)
        else:
            record.update(validation_loss=None, validation_weighted_loss=None, validation_accuracy=None,
                          validation_gameplay_accuracy=None, validation_gameplay_samples=0)
        record["validation_by_matchup"] = {
            name: {"samples": metrics["samples"], "loss": metrics["loss_sum"] / metrics["samples"],
                   "accuracy": metrics["correct"] / metrics["samples"],
                   "gameplay_samples": metrics["gameplay_samples"],
                   "gameplay_accuracy": metrics["gameplay_correct"] / metrics["gameplay_samples"]
                   if metrics["gameplay_samples"] else None}
            for name, metrics in matchup_metrics.items() if metrics["samples"]}
        history.append(record)
        selection_loss = record["validation_weighted_loss"] if record["validation_weighted_loss"] is not None else record["train_weighted_loss"]
        if selection_loss < best_loss:
            best_loss = selection_loss
            best_epoch = epoch
            save_checkpoint(
                checkpoint_path, policy, optimizer=optimizer,
                metadata=model_metadata(stage="imitation", **{"training": "replay_imitation", "schema_version": SCHEMA_VERSION, "action_names": list(ACTION_NAMES),
                          "train_replay_ids": train_ids, "validation_replay_ids": validation_ids, "dataset_paths": [str(Path(path).resolve()) for path in dataset_paths],
                          "initialization_checkpoint": initialization, "training_ancestry": ancestry,
                          "validation_provenance": validation_provenance,
                          "replay_split": split_metadata,
                          "metrics": record, "label_projection": dataset.metadata.get("limitations", "Strategic actions only"),
                          "replay_placement_masks": dataset.metadata.get("placement_masks"),
                          "extractor_version": dataset.metadata.get("extractor_version"),
                          "source_replays": [{**{key: report.get(key) for key in ("replay_id", "game_version", "base_build", "map_name", "selected_player")},
                                              "matchup": matchups.get(report.get("replay_id"), "Unknown")}
                                             for report in dataset.metadata.get("replays", [])],
                          "train_action_histogram": train_histogram, "validation_action_histogram": validation_histogram,
                          "imitation_config": {"seed": seed, "learning_rate": learning_rate, "batch_size": batch_size,
                                               "validation_fraction": validation_fraction, "gameplay_loss_weight": gameplay_loss_weight,
                                               "stratify_matchups": stratify_matchups, "balance_matchups": balance_matchups,
                                               "stratify_outcomes": stratify_outcomes},
                          "checkpoint_selection_metric": "validation_weighted_loss" if len(validation_indices) else "train_weighted_loss"}),
                counters={"imitation_epochs": epoch},
            )
    return {
        "checkpoint": str(Path(checkpoint_path).resolve()), "samples": len(dataset),
        "train_samples": len(train_indices), "validation_samples": len(validation_indices),
        "train_replay_ids": train_ids, "validation_replay_ids": validation_ids,
        "initialization_checkpoint": initialization, "training_ancestry": ancestry,
        "validation_provenance": validation_provenance,
        "replay_split": split_metadata,
        "train_action_histogram": train_histogram, "validation_action_histogram": validation_histogram,
        "train_gameplay_samples": sum(count for name, count in train_histogram.items() if name != "no_op" and not name.startswith("camera_")),
        "validation_gameplay_samples": sum(count for name, count in validation_histogram.items() if name != "no_op" and not name.startswith("camera_")),
        "source_parameters": {name: dataset.metadata.get(name) for name in ("extractor_version", "step_mul", "idle_fraction_max", "seed", "pacing", "placement_masks")},
        "gameplay_loss_weight": gameplay_loss_weight,
        "checkpoint_selection_metric": "validation_weighted_loss" if len(validation_indices) else "train_weighted_loss",
        "best_epoch": best_epoch, "history": history,
        "warning": ("One replay cannot support independent validation; add another replay."
                    if len(np.unique(dataset.replay_ids)) < 2 else
                    "The initialization checkpoint has incomplete training history; validation metrics may include previously trained games and do not establish held-out performance."
                    if validation_ids and not ancestry_complete else None),
    }
