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
from typing import Dict, Optional

STATE_FILENAME = "agent.json"


@dataclass
class AgentState:
    """Mutable per-installation state."""

    device_token: Optional[str] = None
    user_id: Optional[str] = None
    paired_at: Optional[str] = None
    uploaded: Dict[str, str] = field(default_factory=dict)
    """Map of replay file path -> ISO timestamp it was uploaded."""

    paused: bool = False
    """When True the watcher keeps observing but the upload queue is
    drained without sending - flipped by the tray/GUI "Pause syncing"
    action and persisted across restarts."""

    replay_folder_override: Optional[str] = None
    """User-chosen replay folder from the "Choose replay folder..."
    picker. Takes precedence over the default discovery."""

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
    return AgentState(
        device_token=raw.get("device_token"),
        user_id=raw.get("user_id"),
        paired_at=raw.get("paired_at"),
        uploaded=dict(raw.get("uploaded") or {}),
        paused=bool(raw.get("paused") or False),
        replay_folder_override=raw.get("replay_folder_override"),
        api_base_override=_coerce_str(raw.get("api_base_override")),
        log_level_override=_coerce_str(raw.get("log_level_override")),
        autostart_enabled=bool(raw.get("autostart_enabled") or False),
        start_minimized=bool(raw.get("start_minimized") or False),
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


def _coerce_str(value: object) -> Optional[str]:
    """Return ``value`` if it's a non-empty string; ``None`` otherwise.

    Clears legacy/empty entries written by older agent versions so the
    GUI's "blank means default" semantics work without a migration.
    """
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None
