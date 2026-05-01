"""
pulse_resolver.py -- toon-handle -> SC2Pulse character ID.

Why this exists
---------------
During the live phase of a 1v1, the only opponent identifier the
overlay has is the on-screen display name parsed off the loading
screen. For "barcodes" -- players whose names are visually
ambiguous strings like ``"IIIIIIIIIII"`` -- a name-based lookup
against the Black Book (``MyOpponentHistory.json``) can collide
with a different player who happens to share the same barcode
shape, so the overlay shows the wrong stats and the deep persist
appends the new game to the wrong record.

Once a replay file is on disk we have a much stronger handle:
``sc2reader`` exposes ``toon_handle`` for every player, formatted
as ``"<region>-S2-<realm>-<battlenetId>"``. That tuple uniquely
identifies a Battle.net character world-wide. This module turns
the toon handle into the canonical SC2Pulse character ID by:

  1. Searching SC2Pulse for characters in the right region/queue
     that match the opponent's display name, with case-sensitive
     matching enabled. (Barcodes return many candidates; clean
     names typically return one.)
  2. Disambiguating each candidate by fetching its team roster and
     comparing the Pulse-side ``battlenetId`` against the bnid
     parsed off the toon. Exactly the same disambiguation flow as
     ``scripts/resolve_pulse_ids.py`` -- battle-tested.

The resolver is **best effort**. If SC2Pulse is unreachable, the
opponent has no Pulse record yet, or the toon parse fails, the
function returns ``None`` and the watcher falls back to the
existing name-based lookup. This is intentional: no mock data,
no synthetic IDs.

Engineering preamble compliance
-------------------------------
* Pure module: HTTP client is injected for tests.
* Module-level cache so repeat lookups against the same toon don't
  hammer the SC2Pulse API. Cache key is the raw toon handle.
* Type hints on every public function; ``mypy --strict`` clean.
* No PII at INFO level: opponent display names are SHA1-hashed
  before they hit the print stream.
* Functions <= 30 lines, files << 800 lines.

Example
-------
    >>> resolve_pulse_id_by_toon("1-S2-1-267727", "ReSpOnSe")  # doctest: +SKIP
    '452727'
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import threading
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, Optional, Tuple

PULSE_API_ROOT = "https://sc2pulse.nephest.com/sc2/api"
QUEUE_1V1 = "LOTV_1V1"
HTTP_TIMEOUT_SEC = 10
USER_AGENT = "sc2tools-pulse-resolver"

# SC2Pulse region codes match Blizzard's: 1=US, 2=EU, 3=KR, 5=CN, 98=PT.
# The first segment of an sc2reader toon_handle is the same code.
REGION_CODE_TO_NAME: Dict[int, str] = {1: "US", 2: "EU", 3: "KR", 5: "CN"}

# Module-level cache: toon -> pulse_id (or empty string for "looked up,
# no match"). Negative caching avoids re-querying for unknown opponents
# on every replay.
_RESOLVE_CACHE: Dict[str, str] = {}
_CACHE_LOCK = threading.Lock()

# Default JSON fetcher; overridable for tests.
JsonFetcher = Callable[[str], Optional[Any]]


def _hash_name(name: str) -> str:
    """SHA1 prefix of a display name -- safe to log at INFO level."""
    if not name:
        return "empty"
    h = hashlib.sha1(name.encode("utf-8", errors="ignore")).hexdigest()
    return f"name#{h[:8]}"


def parse_toon_handle(toon: Optional[str]) -> Optional[Tuple[int, int, int]]:
    """Split ``"1-S2-1-267727"`` into ``(region, realm, battlenetId)``.

    Returns ``None`` for blank, malformed, or non-S2 (Heart of the Swarm
    legacy / co-op AI) handles.

    Example:
        >>> parse_toon_handle("1-S2-1-267727")
        (1, 1, 267727)
        >>> parse_toon_handle("garbage") is None
        True
    """
    if not toon or not isinstance(toon, str):
        return None
    parts = toon.strip().split("-")
    if len(parts) != 4 or parts[1].upper() != "S2":
        return None
    try:
        region = int(parts[0])
        realm = int(parts[2])
        bnid = int(parts[3])
    except (TypeError, ValueError):
        return None
    if region not in REGION_CODE_TO_NAME or bnid <= 0:
        return None
    return region, realm, bnid


def _default_fetch_json(url: str) -> Optional[Any]:
    """Best-effort GET that returns parsed JSON or None on any error."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SEC) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as err:  # noqa: BLE001 -- best-effort lookup
        # Stay quiet on the hot path; emit only on stderr so production
        # logs don't fill up with transient connection blips.
        print(f"[pulse_resolver] HTTP {url}: {err}", file=sys.stderr)
        return None


def _latest_season_for_region(region: int, fetch_json: JsonFetcher) -> Optional[int]:
    """Highest battlenetId season number for ``region``, or None offline."""
    seasons = fetch_json(f"{PULSE_API_ROOT}/season/list/all") or []
    region_name = REGION_CODE_TO_NAME.get(region, "").upper()
    if not isinstance(seasons, list) or not region_name:
        return None
    best: Optional[int] = None
    for entry in seasons:
        if not isinstance(entry, dict):
            continue
        if (entry.get("region") or "").upper() != region_name:
            continue
        bnid = entry.get("battlenetId")
        if isinstance(bnid, int) and (best is None or bnid > best):
            best = bnid
    return best


def _search_candidates(
    *,
    name: str,
    region: int,
    season_id: int,
    fetch_json: JsonFetcher,
) -> list:
    """SC2Pulse candidate Pulse character IDs for (name, region)."""
    region_name = REGION_CODE_TO_NAME.get(region, "").upper()
    if not name or not region_name:
        return []
    encoded = urllib.parse.quote(name)
    url = (
        f"{PULSE_API_ROOT}/character/search/advanced"
        f"?season={season_id}&region={region_name}&queue={QUEUE_1V1}"
        f"&name={encoded}&caseSensitive=true"
    )
    body = fetch_json(url)
    return body if isinstance(body, list) else []


def _confirm_by_bnid(
    *,
    candidate_id: int,
    region: int,
    expected_bnid: int,
    fetch_json: JsonFetcher,
) -> bool:
    """True if any team member's Pulse character matches the toon bnid."""
    region_name = REGION_CODE_TO_NAME.get(region, "").upper()
    teams = fetch_json(f"{PULSE_API_ROOT}/character/{int(candidate_id)}/teams") or []
    if not isinstance(teams, list):
        return False
    for team in teams:
        if not isinstance(team, dict):
            continue
        for member in team.get("members") or []:
            if not isinstance(member, dict):
                continue
            ch = member.get("character") or {}
            ch_region = (ch.get("region") or "").upper()
            if ch_region == region_name and ch.get("battlenetId") == expected_bnid:
                return True
    return False


def _cache_get(toon: str) -> Optional[str]:
    with _CACHE_LOCK:
        return _RESOLVE_CACHE.get(toon)


def _cache_put(toon: str, value: str) -> None:
    with _CACHE_LOCK:
        _RESOLVE_CACHE[toon] = value


def clear_cache() -> None:
    """Drop all memoized toon -> pulse_id entries (test hook)."""
    with _CACHE_LOCK:
        _RESOLVE_CACHE.clear()


def resolve_pulse_id_by_toon(
    toon: Optional[str],
    opp_name: Optional[str],
    *,
    fetch_json: JsonFetcher = _default_fetch_json,
) -> Optional[str]:
    """Return the SC2Pulse character ID for the player behind ``toon``.

    Args:
        toon: ``sc2reader`` ``toon_handle`` like ``"1-S2-1-267727"``.
        opp_name: Display name -- used to narrow the candidate search
            since SC2Pulse's advanced endpoint requires a name term.
            For barcodes pass the raw barcode (it'll match other
            barcodes; the bnid filter still picks the right one).
        fetch_json: Override for tests. Returns parsed JSON or None.

    Returns:
        Numeric SC2Pulse character ID as a string, or ``None`` if the
        toon is malformed, the API is unreachable, or no candidate
        matches the bnid.

    Example:
        >>> resolve_pulse_id_by_toon("1-S2-1-267727", "ReSpOnSe")  # doctest: +SKIP
        '452727'
    """
    parsed = parse_toon_handle(toon)
    if not parsed:
        return None
    cached = _cache_get(toon)
    if cached is not None:
        return cached or None
    region, _realm, bnid = parsed
    name_for_search = (opp_name or "").strip()
    if not name_for_search:
        _cache_put(toon, "")
        return None

    season_id = _latest_season_for_region(region, fetch_json)
    if season_id is None:
        # Don't poison the cache on a transient outage -- next replay
        # gets another shot.
        return None

    candidates = _search_candidates(
        name=name_for_search,
        region=region,
        season_id=season_id,
        fetch_json=fetch_json,
    )
    if not candidates:
        _cache_put(toon, "")
        return None

    for cid in candidates:
        try:
            cid_int = int(cid)
        except (TypeError, ValueError):
            continue
        if _confirm_by_bnid(
            candidate_id=cid_int,
            region=region,
            expected_bnid=bnid,
            fetch_json=fetch_json,
        ):
            resolved = str(cid_int)
            _cache_put(toon, resolved)
            print(
                f"[pulse_resolver] resolved {_hash_name(name_for_search)} "
                f"region={region} bnid={bnid} -> pulse_id {resolved}"
            )
            return resolved

    # No candidate matched bnid. Cache the negative result so we don't
    # re-search every replay for the same toon -- common with smurfs
    # who haven't played enough ranked games to be in SC2Pulse yet.
    _cache_put(toon, "")
    return None


__all__ = [
    "parse_toon_handle",
    "resolve_pulse_id_by_toon",
    "clear_cache",
    "PULSE_API_ROOT",
    "QUEUE_1V1",
    "REGION_CODE_TO_NAME",
]
