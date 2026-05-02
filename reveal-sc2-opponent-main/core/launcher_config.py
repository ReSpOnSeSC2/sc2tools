"""Launcher config reader for SC2 Tools (merged-repo copy).

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

History
-------
Originally lived next to the desktop launcher under
``SC2Replay-Analyzer/launcher_config.py`` (a sibling project). After the
merge into ``reveal-sc2-opponent-main`` the merged repo can no longer
assume the sibling exists, so we keep an identical copy here. The
sibling file is preserved for the desktop launcher; this copy is the
one the merged-repo callers (``scripts/poller_launch.py``) import via
``core.launcher_config``.

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

Both are tolerant of missing/malformed sections -- they fall back to
safe defaults rather than raising, because the launcher should still
boot the backend even if the wizard hasn't run yet.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional


# Default region order baked into Reveal-Sc2Opponent.ps1; we mirror it
# here so that an empty/missing identities list still produces a usable
# poller invocation rather than a no-op.
DEFAULT_REGIONS: List[str] = ["us", "eu", "kr"]

# Valid SC2Pulse region codes (matches the PS1 ValidateSet).
VALID_REGIONS: frozenset = frozenset(("us", "eu", "kr", "cn"))

CONFIG_FILENAME: str = "config.json"


def load_config(config_path: Path) -> Dict[str, Any]:
    """Read and parse ``config_path``; return ``{}`` on any failure."""
    try:
        text = Path(config_path).read_text(encoding="utf-8")
    except (OSError, FileNotFoundError):
        return {}
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _identities(config: Dict[str, Any]) -> List[Dict[str, Any]]:
    raw = config.get("identities")
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, dict)]


def _stream_pulse_ids(config: Dict[str, Any]) -> List[str]:
    so = config.get("stream_overlay")
    if not isinstance(so, dict):
        return []
    arr = so.get("pulse_character_ids")
    if not isinstance(arr, list):
        return []
    return [str(v).strip() for v in arr if str(v).strip()]


def _ordered_unique(items: List[str]) -> List[str]:
    seen: set = set()
    out: List[str] = []
    for item in items:
        if item and item not in seen:
            seen.add(item)
            out.append(item)
    return out


def _collect_pulse_ids(identities: List[Dict[str, Any]],
                       extra: List[str]) -> List[str]:
    ids: List[str] = []
    for ident in identities:
        pid = str(ident.get("pulse_id") or "").strip()
        if pid:
            ids.append(pid)
    ids.extend(s for s in extra if s)
    return _ordered_unique(ids)


def _collect_regions(identities: List[Dict[str, Any]]) -> List[str]:
    regs: List[str] = []
    for ident in identities:
        reg = str(ident.get("region") or "").strip().lower()
        if reg in VALID_REGIONS:
            regs.append(reg)
    deduped = _ordered_unique(regs)
    return deduped or list(DEFAULT_REGIONS)


def _pick_player_name(identities: List[Dict[str, Any]]) -> Optional[str]:
    for ident in identities:
        name = str(ident.get("name") or "").strip()
        if name:
            return name
    return None


def read_pulse_args(config: Dict[str, Any]) -> Dict[str, Any]:
    """Shape the fields needed to invoke ``Reveal-Sc2Opponent.ps1``."""
    identities = _identities(config)
    return {
        "character_ids": _collect_pulse_ids(
            identities, _stream_pulse_ids(config)),
        "player_name": _pick_player_name(identities),
        "regions": _collect_regions(identities),
    }


def read_runtime_flags(config: Dict[str, Any]) -> Dict[str, bool]:
    rt = config.get("runtime")
    rt = rt if isinstance(rt, dict) else {}
    pulse = read_pulse_args(config)
    has_identity = bool(pulse["character_ids"]) or bool(pulse["player_name"])
    return {
        "spawn_watcher": bool(rt.get("spawn_watcher", True)),
        "spawn_poller": bool(rt.get("spawn_poller", True)) and has_identity,
    }


_POLLER_STATIC_FLAGS = (
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
    """Build the argv list for ``Reveal-Sc2Opponent.ps1``."""
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
    # Pass -PlayerName alongside -CharacterId when both are available
    # so the PS1 can build its "who's me?" identity regex from the
    # configured handle instead of falling back to a Pulse name lookup.
    if name:
        argv.extend(["-PlayerName", name])
    if regions:
        argv.extend(["-ActiveRegion", ",".join(regions)])
    argv.extend(["-FilePath", opponent_file])
    argv.extend(_POLLER_STATIC_FLAGS)
    return argv
