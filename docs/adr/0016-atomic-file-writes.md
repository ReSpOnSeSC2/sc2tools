# ADR 0016: All data-file writes go through the atomic-write helpers

**Status**: Accepted
**Date**: 2026-04-30
**Context**: Truncation incident, April 2026 (see
`docs/TRUNCATION_AUDIT.md`)

## Summary

Every writer that mutates a tracked data file (`data/*.json`,
`profile.json`, `config.json`, the WP model pickle, the spatial cache,
the community-sync queue, etc.) must route through the canonical
atomic-write helpers:

- Python: `core.atomic_io.atomic_write_json`,
  `core.atomic_io.atomic_write_text`,
  `core.atomic_io.atomic_write_bytes`
- Node: `lib/atomic-fs.js` exporting `atomicWriteJson`,
  `atomicWriteString`, `atomicWriteBuffer`,
  `quarantineCorruptFile`

Writers that need atomic semantics but cannot use the helpers (foreign
file formats, native libraries that own their own descriptor) must
implement the full sequence locally: write to a sibling tempfile,
`flush`, `fsync`, `close`, `os.replace` / `fs.renameSync`. **Skipping
the `fsync` is forbidden.**

## Context

### What the bug looked like

Three classes of truncation were observed on the user's Windows
install over a 96-hour window:

- **Mode A — abrupt-kill**: ends mid-record (`},\n}`), structurally
  prefix of the intended payload. Causes: any writer that does
  `tempfile + os.replace` without an intervening `fsync`. The kernel
  publishes the rename's directory entry but defers the data flush;
  if the process or OS dies in that window, the renamed-into-place
  file contains only the bytes that the lazy writer happened to have
  flushed.
- **Mode B — indent-line truncation**: ends in 4 spaces (the indent
  of a JSON pretty-print line). Same mechanism as Mode A — the gap
  fell on a whitespace boundary instead of a record boundary.
- **Mode C — null-padding**: ends in `\x00\x00...`. Filesystem
  metadata says the file is N bytes; the final data block was never
  written, so it reads as zeros. Same mechanism as Mode A — the
  metadata flush and data flush are separate IOs.

All three modes are eliminated by the `fsync` between write and
rename. POSIX guarantees rename atomicity on the same filesystem;
NTFS provides equivalent semantics for non-cross-volume renames.

### Why this happened

The codebase already had two correct atomic-write helpers
(`core/atomic_io.py`, `lib/atomic-fs.js`) before the incident, but
**migration was incomplete**:

- `SC2Replay-Analyzer/scripts/macro_cli.py` and
  `reveal-sc2-opponent-main/scripts/buildorder_cli.py` both contained
  a private `_save_db` that did `tempfile + os.replace` without
  `fsync`. These CLIs are spawned per-replay by `analyzer.js`, so
  every game played hit the bug.
- Three duplicated atomic-write implementations had drifted on the
  Node side: `_atomicWriteJsonSync` in `index.js`, `persistMetaDb`'s
  inline writer in `analyzer.js`, and a local `atomicWriteJson` in
  `routes/settings.js`. All three were correct in isolation, but
  drift between them was the breeding ground for the next
  regression.
- Several Python writers used bare `open(path, "w")` for non-JSON
  outputs (error logs, CSV exports, debug reports, marker files).
  Low blast radius per file, but inconsistent with the helper
  contract and a source of confusion.
- The `analytics/spatial.py` cache and the
  `analytics/win_probability.py` model pickle both did
  `tempfile + os.replace` without `fsync`. Same bug pattern, two
  more surfaces.

### Decision

1. **One canonical helper per language.** Python = `core.atomic_io`;
   Node = `lib/atomic-fs`. Every other writer delegates.
2. **Bare writes are forbidden** for any tracked data path. The
   `pre-commit` / CI guard at `scripts/check_atomic_writes.py`
   enforces this by greppping the production trees for the bug
   patterns and exiting non-zero on any violation. The guard is
   designed to run with no external dependencies.
3. **Exemptions are explicit.** If a file legitimately writes a
   non-data path (build-time manifests, error-log fallback paths,
   image-cache PNG fetch), it goes in the guard's allow-list with a
   one-line justification. The allow-list is reviewed in PR.
4. **Existing duplicate writers become thin shims.** They keep their
   exported names so external callers are unaffected, but their
   bodies become a single delegation call to the canonical helper.

### What this rules out

- **No new atomic-write implementations.** A PR that introduces a
  fourth `_atomicWriteJsonSync`-style helper should be rejected. If
  the canonical helper is missing a needed primitive, add the
  primitive to the canonical helper and use it from the new caller.
- **No `os.replace` without `fsync`** in production Python. The
  guard catches this.
- **No `fs.writeFileSync` outside the helper or the documented
  exempt list** in production Node. The guard catches this.
- **No new `r+`-mode opens for writing.** `r+` does not truncate;
  it preserves the previous file length and pads any unwritten
  trailing bytes with stale data or NULs. Use `w` mode (truncates
  on open) routed through the helper.

## Migration completed in this ADR's PR series

- **Phase 0 (audit)**: `docs/TRUNCATION_AUDIT.md`
- **Phase 1 (P0 fix)**: `flush + fsync` in
  `scripts/macro_cli.py` and `scripts/buildorder_cli.py` `_save_db`
- **Phase 2 (P2 long-tail)**: migrate `core/error_logger.py`,
  `gui/analyzer_app.py` (CSV + debug-report writers),
  `core/custom_builds.py` (binary backup copy),
  `core/data_store.py` (backup marker)
- **Phase 3 (P1 consolidation)**: collapse the three Node atomic-write
  duplicates to delegators against `lib/atomic-fs.js`
- **Phase 4 (preventative)**: add `scripts/check_atomic_writes.py`
  guard; fix the two additional violations it surfaced in
  `analytics/spatial.py` and `analytics/win_probability.py`
- **Phase 5 (this ADR + CHANGELOG)**

## Verification

- `python3 scripts/check_atomic_writes.py --verbose` returns
  `Atomic-write guard: clean` against the production trees.
- Round-trip smoke for both helpers (`atomic_write_*` in Python,
  `atomicWrite*` in Node) passes; no orphan `.tmp_*` files left
  behind.
- Recovery procedure documented in `TRUNCATION_AUDIT.md` recovered
  3 corrupt data files plus 5 secondary corrupt JSONs; the
  `.live-broken-pre-recovery-*` siblings preserve the prior state
  for forensic comparison.

## Follow-ups (not in this ADR)

- **Reconciliation pass for `unknown:<Name>` opponents**: when the
  SC2Pulse lookup fails on the first encounter and succeeds later,
  the opponent's history is split across two keys
  (`unknown:<Name>` and `12345`). The reconciler walks the file,
  finds matching `Name` fields, merges games into the numeric-id
  record, and removes the `unknown:` entry. Tracked separately
  because it touches the data model and needs UI confirmation on
  merge conflicts.
- **Fault-injection integration test.** Spawn a writer in a
  subprocess, kill it at random points during the write, verify
  the live file is always either pre-write valid or post-write
  valid. Designed but not landed in this PR series.
- **Opponent-name encoding normalisation**. One `unknown:<mojibake>`
  entry surfaced in the live file — a name that was double-encoded
  through cp1252→utf-8→cp1252. Belongs in its own ADR.
