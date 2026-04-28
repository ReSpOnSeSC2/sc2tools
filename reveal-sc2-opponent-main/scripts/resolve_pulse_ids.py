"""
resolve_pulse_ids.py — auto-resolve SC2Pulse character IDs from the
wizard-saved identities in data/config.json.

End users never need to know what a "Pulse character ID" is. The
wizard captures their Battle.net name and region; this script does
the rest.

Flow
----
1. Read data/config.json (identities[]: name, region, character_id).
2. For each identity, query SC2Pulse:
     /character/search/advanced?season=<latest>&region=<R>&queue=LOTV_1V1
       &name=<name>&caseSensitive=true
   to get candidate Pulse IDs.
3. Disambiguate by fetching /character/<id>/teams and matching
   the Pulse `battlenetId` against the user's local Battle.net
   character_id (last segment of "1-S2-1-267727" -> 267727).
4. Write the resolved IDs to character_ids.txt at the project root
   (NA first, then EU, then KR per the user's preference) and cache
   them in data/profile.json under `pulse_character_ids`.

Idempotent: re-running produces the same output, and prints a clear
summary either way.

Example
-------
    python scripts/resolve_pulse_ids.py
"""
from __future__ import annotations

import json
import os
import sys
import urllib.parse
import urllib.request
from typing import Iterable

PULSE_API_ROOT = "https://sc2pulse.nephest.com/sc2/api"
QUEUE_1V1 = "LOTV_1V1"
HTTP_TIMEOUT_SEC = 10
REGION_PRIORITY = ("us", "eu", "kr", "cn")

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(PROJECT_ROOT, "data", "config.json")
PROFILE_PATH = os.path.join(PROJECT_ROOT, "data", "profile.json")
CHARACTER_IDS_PATH = os.path.join(PROJECT_ROOT, "character_ids.txt")


def _read_json(path: str) -> dict | None:
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as err:
        print(f"[resolver] could not read {path}: {err}", file=sys.stderr)
        return None


def _atomic_write_text(path: str, text: str) -> None:
    tmp = path + ".tmp_resolve"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _fetch_json(url: str) -> object | None:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "sc2tools-resolver"})
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SEC) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as err:  # noqa: BLE001 -- best-effort lookup
        print(f"[resolver] HTTP {url}: {err}", file=sys.stderr)
        return None


def _latest_seasons_by_region() -> dict[str, int]:
    seasons = _fetch_json(f"{PULSE_API_ROOT}/season/list/all") or []
    out: dict[str, int] = {}
    for s in seasons:
        region = (s.get("region") or "").upper()
        bnid = s.get("battlenetId")
        if not region or not isinstance(bnid, int):
            continue
        prev = out.get(region)
        if prev is None or bnid > prev:
            out[region] = bnid
    return out


def _bnid_from_local(character_id: str) -> int | None:
    """Strip "1-S2-1-267727" -> 267727 (the Battle.net character_id)."""
    if not character_id:
        return None
    last = character_id.rsplit("-", 1)[-1]
    return int(last) if last.isdigit() else None


def _resolve_one(name: str, region: str, expected_bnid: int | None,
                 season_id: int) -> int | None:
    """Find the Pulse character ID for (name, region) and confirm it
    matches the expected Battle.net character_id when known."""
    encoded = urllib.parse.quote(name)
    region_up = region.upper()
    search_url = (
        f"{PULSE_API_ROOT}/character/search/advanced"
        f"?season={season_id}&region={region_up}&queue={QUEUE_1V1}"
        f"&name={encoded}&caseSensitive=true"
    )
    candidates = _fetch_json(search_url)
    if not isinstance(candidates, list) or not candidates:
        return None
    if expected_bnid is None:
        return int(candidates[0])
    for cid in candidates:
        teams = _fetch_json(f"{PULSE_API_ROOT}/character/{int(cid)}/teams") or []
        for team in teams:
            for member in team.get("members", []):
                ch = member.get("character") or {}
                if (ch.get("region") or "").upper() == region_up \
                        and ch.get("battlenetId") == expected_bnid:
                    return int(cid)
    # Couldn't confirm — fall back to first candidate, with a warning.
    print(f"[resolver] WARN: could not confirm Pulse ID for {name} ({region_up}) "
          f"by Battle.net id {expected_bnid}; using first candidate {candidates[0]}",
          file=sys.stderr)
    return int(candidates[0])


def _sort_by_priority(items: list[tuple[str, int]]) -> list[int]:
    """`items` is [(region_lower, pulse_id), ...]; sort by REGION_PRIORITY."""
    rank = {r: i for i, r in enumerate(REGION_PRIORITY)}
    items_sorted = sorted(items, key=lambda kv: rank.get(kv[0], 999))
    return [pid for _, pid in items_sorted]


def resolve_from_config() -> list[int]:
    cfg = _read_json(CONFIG_PATH)
    if not cfg:
        return []
    identities = cfg.get("identities") or []
    if not identities:
        print("[resolver] no identities in data/config.json -- run the wizard first.",
              file=sys.stderr)
        return []
    seasons = _latest_seasons_by_region()
    if not seasons:
        print("[resolver] could not load Pulse seasons (offline?).", file=sys.stderr)
        return []
    region_to_id: list[tuple[str, int]] = []
    for ident in identities:
        name = (ident.get("name") or "").strip()
        region = (ident.get("region") or "").lower()
        local_cid = ident.get("character_id") or ""
        bnid = _bnid_from_local(local_cid)
        if not name or not region:
            continue
        season_id = seasons.get(region.upper())
        if season_id is None:
            print(f"[resolver] skip {name}: no Pulse season for region {region.upper()}",
                  file=sys.stderr)
            continue
        pulse_id = _resolve_one(name, region, bnid, season_id)
        if pulse_id is None:
            print(f"[resolver] skip {name} ({region.upper()}): no Pulse match",
                  file=sys.stderr)
            continue
        print(f"[resolver] {name} ({region.upper()}) bnid={bnid} -> Pulse ID {pulse_id}")
        region_to_id.append((region, pulse_id))
    return _sort_by_priority(region_to_id)


def cache_results(pulse_ids: Iterable[int]) -> None:
    ids = list(pulse_ids)
    text = ",".join(str(x) for x in ids)
    _atomic_write_text(CHARACTER_IDS_PATH, text)
    print(f"[resolver] wrote {CHARACTER_IDS_PATH}: {text or '(empty)'}")
    profile = _read_json(PROFILE_PATH) or {}
    profile["pulse_character_ids"] = ids
    _atomic_write_text(PROFILE_PATH, json.dumps(profile, indent=2) + "\n")
    print(f"[resolver] cached pulse_character_ids in {PROFILE_PATH}")


def main() -> int:
    if not os.path.exists(CONFIG_PATH):
        print("[resolver] data/config.json missing -- did the wizard run?",
              file=sys.stderr)
        return 1
    ids = resolve_from_config()
    if not ids:
        print("[resolver] no Pulse IDs resolved.", file=sys.stderr)
        return 2
    cache_results(ids)
    return 0


if __name__ == "__main__":
    sys.exit(main())
