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

    The replay parser identifies "us" by substring-matching the
    handle against the in-replay player name. SC2 writes only the
    display name into the replay (no ``#discriminator``), so the
    handle has to be the bare display-name portion or the match
    fails for everyone with a battleTag like ``Name#1234``.

    Resolution order:
      1. ``displayName`` — the cleanest source (what the web profile
         page now shows separately from the battleTag).
      2. ``battleTag`` — but **stripped of the discriminator**.
         "ReSpOnSe#1872" → "ReSpOnSe". Without this strip the
         substring match fails because the in-replay name doesn't
         carry the ``#1872`` suffix, every parse falls through to
         the toon-handle fallback, and every replay pays the cost
         of two ``parse_deep`` calls.
      3. ``pulseId`` — last resort when the user has only set their
         SC2Pulse character id and nothing else.
    """
    if not isinstance(profile, dict):
        return None
    name = profile.get("displayName")
    if isinstance(name, str) and name.strip():
        return name.strip()
    bt = profile.get("battleTag")
    if isinstance(bt, str) and bt.strip():
        # Strip everything from the first ``#`` onward. SC2 in-replay
        # names never contain it, so keeping it would break the
        # substring matcher.
        bare = bt.split("#", 1)[0].strip()
        if bare:
            return bare
        return bt.strip()
    pulse = profile.get("pulseId")
    if isinstance(pulse, str) and pulse.strip():
        return pulse.strip()
    return None


def resolve(state_dir: Optional[Path]) -> Optional[str]:
    """Resolve a handle WITHOUT touching the network. Used by the parse
    pipeline once per replay — the cloud refresh runs separately at
    start-up so we never block parsing on an HTTP call.

    Order: disk cache (last cloud value or auto-detected) >
    SC2TOOLS_PLAYER_CONFIG JSON > SC2TOOLS_PLAYER_HANDLE env var.
    """
    if state_dir is not None:
        cached = read_cache(state_dir)
        if cached:
            return cached
    return _read_env_fallback()


def auto_detect_from_replays(
    folders: list, max_scan: int = 30,
) -> Optional[str]:
    """Derive the player display name by scanning recent replays.

    SC2 organises replays under
    ``Accounts/<account>/<toonHandle>/Replays/Multiplayer/`` — the
    folder path itself tells us which toon owns the directory, so the
    player whose ``toon_handle`` matches that path is unambiguously
    the user. We pick the most recently modified replay across the
    supplied folders, parse it at ``live`` depth (load_level=2, fast),
    and return the matching player's display name.

    The result is intended to be written to the cache via
    ``write_cache`` so subsequent parses use the standard
    name-substring matcher in the analyzer without further work.

    Returns ``None`` when no replays exist, no toon-shaped folder is
    in the path, the analyzer can't be loaded, or the parsed replay
    contains no human player matching the path's toon (a corrupt or
    cooperative-mode file). All failures are silent — the caller
    decides whether to log.
    """
    candidates = _gather_recent_replays(folders, max_scan=max_scan)
    if not candidates:
        return None
    # Importing replay_pipeline runs ``_ensure_analyzer_on_path`` as a
    # side-effect, which is what makes ``core.sc2_replay_parser``
    # resolvable below. Order matters: this must happen BEFORE the
    # parser import, otherwise a caller that pulled
    # ``auto_detect_from_replays`` directly (without first touching
    # replay_pipeline) would silently fall through to the bail-out
    # branch and the agent would believe the analyzer is broken.
    from .replay_pipeline import _toon_handle_from_path  # local to avoid cycle

    try:
        from core.sc2_replay_parser import parse_live  # type: ignore
    except ImportError:
        # The replay_pipeline import probe will surface this same
        # condition with full diagnostics; here we just bail.
        return None

    for path in candidates:
        toon = _toon_handle_from_path(path)
        if not toon:
            continue
        try:
            ctx = parse_live(str(path), "")
        except Exception:  # noqa: BLE001
            continue
        for p in getattr(ctx, "all_players", None) or []:
            if getattr(p, "is_observer", False) or getattr(p, "is_referee", False):
                continue
            if str(getattr(p, "handle", "") or "") == toon:
                name = getattr(p, "name", "") or ""
                # Strip any clan tag — the analyzer's ``is_me``
                # substring match works regardless of the prefix, but
                # storing the bare display name keeps the cache file
                # human-readable and survives a clan switch.
                if "]" in name:
                    name = name.split("]", 1)[1].strip()
                if name:
                    return name
    return None


def _gather_recent_replays(folders: list, *, max_scan: int) -> list:
    """Walk ``folders`` and return up to ``max_scan`` most-recent replays.

    Used by ``auto_detect_from_replays``. We keep the scan tight so the
    one-shot startup detection doesn't stall the agent on an account
    with thousands of replays — the user only needs ONE matching file.
    """
    out: list = []
    for folder in folders or []:
        try:
            base = Path(folder)
        except TypeError:
            continue
        if not base.exists():
            continue
        try:
            for p in base.rglob("*.SC2Replay"):
                if p.is_file():
                    out.append(p)
        except OSError:
            continue
    out.sort(key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True)
    return out[:max_scan]


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
