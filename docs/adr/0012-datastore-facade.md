# ADR 0012 — Datastore facade for data/* JSON files

Status: Accepted
Date: 2026-04-30
Owner: backend infrastructure

## Context

During the engineering pass that landed the Settings UI rework
(commits prefixed `settings-pr1*`) we hit FOUR independent
data-corruption events on JSON files under `reveal-sc2-opponent-main/data/`:

1. **`community_sync_queue.json` truncated mid-write at 03:51.** Live
   process write didn't fsync; OS killed before the buffer flushed.
   Symptom: `health.test.js` and `version.test.js` failed to load
   `index.js` because the queue file's JSON parse threw at startup.
2. **`config.json` truncated mid-write later that day.** Same pattern,
   34 bytes of JSON followed by ~1.2 KB of NUL padding (the previous
   file's length, preserved because some writer used `r+` open mode
   instead of `w` + truncate).
3. **`custom_builds.json` destructively downgraded by Python's
   `core/custom_builds.py`.** Python's `SCHEMA_VERSION = 2` while the
   Express writer was at `3`; Python's `_is_v1` heuristic flagged any
   v3 file with a `rules` field as v1, ran a "downgrade" migration
   that didn't recognize v3 rule types, dropped every rule, ended up
   writing `{"version":2,"builds":[]}` over the user's data. Repeated
   on every replay parse.
4. **`config.json` missing `telemetry` and `ui` blocks** after a
   manual salvage cut at the wrong byte boundary. Every subsequent
   PATCH from the SPA failed schema validation on a top-level field
   the user never touched, surfaced as "Some changes were rejected."

The common shape: **scattered fs writers, opportunistic readers that
returned empty defaults instead of failing loudly, and no central
validation gate.** Hard Rule #4 in the master preamble (atomic writes
for every `data/*` mutation) was honored by some helpers and bypassed
by others. There was no single place to enforce it.

## Decision

Two new modules under `stream-overlay-backend/lib/`:

### `lib/atomic-fs.js`

Low-level primitives. Three functions, all using `tmp + fsync + rename`
with a fresh `'w'` descriptor (truncates on open — physically
impossible to leave NUL padding):

- `atomicWriteJson(path, data, [{indent}])`
- `atomicWriteString(path, value, [{encoding, mode}])`
- `atomicWriteBuffer(path, buffer, [{mode}])`
- `quarantineCorruptFile(path, [reason])` → renames to
  `<path>.broken-<reason>-<ts>` so the next write goes to a fresh
  file instead of merging into a known-bad blob.

13 tests cover happy path, longer-existing-file truncation (no NUL
padding), tmp cleanup on success, and quarantine.

### `lib/datastore.js`

Policy layer. Reads validate against the registered schema and
quarantine on failure. Writes validate BEFORE touching disk and only
then go through `atomic-fs`. Single registry maps short names to
filenames + schemas + default factories:

```js
const REGISTRY = {
  profile:       { file: 'profile.json',       schema: 'profile.schema.json',       defaults: () => null },
  config:        { file: 'config.json',        schema: 'config.schema.json',        defaults: () => null },
  custom_builds: { file: 'custom_builds.json', schema: 'custom_builds.schema.json', defaults: () => ({ version: 3, builds: [] }) },
};
```

Public API on each instance:

- `read(name, [{ fallback }])` — returns parsed value, or fallback
  on missing/parse-error/schema-invalid (with quarantine on the latter
  two)
- `write(name, value)` — validates, throws `ValidationError` with
  structured ajv errors on bad shape, otherwise atomic write
- `has(name)` / `pathFor(name)` — tiny conveniences

13 tests cover factory contract, default-on-missing, quarantine on
parse error, quarantine on schema invalid, **trailing-NUL partial-write
recovery (the exact failure mode that bit us today)**, atomic write
hygiene, ValidationError surface, no-NUL-padding on overwrite, unknown
document rejection, and end-to-end round trips.

## Phase 1 — atomic-fs adoption (DONE in this PR)

Patched 3 non-atomic writers identified by audit:
- `services/community_sync.js` — `ensureClientId` + `writeCachedPepper`
  now use `atomicFs.atomicWriteString`
- `analyzer.js` — map image cache write now uses
  `atomicFs.atomicWriteBuffer`
- `services/community_sync.js` and `routes/custom_builds_helpers.js`'s
  duplicated `atomicWriteJson` helpers replaced with thin wrappers
  delegating to `atomicFs.atomicWriteJson`

Net result: every `data/*` write in the backend now goes through one
of the four atomic-fs primitives. No grep finds any naked
`fs.writeFileSync` writing to `data/*` outside the helper.

## Phase 2 — datastore migration (incremental, Boy Scout)

Each route that reads or writes `data/*.json` should migrate to the
datastore facade. Migration target: ONE route per PR, with all
existing tests still green afterward.

### Migration order (highest risk first)

1. **`routes/settings.js`** — owns `profile.json` + `config.json`,
   the two files corrupted today. Replaces local `readJsonStripBom` +
   `readJsonOrNull` + `atomicWriteJson` + ajv setup with one
   `createDatastore({ dataDir })` call. `handleGet` becomes
   `ds.read(spec.name)`, `handlePut`/`handlePatch` become
   `ds.write(spec.name, value)`. Existing 263 lines of
   `__tests__/settings.test.js` are the safety net.

2. **`routes/custom-builds.js`** — owns `custom_builds.json`. Already
   uses `atomicWriteJson` correctly; migration is mostly about adding
   schema validation on read so a corrupt file is caught at read time
   instead of biting the next write.

3. **`services/community_sync.js`** — owns
   `community_sync_queue.json` + `community_builds.cache.json`. Add
   these to the registry first, then migrate the readers/writers.
   The `last_error` field becomes the natural place to surface
   quarantine events to the SPA.

### Migration acceptance criteria (per PR)

- [ ] All existing tests for the migrated route still pass.
- [ ] No `fs.writeFileSync` / `fs.openSync` / `fs.writeSync` calls
      remain in the migrated module against `data/*` paths.
- [ ] No locally-defined `atomicWriteJson` / `readJsonOrNull` remain.
- [ ] `ds.read` is called with `{ fallback }` everywhere a missing
      file is a normal first-run state; otherwise a startup-time
      check fails loudly.
- [ ] `ds.write` errors propagate as `400 validation_failed` (with
      ajv errors echoed) instead of `500`.
- [ ] CHANGELOG.md updated.

## Consequences

- Single place to enforce Hard Rule #4. Future writers cannot
  regress without going around the facade — and an eslint rule
  banning `fs.writeFileSync` in `routes/`/`services/` (filed as a
  follow-up) makes that ban mechanical.
- Schema drift between Python and JS is still possible for files the
  Python project also touches (notably `custom_builds.json`). That
  needs a separate fix (single source of truth for `SCHEMA_VERSION`
  across language boundaries — likely shipping the `*.schema.json`
  files as the canonical contract both sides import). Filed as
  Stage 11.5 candidate.
- Quarantine + fallback means the user no longer sees "Some changes
  were rejected" for fields they never touched. They DO see the
  warning that an old file was quarantined, surfaced via the
  diagnostics panel.

## Plan to enforce Phase 2 completion

A one-shot CI script (`tools/check-no-bare-writes.js`) greps the
backend for `fs.writeFileSync` / `fs.writeSync` / `fs.openSync` calls
outside `lib/atomic-fs.js`, `lib/datastore.js`, and the test files.
Fails the build if any new ones land. Filed as a follow-up; today's
audit was manual.
