"""Launcher config reader for SC2 Tools.

Pure-function helpers that read ``data/config.json`` produced by the
first-run wizard and shape the fields the launcher needs to spawn the
replay watcher and the API poller (PowerShell ``Reveal-Sc2Opponent.ps1``).

Why a separate module
---------------------
``SC2ReplayAnalyzer.py`` is a process-orchestration shim: it spawns
children, polls health, opens the browser, and handles shutdown. The
config-shaping logic is *pure* (input dict -> output dict, no IO once
you have the file contents) so it lives here where it can be unit-tested
without standing up real subprocesses.

Output contract
---------------
``read_pulse_args(config)`` returns::

    {
        "character_ids": ["994428", "8970877"],   # SC2Pulse IDs (str)
        "player_name":   "ReSpOnSe",               # primary identity name
        "regions":       ["us", "eu"],             # lowercase, deduped
    }

``read_runtime_flags(config)`` returns::

    {
        "spawn_watcher": True,     # default True for back-compat
        "spawn_poller":  True,     # default True; auto-False if no IDs/name
    }

Both are tolerant of missing/malformed sections — they fall back to
safe defaults rather than raising, because the launcher should still
boot the backend even if the wizard hasn''t run yet.

Example:
    >>> cfg = json.loads(Path("data/config.json").read_text())
    >>> args = read_pulse_args(cfg)
    >>> args["character_ids"]
    ['994428', '8970877']
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

# --- Constants ------------------------------------------------------------

# Default region order baked into Reveal-Sc2Opponent.ps1; we mirror it
# here so that an empty/missing identities list still produces a usable
# poller invocation rather than a no-op.
DEFAULT_REGIONS: List[str] = ["us", "eu", "kr"]

# Valid SC2Pulse region codes (matches the PS1 ValidateSet).
VALID_REGIONS: frozenset[str] = frozenset(("us", "eu", "kr", "cn"))

CONFIG_FILENAME: str = "config.json"


def load_config(config_path: Path) -> Dict[str, Any]:
    """Read and parse ``config_path``; return ``{}`` on any failure.

    The launcher must boot even when ``data/config.json`` is missing
    (fresh install, wizard not yet run) or unparseable, so this swallows
    IO and JSON errors and returns an empty dict. Callers downstream
    handle the empty case via ``read_runtime_flags`` which auto-disables
    the poller when there are no identities.

    Example:
        >>> load_config(Path("/nonexistent/config.json"))
        {}
    """
    try:
        text = config_path.read_text(encoding="utf-8")
    except (OSError, FileNotFoundError):
        return {}
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _identities(config: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Return ``config["identities"]`` as a list of dicts; ``[]`` otherwise.

    Defensive: tolerates missing key, non-list value, and non-dict
    entries, because a stale or hand-edited config shouldn''t crash
    the launcher.
    """
    raw = config.get("identities")
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, dict)]


def _stream_pulse_ids(config: Dict[str, Any]) -> List[str]:
    """Return Pulse IDs from ``stream_overlay.pulse_character_ids``.

    Some users only fill out the stream-overlay section (legacy install
    path). We union those IDs with the identities-derived ones so the
    poller still works.
    """
    so = config.get("stream_overlay")
    if not isinstance(so, dict):
        return []
    arr = so.get("pulse_character_ids")
    if not isinstance(arr, list):
        return []
    return [str(v).strip() for v in arr if str(v).strip()]


def _ordered_unique(items: List[str]) -> List[str]:
    """Deduplicate ``items`` while preserving first-seen order.

    Example:
        >>> _ordered_unique(["us", "eu", "us", "kr"])
        ['us', 'eu', 'kr']
    """
    seen: set[str] = set()
    out: List[str] = []
    for item in items:
        if item and item not in seen:
            seen.add(item)
            out.append(item)
    return out


def _collect_pulse_ids(identities: List[Dict[str, Any]],
                       extra: List[str]) -> List[str]:
    """Union of ``pulse_id`` across identities + ``extra``, ordered."""
    ids: List[str] = []
    for ident in identities:
        pid = str(ident.get("pulse_id") or "").strip()
        if pid:
            ids.append(pid)
    ids.extend(s for s in extra if s)
    return _ordered_unique(ids)


def _collect_regions(identities: List[Dict[str, Any]]) -> List[str]:
    """Lowercase, deduped, validated regions from identities; default if empty."""
    regs: List[str] = []
    for ident in identities:
        reg = str(ident.get("region") or "").strip().lower()
        if reg in VALID_REGIONS:
            regs.append(reg)
    deduped = _ordered_unique(regs)
    return deduped or list(DEFAULT_REGIONS)


def _pick_player_name(identities: List[Dict[str, Any]]) -> Optional[str]:
    """First non-empty ``name`` across identities, or ``None``."""
    for ident in identities:
        name = str(ident.get("name") or "").strip()
        if name:
            return name
    return None


def read_pulse_args(config: Dict[str, Any]) -> Dict[str, Any]:
    """Shape the fields needed to invoke ``Reveal-Sc2Opponent.ps1``.

    Returns a dict with ``character_ids`` (list[str]), ``player_name``
    (str | None), and ``regions`` (list[str]).

    Example:
        >>> read_pulse_args({
        ...   "identities": [
        ...     {"name": "Foo", "pulse_id": "1", "region": "us"},
        ...     {"name": "Foo", "pulse_id": "2", "region": "eu"},
        ...   ]
        ... })["character_ids"]
        ['1', '2']
    """
    identities = _identities(config)
    return {
        "character_ids": _collect_pulse_ids(
            identities, _stream_pulse_ids(config)),
        "player_name": _pick_player_name(identities),
        "regions": _collect_regions(identities),
    }


def read_runtime_flags(config: Dict[str, Any]) -> Dict[str, bool]:
    """Return ``{spawn_watcher, spawn_poller}`` with safe defaults.

    Defaults to ``True`` for both so an existing install picks up the
    new launcher behaviour without a config migration. The poller
    auto-disables when there is no way to identify the user (no Pulse
    IDs and no player name), because the PS1 script would just print
    an error and idle.

    Example:
        >>> read_runtime_flags({})
        {'spawn_watcher': True, 'spawn_poller': False}
    """
    rt = config.get("runtime")
    rt = rt if isinstance(rt, dict) else {}
    pulse = read_pulse_args(config)
    has_identity = bool(pulse["character_ids"]) or bool(pulse["player_name"])
    return {
        "spawn_watcher": bool(rt.get("spawn_watcher", True)),
        "spawn_poller": bool(rt.get("spawn_poller", True)) and has_identity,
    }


# --- PowerShell argv builder ---------------------------------------------
#
# Shared by SC2ReplayAnalyzer.py (auto-launch) and
# scripts/poller_launch.py (manual invocation). Returns ``None`` when
# config has no identity at all -- both callers treat that as "skip
# poller, log why" rather than spawning a no-op PS process.

# Static PS1 flags. These never change between callers so they live as
# a constant rather than threaded through arguments.
_POLLER_STATIC_FLAGS: tuple[str, ...] = (
    "-DisableQuickEdit",
    "-RatingFormat", "long",
    "-RaceFormat", "short",
    "-Separator", "`r`n",
    "-Limit", "1",
)


def build_poller_argv(ps_exe: str, pulse: Dict[str, Any],
                      poller_script: Path,
                      opponent_file: str = "opponent.txt"
                      ) -> Optional[List[str]]:
    """Build the argv list for ``Reveal-Sc2Opponent.ps1``.

    Args:
        ps_exe: Resolved path to ``powershell.exe``.
        pulse: Output of :func:`read_pulse_args`.
        poller_script: Absolute path to ``Reveal-Sc2Opponent.ps1``.
        opponent_file: Output filename the PS1 writes opponent data to.

    Returns:
        argv list ready for :func:`subprocess.Popen`, or ``None`` when
        ``pulse`` has neither character_ids nor a player_name (the PS1
        would just emit an error and idle, so we skip the spawn).

    Example:
        >>> build_poller_argv("powershell.exe",
        ...     {"character_ids": ["994428"], "player_name": "Foo",
        ...      "regions": ["us"]},
        ...     Path("/tmp/Reveal-Sc2Opponent.ps1"))[:6]
        ['powershell.exe', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', '/tmp/Reveal-Sc2Opponent.ps1']
    """
    ids: List[str] = list(pulse.get("character_ids") or [])
    name: Optional[str] = pulse.get("player_name")
    regions: List[str] = list(pulse.get("regions") or [])
    if not ids and not name:
        return None
    argv: List[str] = [
        ps_exe,
        "-NoExit",
        "-ExecutionPolicy", "Bypass",
        "-File", str(poller_script),
    ]
    if ids:
        argv.extend(["-CharacterId", ",".join(ids)])
    elif name:
        argv.extend(["-PlayerName", name])
    if regions:
        argv.extend(["-ActiveRegion", ",".join(regions)])
    argv.extend(["-FilePath", opponent_file])
    argv.extend(_POLLER_STATIC_FLAGS)
    return argv
