"""Resolve and cache the player handle (BattleTag, etc.) used by the
replay parser to identify "us" in a multiplayer game.

Resolution order (highest priority first):

  1. **Cloud profile** — what the user typed into Settings → Profile
     in the web app. The agent fetches this once at start-up via
     ``GET /v1/me/profile`` and writes it to ``state_dir/player_handle.json``
     so subsequent offline starts still have a value.
  2. **Disk cache** — the most recent successful cloud fetch. Survives
     restarts, network outages, and the cloud-API being down.
  3. **Legacy env-var fallback** — ``SC2TOOLS_PLAYER_HANDLE`` (or a
     ``SC2TOOLS_PLAYER_CONFIG`` JSON file). Lets a power user override
     without touching the web UI; preserved for backwards compatibility
     with the standalone overlay watcher.

The cache file is intentionally tiny (one short string in JSON) and is
written atomically (write→fsync→rename) to match the broader agent
data-write protocol — see ``state.save_state``.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover — type-only import
    from .api_client import ApiClient

log = logging.getLogger(__name__)

CACHE_FILENAME = "player_handle.json"


def cache_path(state_dir: Path) -> Path:
    return Path(state_dir) / CACHE_FILENAME


def read_cache(state_dir: Path) -> Optional[str]:
    """Return the cached handle, or None if missing/unreadable."""
    path = cache_path(state_dir)
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(raw, dict):
        return None
    handle = raw.get("handle")
    if isinstance(handle, str) and handle.strip():
        return handle.strip()
    return None


def write_cache(state_dir: Path, handle: Optional[str]) -> None:
    """Atomic write of the resolved handle. ``None`` clears the cache."""
    state_dir = Path(state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    target = cache_path(state_dir)
    if not handle:
        try:
            target.unlink()
        except FileNotFoundError:
            pass
        return
    fd, tmp_path = tempfile.mkstemp(
        prefix="player_handle.", suffix=".tmp", dir=str(state_dir),
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump({"handle": handle}, fh, indent=2, sort_keys=True)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_path, target)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def refresh_from_cloud(
    api: "ApiClient", state_dir: Path,
) -> Optional[str]:
    """Pull the latest profile and write the cache. Returns the handle
    that was cached (or None if the cloud has nothing for this user).

    Network/auth failures are swallowed and logged — the agent keeps
    whatever's already on disk so a transient API outage doesn't blank
    the cache.
    """
    try:
        profile = api.get_profile()
    except Exception as exc:  # noqa: BLE001
        log.info("player_handle_refresh_failed: %s", exc)
        return None
    handle = _pick_handle_from_profile(profile)
    if handle:
        try:
            write_cache(state_dir, handle)
        except OSError as exc:
            log.warning("player_handle_cache_write_failed: %s", exc)
    return handle


def _pick_handle_from_profile(profile: object) -> Optional[str]:
    """Pull the best identifier out of a ``GET /v1/me/profile`` response.

    The web UI lets users fill battleTag (e.g. "Name#1234") or pulseId.
    The replay parser matches against the in-replay name, so battleTag
    is the right choice when present; pulseId is a fallback when only
    the SC2Pulse character id has been set.
    """
    if not isinstance(profile, dict):
        return None
    for key in ("battleTag", "pulseId"):
        v = profile.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


def resolve(state_dir: Optional[Path]) -> Optional[str]:
    """Resolve a handle WITHOUT touching the network. Used by the parse
    pipeline once per replay — the cloud refresh runs separately at
    start-up so we never block parsing on an HTTP call.

    Order: disk cache (last cloud value) > SC2TOOLS_PLAYER_CONFIG JSON
    > SC2TOOLS_PLAYER_HANDLE env var.
    """
    if state_dir is not None:
        cached = read_cache(state_dir)
        if cached:
            return cached
    return _read_env_fallback()


def _read_env_fallback() -> Optional[str]:
    """The original (pre-cloud) env-var resolution path. Preserved so
    that an explicit env override still works when the cloud cache is
    empty (e.g. a brand-new install before the first refresh)."""
    cfg_path_str = os.environ.get("SC2TOOLS_PLAYER_CONFIG", "").strip()
    if cfg_path_str:
        cfg_path = Path(cfg_path_str)
        if cfg_path.is_file():
            try:
                cfg = json.loads(cfg_path.read_text(encoding="utf-8-sig"))
                handle = cfg.get("last_player") or cfg.get("player_name")
                if handle:
                    return str(handle)
            except (OSError, json.JSONDecodeError):
                pass
    env = os.environ.get("SC2TOOLS_PLAYER_HANDLE")
    return env or None
