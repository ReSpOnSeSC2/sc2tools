"""
Loader for user-authored Spawning Tool build orders (Stage 7.4 v2).

This module owns three concerns:

1. **Backwards compat.** The existing parser at
   ``core.sc2_replay_parser.parse_replay`` still calls
   :func:`load_custom_builds` and expects the v1 shape
   ``{"Opponent": [...], "Self": [...]}`` so the rules-engine
   detectors keep working. We preserve that signature -- after a
   v1->v2 migration the buckets simply come back empty (no
   v1-style rules left on disk), and the existing race-tree
   classifier handles every game. The new v2 classifier kicks in
   via the ``/api/custom-builds/reclassify`` endpoint and the
   :mod:`scripts.build_classify_cli` CLI.

2. **v2 access.** :func:`load_custom_builds_v2` returns the new
   shape on disk, and :func:`load_community_cache` returns the
   local mirror of the community service. Both are merged into
   :data:`core.build_definitions.BUILD_DEFINITIONS` at import
   time (see ``build_definitions.py``).

3. **One-shot v1->v2 migration.** On first run after the Stage 7.4
   release the loader detects a v1 file (missing ``version: 2``,
   has ``target``/``rules``) and migrates in place, writing a
   ``custom_builds.json.pre-v2-bak.<ts>`` backup and a sibling
   ``custom_builds.json.migration-report.json`` listing builds
   that were converted, partially converted, or skipped. The
   migration is idempotent: running it twice is a no-op.

Engineering compliance (per master preamble):

* Atomic writes via :func:`core.atomic_io.atomic_write_json`.
* No PII in log lines (we never log opponent or author names at
  INFO level).
* Type hints on every public function. Functions <= 30 lines,
  cyclomatic complexity <= 10.

Example:
    >>> from core.custom_builds import load_custom_builds_v2
    >>> data = load_custom_builds_v2()
    >>> isinstance(data, dict)
    True
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from .atomic_io import atomic_write_json
from .paths import CUSTOM_BUILDS_FILE, DATA_DIR

LOGGER = logging.getLogger(__name__)

#: File version we own going forward.
SCHEMA_VERSION = 2

#: Sibling cache file mirroring the community-builds service.
COMMUNITY_CACHE_FILE = os.path.join(DATA_DIR, "community_builds.cache.json")

#: Default tolerance/threshold for migrated builds. Matches the
#: defaults used by the SPA editor and the Express router so the
#: same build matches identically on both sides.
DEFAULT_TOLERANCE_SEC = 15
DEFAULT_MIN_MATCH_SCORE = 0.6

#: Map v1 ``"matchup"`` strings to v2 ``"vs_race"`` values.
_MATCHUP_TO_VS_RACE = {
    "vs Zerg": "Zerg",
    "vs Protoss": "Protoss",
    "vs Terran": "Terran",
    "vs Random": "Random",
    "vs Any": "Any",
}

#: v1 rule types that translate cleanly to a v2 signature event.
_TRANSLATABLE_RULE_TYPES = {"building", "unit", "upgrade"}


def _empty_v1() -> Dict[str, List[Dict]]:
    """Return the empty v1-shaped bucket the legacy parser expects."""
    return {"Opponent": [], "Self": []}


def _empty_v2_file() -> Dict[str, Any]:
    """Return the empty v2 file shape."""
    return {"version": SCHEMA_VERSION, "builds": []}


def _now_iso() -> str:
    """Return an ISO-8601 UTC timestamp."""
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _read_json(path: str) -> Optional[Dict[str, Any]]:
    """Read a JSON file with BOM stripping; ``None`` on missing."""
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8-sig") as src:
            return json.load(src)
    except json.JSONDecodeError as exc:
        LOGGER.warning("custom_builds.read_failed path=%s err=%s", path, exc)
        return None


def _is_v1(data: Dict[str, Any]) -> bool:
    """Return True when ``data`` looks like the legacy v1 shape.

    A v1 file lacks ``version: 2`` and has at least one entry with
    ``target`` or ``rules``. An empty file with neither is treated
    as v2-blank for migration purposes.
    """
    if not isinstance(data, dict):
        return False
    if data.get("version") == SCHEMA_VERSION:
        return False
    builds = data.get("builds")
    if not isinstance(builds, list):
        return False
    return any(
        isinstance(b, dict) and ("target" in b or "rules" in b) for b in builds
    )


def load_custom_builds() -> Dict[str, List[Dict]]:
    """Load v1-shaped custom builds for the legacy parser detectors.

    After Stage 7.4 the on-disk file is migrated to v2 and this
    function returns empty buckets -- the rules-engine path is a
    no-op for new builds, and the v2 classifier handles them via
    :func:`load_custom_builds_v2`.

    Returns:
        ``{"Opponent": [...], "Self": [...]}``.
    """
    data = _read_json(CUSTOM_BUILDS_FILE)
    if not data:
        return _empty_v1()
    builds = data.get("builds") if isinstance(data, dict) else None
    if not isinstance(builds, list):
        return _empty_v1()
    out = _empty_v1()
    for entry in builds:
        if not isinstance(entry, dict):
            continue
        target = entry.get("target")
        if target in out:
            out[target].append(entry)
    return out


def load_custom_builds_v2() -> Dict[str, Any]:
    """Load the v2-shaped local custom-builds cache.

    Triggers the v1->v2 migration on the first call after the
    Stage 7.4 release. Returns the empty v2 shape if the file
    does not exist or could not be parsed.
    """
    raw = _read_json(CUSTOM_BUILDS_FILE)
    if raw is None:
        return _empty_v2_file()
    if _is_v1(raw):
        return _migrate_v1_to_v2(raw)
    if raw.get("version") != SCHEMA_VERSION:
        LOGGER.warning(
            "custom_builds.unexpected_version version=%s", raw.get("version")
        )
        return _empty_v2_file()
    return raw


def load_community_cache() -> Dict[str, Any]:
    """Load the local mirror of the community-builds service."""
    raw = _read_json(COMMUNITY_CACHE_FILE)
    if raw is None or not isinstance(raw.get("builds"), list):
        return {
            "version": 2,
            "last_sync_at": None,
            "server_now": 0,
            "builds": [],
        }
    return raw


def _migrate_v1_to_v2(v1_data: Dict[str, Any]) -> Dict[str, Any]:
    """Migrate v1 custom_builds.json to v2 in place.

    Writes a ``.pre-v2-bak.<ts>`` backup of the original file and
    a sibling ``.migration-report.json`` listing translated and
    skipped builds. Idempotent.
    """
    timestamp = datetime.now(tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_path = "%s.pre-v2-bak.%s" % (CUSTOM_BUILDS_FILE, timestamp)
    if os.path.exists(CUSTOM_BUILDS_FILE):
        with open(CUSTOM_BUILDS_FILE, "rb") as src:
            payload = src.read()
        with open(backup_path, "wb") as dst:
            dst.write(payload)
    converted, report = _translate_v1_builds(v1_data.get("builds", []))
    new_file: Dict[str, Any] = {"version": SCHEMA_VERSION, "builds": converted}
    atomic_write_json(CUSTOM_BUILDS_FILE, new_file, indent=2)
    _write_migration_report(report, backup_path)
    LOGGER.info(
        "custom_builds.migrated_v1_to_v2 converted=%d skipped=%d partial=%d",
        len(converted),
        len(report["skipped"]),
        len(report["partial"]),
    )
    return new_file


def _translate_v1_builds(
    v1_builds: List[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], Dict[str, List[Dict[str, Any]]]]:
    """Translate every v1 build to v2; collect a migration report."""
    converted: List[Dict[str, Any]] = []
    report: Dict[str, List[Dict[str, Any]]] = {
        "converted": [],
        "partial": [],
        "skipped": [],
    }
    for entry in v1_builds:
        if not isinstance(entry, dict) or not entry.get("name"):
            continue
        translated, dropped = _translate_one_v1_build(entry)
        if translated is None:
            report["skipped"].append(
                {"name": entry.get("name"), "dropped_rules": dropped}
            )
            continue
        if dropped:
            report["partial"].append(
                {"name": entry.get("name"), "dropped_rules": dropped}
            )
        else:
            report["converted"].append({"name": entry.get("name")})
        converted.append(translated)
    return converted, report


def _translate_one_v1_build(
    entry: Dict[str, Any],
) -> Tuple[Optional[Dict[str, Any]], List[Dict[str, Any]]]:
    """Translate a single v1 build dict into the v2 wire shape."""
    signature: List[Dict[str, Any]] = []
    dropped: List[Dict[str, Any]] = []
    for rule in entry.get("rules", []) or []:
        sig = _v1_rule_to_signature_event(rule)
        if sig is None:
            dropped.append(rule)
            continue
        signature.append(sig)
    if not signature:
        return None, dropped
    name = entry["name"]
    race = entry.get("race", "Protoss")
    if race == "Any":
        race = "Protoss"
    matchup = entry.get("matchup", "vs Any")
    return {
        "id": _slug_for(name, entry.get("target", "Opponent")),
        "name": name,
        "race": race,
        "vs_race": _MATCHUP_TO_VS_RACE.get(matchup, "Any"),
        "tier": None,
        "description": entry.get("description") or "",
        "win_conditions": [],
        "loses_to": [],
        "transitions_into": [],
        "signature": signature,
        "tolerance_sec": DEFAULT_TOLERANCE_SEC,
        "min_match_score": DEFAULT_MIN_MATCH_SCORE,
        "source_replay_id": None,
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
        "author": "migrated-from-v1",
        "sync_state": "pending",
    }, dropped


def _v1_rule_to_signature_event(rule: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Map a single v1 rule dict to a v2 signature event."""
    if not isinstance(rule, dict):
        return None
    rule_type = rule.get("type")
    name = rule.get("name")
    if rule_type not in _TRANSLATABLE_RULE_TYPES:
        return None
    if not isinstance(name, str):
        return None
    time_lt = rule.get("time_lt", 300)
    if not isinstance(time_lt, int) or time_lt < 0:
        return None
    verb_map = {"building": "Build", "unit": "Train", "upgrade": "Research"}
    verb = verb_map[rule_type]
    return {"t": min(int(time_lt), 1800), "what": verb + name, "weight": 1.0}


def _slug_for(name: str, target: str) -> str:
    """Generate a kebab-case id from a name + target prefix."""
    prefix = "self" if target == "Self" else "opp"
    body = "".join(ch.lower() if ch.isalnum() else "-" for ch in name)
    body = "-".join(part for part in body.split("-") if part)
    slug = (prefix + "-" + body)[:80] if body else (prefix + "-build")
    return slug or (prefix + "-build")


def _write_migration_report(
    report: Dict[str, List[Dict[str, Any]]], backup_path: str
) -> None:
    """Persist the migration report next to the v2 file."""
    out = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": _now_iso(),
        "backup_path": backup_path,
        "summary": {k: len(v) for k, v in report.items()},
        "details": report,
        "notes": [
            "unit_max and proxy rule types have no v2 equivalent and are dropped.",
            "Substring-matched upgrade names are translated as exact tokens; review the partial list.",
        ],
    }
    report_path = CUSTOM_BUILDS_FILE + ".migration-report.json"
    atomic_write_json(report_path, out, indent=2)


def initialize_custom_builds() -> None:
    """Create or upgrade ``custom_builds.json`` to v2 if needed.

    Idempotent: a v2 file is left untouched. A v1 file is migrated
    in place. A missing file is created empty.
    """
    raw = _read_json(CUSTOM_BUILDS_FILE)
    if raw is None:
        atomic_write_json(CUSTOM_BUILDS_FILE, _empty_v2_file(), indent=2)
        return
    if _is_v1(raw):
        _migrate_v1_to_v2(raw)
        return
    if raw.get("version") != SCHEMA_VERSION:
        LOGGER.warning(
            "custom_builds.unknown_version_left_alone version=%s",
            raw.get("version"),
        )


# Initialize on import so the analyzer process always starts with
# a v2 file on disk -- this matches the legacy module's contract
# of "initialize on import" and keeps the SPA / Python halves
# from racing on the first run.
initialize_custom_builds()
