"""
Production-quality meta_database.json recovery (v1.4.7).

Run from C:\\SC2TOOLS\\reveal-sc2-opponent-main\\data:

    py recover_meta_database.py

What it does:
  1. Salvages the current (truncated) meta_database.json by walking back
     through `},\\n` record boundaries until it parses (mirrors the
     analyzer.js v1.4.6 salvage strategy).
  2. Loads the latest cleanly-parseable backup (T19-02-22 from 2026-05-01,
     124 builds / 11,515 games) as the base.
  3. Per-build merge: union of games, deduped on the `id` field
     ("date|opponent|map|game_length"). When the same id appears in both,
     keeps the SALVAGED-CURRENT version (post-reclassify enrichment +
     anything written today).
  4. Quarantines the corrupt original + the backup-of-record under
     data/.recovery-meta-<UTC-timestamp>/ with a README explaining root
     cause + restoration approach.
  5. Atomic write: tmp file + os.fsync + os.replace. The output is
     compact JSON (no indent) for write speed -- the Node backend and
     PowerShell scanner both read JSON via standard parsers, so format
     is fully compatible. Per-write cost drops from ~80s to ~5s.
  6. Verifies the on-disk file parses cleanly before reporting success.

Safe to re-run if it bails partway through; quarantine dir is timestamped.
Backup file (used as base) is NOT deleted -- only copied for the audit
trail. Rolling back: delete the new meta_database.json and copy the file
under .recovery-meta-<ts>/used-as-base--... back into place.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

CURRENT = Path("meta_database.json")
BACKUP_BASE = Path("meta_database.json.pre-reclassify-2026-05-01T19-02-22-861Z")


def _salvage_truncated(raw: bytes):
    """Walk backward through `},\\n` record boundaries until parse OK.

    Returns (parsed_dict, cut_byte) or (None, None).
    """
    bounds = [m.start() for m in re.finditer(rb"\},\s*\n", raw)]
    for tries, idx in enumerate(reversed(bounds)):
        if tries > 500:
            break
        candidate = raw[: idx + 1] + b"\n}\n"
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                return parsed, idx
        except json.JSONDecodeError:
            continue
    return None, None


def _count_games(d) -> int:
    if not isinstance(d, dict):
        return 0
    n = 0
    for v in d.values():
        if isinstance(v, list):
            n += len(v)
        elif isinstance(v, dict):
            for sv in v.values():
                if isinstance(sv, list):
                    n += len(sv)
    return n


def main() -> int:
    if not CURRENT.exists():
        print(f"FATAL: {CURRENT} not found in {os.getcwd()}", file=sys.stderr)
        return 1
    if not BACKUP_BASE.exists():
        print(f"FATAL: backup base {BACKUP_BASE} not found", file=sys.stderr)
        return 1

    ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    recovery_dir = Path(f".recovery-meta-{ts}")
    recovery_dir.mkdir(exist_ok=True)
    print(f"recovery dir: {recovery_dir}")
    print()

    # 1. Salvage current.
    print("=== Step 1: salvage current corrupt file ===")
    t = time.time()
    cur_raw = CURRENT.read_bytes()
    print(f"   read current: {len(cur_raw):,} bytes in {time.time() - t:.1f}s")
    salvaged, cut_at = _salvage_truncated(cur_raw)
    if salvaged is None:
        print("FATAL: salvage failed; could not find a parseable boundary.", file=sys.stderr)
        return 2
    cur_games = _count_games(salvaged)
    print(f"   salvaged: {len(salvaged):,} builds, {cur_games:,} games (cut@{cut_at:,})")
    del cur_raw

    # 2. Load backup base.
    print()
    print(f"=== Step 2: load backup base ({BACKUP_BASE.name}) ===")
    t = time.time()
    backup = json.loads(BACKUP_BASE.read_bytes())
    backup_games = _count_games(backup)
    print(
        f"   backup: {len(backup):,} builds, {backup_games:,} games "
        f"({time.time() - t:.1f}s)"
    )

    # 3. Per-build merge dedupe-on-id.
    print()
    print("=== Step 3: per-build merge dedup-on-game-id ===")
    t = time.time()
    new_builds = 0
    games_added = 0
    games_overwritten = 0
    for build, cur_payload in salvaged.items():
        if not isinstance(cur_payload, dict):
            continue
        if build not in backup:
            backup[build] = cur_payload
            new_builds += 1
            games_added += len(cur_payload.get("games") or [])
            continue
        base_payload = backup[build]
        if not isinstance(base_payload, dict):
            backup[build] = cur_payload
            continue
        for stat in ("wins", "losses"):
            cv = cur_payload.get(stat)
            bv = base_payload.get(stat)
            try:
                if cv is not None and (bv is None or int(cv) > int(bv)):
                    base_payload[stat] = cv
            except (TypeError, ValueError):
                pass
        cur_games_list = cur_payload.get("games") or []
        if not isinstance(cur_games_list, list):
            continue
        base_games_list = base_payload.setdefault("games", [])
        if not isinstance(base_games_list, list):
            base_payload["games"] = list(cur_games_list)
            continue
        base_by_id = {
            g["id"]: i
            for i, g in enumerate(base_games_list)
            if isinstance(g, dict) and g.get("id")
        }
        for g in cur_games_list:
            if not isinstance(g, dict):
                continue
            gid = g.get("id")
            if not gid:
                base_games_list.append(g)
                games_added += 1
                continue
            if gid in base_by_id:
                base_games_list[base_by_id[gid]] = g
                games_overwritten += 1
            else:
                base_games_list.append(g)
                games_added += 1
                base_by_id[gid] = len(base_games_list) - 1
    merged_games = _count_games(backup)
    print(
        f"   new builds added: {new_builds}, games added: {games_added:,}, "
        f"overwritten: {games_overwritten:,} ({time.time() - t:.1f}s)"
    )
    print(f"   merged total: {len(backup):,} builds, {merged_games:,} games")
    del salvaged

    # 4. Quarantine.
    print()
    print("=== Step 4: quarantine corrupt + backup-of-record ===")
    t = time.time()
    shutil.copy2(CURRENT, recovery_dir / f"{CURRENT.name}.corrupt-pre-recovery")
    shutil.copy2(BACKUP_BASE, recovery_dir / f"used-as-base--{BACKUP_BASE.name}")
    (recovery_dir / "README.txt").write_text(
        f"""meta_database.json corruption recovery -- {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}

Symptom: meta_database.json failed strict JSON.parse near EOF (byte
136,981,034 of 136,981,633). Brace-depth at EOF was 3 (three unclosed
opening braces) -- truncation mid-write rather than the trailing-padding
mode that hit MyOpponentHistory.json in v1.4.6. Last ~100 KB of the file
was a half-written game record.

Recovery (v1.4.7):
  - Salvaged current by walking backward through `}},\\n` record boundaries
    until parse succeeded (cut@{cut_at:,}, ~99.92% of file recovered,
    {cur_games:,} game records).
  - Loaded {BACKUP_BASE.name} as the base
    ({len(backup) - new_builds:,} builds, {backup_games:,} game records).
  - Per-build merge: union of games deduped on the `id` field. When the
    same id appeared in both, kept the SALVAGED-CURRENT version (it
    carries post-reclassify enrichment + any updated fields).

Final merged: {len(backup):,} builds, {merged_games:,} game records.

Output is COMPACT JSON (no indent) -- ~40% smaller, ~10x faster to
write/read than the indent=2 form. Both the Node backend and the
PowerShell scanner read this file via standard JSON parsers so format is
fully compatible.

Rollback: copy `used-as-base--*.json` from this directory back to
data/meta_database.json (this loses today's games but restores the
known-good base state).
""",
        encoding="utf-8",
    )
    print(f"   quarantined ({time.time() - t:.1f}s)")

    # 5. Atomic write.
    print()
    print("=== Step 5: atomic write (compact JSON for speed) ===")
    t = time.time()
    tmp = CURRENT.with_suffix(CURRENT.suffix + ".recovery-tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(backup, f, ensure_ascii=False, separators=(",", ":"))
        f.flush()
        os.fsync(f.fileno())
    out_sz = tmp.stat().st_size
    os.replace(tmp, CURRENT)
    print(f"   wrote {CURRENT}: {out_sz:,} bytes ({time.time() - t:.1f}s)")

    # 6. Verify.
    print()
    print("=== Step 6: verify on-disk parseability ===")
    t = time.time()
    verify = json.loads(CURRENT.read_bytes())
    verify_games = _count_games(verify)
    print(f"   parsed OK: {len(verify):,} builds, {verify_games:,} games ({time.time() - t:.1f}s)")
    print()
    print("RECOVERY COMPLETE.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
