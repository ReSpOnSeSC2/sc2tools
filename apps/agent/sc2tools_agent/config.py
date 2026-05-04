"""Runtime configuration for the agent.

Resolution order, highest priority first:
  1. CLI args (handled in runner.py)
  2. Environment variables (loaded from .env if present)
  3. Sensible defaults
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # python-dotenv missing in dev install — silent.
    pass


_DEFAULT_API_BASE = "https://sc2tools-api.onrender.com"
_DEFAULT_POLL_INTERVAL_SEC = 10
_DEFAULT_PARSE_CONCURRENCY = 1


@dataclass(frozen=True)
class AgentConfig:
    """Immutable agent config snapshot."""

    api_base: str
    state_dir: Path
    replay_folder: Optional[Path]
    poll_interval_sec: int
    parse_concurrency: int


def load_config() -> AgentConfig:
    """Read env, validate, fill defaults."""
    api_base = os.environ.get("SC2TOOLS_API_BASE", _DEFAULT_API_BASE).rstrip("/")
    state_dir = Path(os.environ.get("SC2TOOLS_STATE_DIR") or _default_state_dir())
    state_dir.mkdir(parents=True, exist_ok=True)
    replay_folder = _coerce_path(os.environ.get("SC2TOOLS_REPLAY_FOLDER"))
    poll = _coerce_int("SC2TOOLS_POLL_INTERVAL", _DEFAULT_POLL_INTERVAL_SEC)
    concurrency = _coerce_int(
        "SC2TOOLS_PARSE_CONCURRENCY", _DEFAULT_PARSE_CONCURRENCY,
    )
    return AgentConfig(
        api_base=api_base,
        state_dir=state_dir,
        replay_folder=replay_folder,
        poll_interval_sec=max(2, poll),
        parse_concurrency=max(1, concurrency),
    )


def _coerce_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _coerce_path(raw: Optional[str]) -> Optional[Path]:
    if not raw:
        return None
    p = Path(raw).expanduser()
    return p if p.exists() else None


def _default_state_dir() -> Path:
    """Pick the right per-user state dir for the OS."""
    if os.name == "nt":
        local_app = os.environ.get("LOCALAPPDATA")
        if local_app:
            return Path(local_app) / "sc2tools"
    xdg = os.environ.get("XDG_DATA_HOME")
    if xdg:
        return Path(xdg) / "sc2tools"
    return Path.home() / ".local" / "share" / "sc2tools"
