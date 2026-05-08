"""Persistent agent state (pairing token, last-uploaded cursor, GUI prefs).

State lives in a single JSON file inside the per-user state dir. We
write atomically (write->fsync->rename) to match the project's wider
data-write protocol.

Forward-compatibility note: ``load_state`` ignores unknown JSON keys,
so a user who downgrades the agent after a state file is written by a
newer version doesn't lose their pairing - they just lose the new
preferences until they re-upgrade.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Dict, List, Optional

STATE_FILENAME = "agent.json"


@dataclass
class AgentState:
    """Mutable per-installation state."""

    device_token: Optional[str] = None
    user_id: Optional[str] = None
    paired_at: Optional[str] = None
    uploaded: Dict[str, str] = field(default_factory=dict)
    """Map of replay file path -> ISO timestamp it was uploaded."""

    path_by_game_id: Dict[str, str] = field(default_factory=dict)
    """Reverse lookup: cloud gameId -> local replay file path. Lets the
    Socket.io recompute handlers translate a gameId-keyed request from
    the cloud back into a file the watcher can re-parse without us
    having to walk every replay on disk. Populated incrementally on
    every successful upload; survives restarts (it's persisted to the
    same agent.json the rest of the state lives in)."""

    paused: bool = False
    """When True the watcher keeps observing but the upload queue is
    drained without sending - flipped by the tray/GUI "Pause syncing"
    action and persisted across restarts."""

    replay_folder_override: Optional[str] = None
    """Legacy single-folder override. Kept for back-compat with state
    files written by 0.3.x. New code reads/writes ``replay_folders_override``
    instead and migrates this field forward at load time."""

    replay_folders_override: List[str] = field(default_factory=list)
    """User-chosen replay folders. Each entry is watched recursively, so
    a region/account-level path catches every Multiplayer subfolder
    underneath it. When non-empty, takes precedence over auto-discovery
    — but auto-discovery is still merged in if the user wants the
    default + extras (handled in the runner's discovery helper).

    StarCraft II creates a separate Replays folder per region+toon, so
    a player who plays on multiple regions or with multiple BattleTags
    needs more than one entry here. The Settings tab exposes Add/Remove
    buttons over this list."""

    # ---- GUI preferences (introduced with the PySide6 main window) ----

    api_base_override: Optional[str] = None
    """If set, takes precedence over the ``SC2TOOLS_API_BASE`` env var
    on next start. Editable from the GUI Settings tab so non-technical
    users never have to touch a .env file. Cleared by saving an empty
    string in the GUI."""

    log_level_override: Optional[str] = None
    """If set, used as the root log level on next start. Editable from
    the GUI Settings tab. Recognised values: DEBUG, INFO, WARNING,
    ERROR. Anything else is ignored at load time."""

    autostart_enabled: bool = False
    """Mirrors the Windows HKCU\\...\\Run registry entry. Stored in
    state so the GUI can show the current value without doing a
    registry probe on every render."""

    start_minimized: bool = False
    """When True, the GUI starts hidden - only the tray icon shows.
    Useful when the agent is set to launch on login."""

    parse_concurrency_override: Optional[int] = None
    """How many parse threads the watcher's ThreadPoolExecutor runs.
    None = use the config default (4). The Settings tab exposes this
    so users on weaker hardware can drop it to 1, and users with a
    big backfill on a strong CPU can raise it to 8 or 16. Persisted
    here (rather than only as an env var) so a GUI change survives
    restarts without the user re-typing it."""

    last_known_mmr: Optional[int] = None
    """Sticky cache of the most recently extracted streamer MMR.
    Pinged to the cloud profile via ``POST /v1/me/last-mmr`` after
    every successful replay parse, so the session widget can fall
    back to a real number even when no game in the user's cloud
    history carries ``myMmr``. Survives restarts so a brief offline
    period (or a re-sync of older replays) doesn't blank the value
    we already paid an HTTP round-trip to set."""

    last_known_mmr_date_iso: Optional[str] = None
    """Game-date of the replay that produced ``last_known_mmr`` (ISO
    string). Used to gate-keep the cloud ping during a backfill: we
    only push when a newly-parsed replay is more recent than what
    we already pushed, otherwise re-syncing 12k old replays would
    reset the sticky MMR to whatever the streamer's rating was three
    seasons ago."""

    last_known_mmr_region: Optional[str] = None
    """Short region label (NA/EU/KR/CN/SEA) inferred from the
    streamer's toon-handle byte at extraction time. Pushed to the
    cloud alongside ``last_known_mmr`` so the overlay's region label
    stays accurate even when SC2Pulse is unreachable."""

    @property
    def is_paired(self) -> bool:
        return bool(self.device_token)


def load_state(state_dir: Path) -> AgentState:
    """Read state from disk; return defaults on first run.

    Robust to:
      * a missing file (first run),
      * a corrupted JSON blob (returns defaults rather than crashing),
      * unknown keys (forward compatibility - silently dropped).
    """
    path = state_dir / STATE_FILENAME
    if not path.exists():
        return AgentState()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return AgentState()
    if not isinstance(raw, dict):
        return AgentState()
    legacy_single = _coerce_str(raw.get("replay_folder_override"))
    folders_raw = raw.get("replay_folders_override")
    folders = _coerce_str_list(folders_raw)
    # Forward-migrate the legacy single-string field into the list so
    # older state files don't lose their override after upgrade.
    if legacy_single and legacy_single not in folders:
        folders.insert(0, legacy_single)

    raw_path_by_game = raw.get("path_by_game_id") or {}
    if not isinstance(raw_path_by_game, dict):
        raw_path_by_game = {}
    path_by_game_id: Dict[str, str] = {}
    for gid, pth in raw_path_by_game.items():
        if isinstance(gid, str) and isinstance(pth, str) and gid and pth:
            path_by_game_id[gid] = pth

    return AgentState(
        device_token=raw.get("device_token"),
        user_id=raw.get("user_id"),
        paired_at=raw.get("paired_at"),
        uploaded=dict(raw.get("uploaded") or {}),
        path_by_game_id=path_by_game_id,
        paused=bool(raw.get("paused") or False),
        replay_folder_override=legacy_single,
        replay_folders_override=folders,
        api_base_override=_coerce_str(raw.get("api_base_override")),
        log_level_override=_coerce_str(raw.get("log_level_override")),
        autostart_enabled=bool(raw.get("autostart_enabled") or False),
        start_minimized=bool(raw.get("start_minimized") or False),
        parse_concurrency_override=_coerce_int(
            raw.get("parse_concurrency_override"),
        ),
        last_known_mmr=_coerce_mmr(raw.get("last_known_mmr")),
        last_known_mmr_date_iso=_coerce_str(raw.get("last_known_mmr_date_iso")),
        last_known_mmr_region=_coerce_str(raw.get("last_known_mmr_region")),
    )


def save_state(state_dir: Path, state: AgentState) -> None:
    """Atomic write: tmp -> fsync -> rename."""
    state_dir.mkdir(parents=True, exist_ok=True)
    target = state_dir / STATE_FILENAME
    fd, tmp_path = tempfile.mkstemp(prefix="agent.", suffix=".tmp", dir=str(state_dir))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(asdict(state), fh, indent=2, sort_keys=True)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_path, target)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _coerce_mmr(value: object) -> Optional[int]:
    """Return ``value`` as a plausible MMR (500–9999) or None.

    Defends against legacy/garbage entries written by older agent
    versions or hand-edited state files. Mirrors the cloud profile's
    [500, 9999] band so a state-loaded value the cloud would reject
    is dropped here instead of repeatedly bouncing off the API.
    """
    if isinstance(value, bool):
        return None
    try:
        n = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if 500 <= n <= 9999:
        return n
    return None


def _coerce_int(value: object) -> Optional[int]:
    """Return ``value`` as a positive int if possible; ``None`` otherwise.

    Used for state-stored override fields that the GUI may write as
    a JSON number or string. We clamp to ``>= 1`` because the Settings
    tab's spinbox already gates the range, but a hand-edited state
    file could put a zero or negative there and silently break the
    watcher's ThreadPoolExecutor (which requires max_workers >= 1).
    """
    if isinstance(value, bool):
        # ``True`` would otherwise coerce to ``1`` — guard against the
        # case where someone hand-edits the state file.
        return None
    try:
        n = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return n if n >= 1 else None


def _coerce_str(value: object) -> Optional[str]:
    """Return ``value`` if it's a non-empty string; ``None`` otherwise.

    Clears legacy/empty entries written by older agent versions so the
    GUI's "blank means default" semantics work without a migration.
    """
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _coerce_str_list(value: object) -> List[str]:
    """Return ``value`` as a deduplicated list of non-empty strings.

    Tolerates a JSON list, a single string, or a missing/None field —
    in every case the result is a fresh ``list[str]`` the caller can
    mutate without touching the source state.
    """
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    seen: set[str] = set()
    out: List[str] = []
    for item in value:
        if not isinstance(item, str):
            continue
        s = item.strip()
        if not s or s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out
