"""Persistent agent state (pairing token, last-uploaded cursor).

State lives in a single JSON file inside the per-user state dir. We
write atomically (write→fsync→rename) to match the project's wider
data-write protocol.
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
    """Map of replay file path → ISO timestamp it was uploaded."""

    @property
    def is_paired(self) -> bool:
        return bool(self.device_token)


def load_state(state_dir: Path) -> AgentState:
    """Read state from disk; return defaults on first run."""
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
    )


def save_state(state_dir: Path, state: AgentState) -> None:
    """Atomic write: tmp → fsync → rename."""
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
