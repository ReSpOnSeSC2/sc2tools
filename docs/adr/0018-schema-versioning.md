# ADR 0018 — Schema versioning + migrations

**Status**: Accepted (Stage 6 of `STAGE_DATA_INTEGRITY_ROADMAP`)
**Date**: 2026-05-04
**Owner**: Jonathan
**Supersedes**: nothing -- additive
**Related**: ADR 0016 (atomic file writes); ADR 0012 (datastore façade)

---

## Context

Three independent processes mutate `data/*.json`:

* The Python replay watcher (`replay_watcher.py` -> `core.data_store`)
* The Node Express backend (`stream-overlay-backend/analyzer.js`,
  `routes/custom-builds.js`, `routes/settings.js`, etc.)
* The PowerShell live-phase scanner (`Reveal-Sc2Opponent.ps1`)

When any one of those writers wants to add or rename a field, the
others have no way of telling whether a freshly-loaded file is in
the old or the new shape. ADR 0012 introduced a JSON Schema per
file plus a single-source-of-truth version constant under
`properties.version.const`, but only `custom_builds.json` opted into
that contract -- the other four tracked files (`MyOpponentHistory.json`,
`meta_database.json`, `profile.json`, `config.json`) never grew a
version key.

The 2026-04 truncation incidents had two root causes: a torn write
(addressed by Stage 4's validate-before-rename gate) **and** a faulty
mutation that read empty and wrote a 5-key dict on top of a 3,000-key
file (addressed by Stage 4's shrinkage floor). Both of those gates
would have happily accepted a "we dropped a field on purpose" mutation
without the schema-version step described here.

---

## Decision

Every tracked data file embeds an integer `_schema_version` key at
the top level. The single source of truth for the value is the
registry in `core/schema_versioning.py` and its byte-identical mirror
`stream-overlay-backend/lib/schema_versioning.js`.

For backwards compatibility with the existing v3 `custom_builds.json`
shape, the registry allows the `version_key` to differ per file:

| Basename                     | current | version_key       |
| ---------------------------- | ------: | ----------------- |
| MyOpponentHistory.json       |       1 | `_schema_version` |
| meta_database.json           |       1 | `_schema_version` |
| custom_builds.json           |       3 | `version`         |
| profile.json                 |       1 | `_schema_version` |
| config.json                  |       1 | `_schema_version` |

Stage 6 ships at v1 for every newly-versioned file, so no
migrations are registered on day 1; the infrastructure exists
so future bumps cannot regress.

### Stamping pattern

The canonical atomic-write helper (`core.atomic_io.atomic_write_json`,
`stream-overlay-backend/lib/atomic-fs.js atomicWriteJson`) is
**shape-neutral**. It does NOT auto-inject `_schema_version`; doing
so would leak a stray top-level integer into iterators that walk
`data.values()` (the `meta_database.json` reader is the canonical
example -- every value is expected to be a build dict).

Instead, the recommended pattern is:

```python
# Python
from core.schema_versioning import stamp_version
stamp_version(data, "MyOpponentHistory.json")
atomic_write_json(target, data)
```

```javascript
// Node
const sv = require('./lib/schema_versioning');
sv.stampVersion(data, 'meta_database.json');
atomicFs.atomicWriteJson(target, data);
```

The four tracked write paths
(`BlackBookStore.save`, `AnalyzerStore.save`, `analyzer.js
persistMetaDb`, the PowerShell `Save-History`) call `stamp_version`
before invoking the canonical helper. Reads strip the version
(via `core.data_store._strip_schema_meta` /
`schema_versioning.assertNotTooNew + delete`) so callers never see
a stray integer in `data.values()`.

### Migration registry

Each migration registers a `Migration(basename, from_version,
to_version, forward, backward, description)` tuple at module
import time. Forward migrations run on read when the file is
older than the writer; backward migrations run when an explicit
target is passed (used for downgrade tests + the cross-version
parity test). Missing migrations raise `SchemaMigrationError`.

A newer-than-expected file raises `SchemaTooNewError`; the reader
refuses to load and surfaces the version mismatch so a downgraded
backend doesn't silently drop fields. The error message tells the
user to either run a build matching the file's version or restore
from a backup.

### CI gate (Stage 7)

A PR that bumps `current_version` for any basename MUST include
**both** `forward` and `backward` migrations and a unit test
exercising both directions on a real-shape fixture sample. The CI
gate added in Stage 7 enforces the pair:

```
$ python -m core.migrations._lint
[lint] checking MyOpponentHistory.json: v1 expected, v1 found in registry
[lint] forward + backward present for every (from_v, to_v) tuple
```

A bump that ships only a forward migration is rejected at PR time.

---

## Consequences

### Positive

* Future field additions / renames are first-class operations
  rather than the "try-and-pray" pattern that produced the 2026-04
  truncations.
* Cross-language coordination is enforced by the registry living
  in two languages but pinning the same integer for each file --
  divergence is caught by the cross-language consistency test.
* Downgrade paths exist for every bump, so a user who installs a
  newer build then rolls back doesn't lose data.
* The `_schema_version` stamp is written immediately before the
  Stage 4 validate-before-rename gate, so a malformed dict still
  fails the gate -- versioning never weakens the existing
  durability guarantees.

### Neutral

* Five tracked files exist today. Four of them ship at v1 with
  no live migrations. The infrastructure cost is paid up front
  so the next bump is one PR instead of a fire drill.

### Negative

* The migration registry adds two functions per bump (forward +
  backward) plus a unit test. Without the CI gate, that cost can
  be skipped -- which is why Stage 7 ships before any actual
  schema bump.
* A `_schema_version` mismatch (a downgrade past the user's data)
  surfaces as a refused load, not a graceful fallback. We accept
  this trade-off: silently dropping fields is the wipe pattern
  Stage 4 was designed to prevent.

---

## Alternatives considered

### Sidecar `<file>.schema_version` files

Pros: zero impact on existing readers; no key-pollution worry.
Cons: a sidecar can drift out of sync with the data file under
crash + partial-rename, defeating the entire purpose. Rejected
in favour of an embedded key inside the same atomic write.

### Auto-stamp at the canonical helper

Pros: writers don't need to remember to call `stamp_version`.
Cons: the stamp leaks into iterators that walk `data.values()`,
breaking the `meta_database.json` "every value is a build" contract.
Tried; reverted; the explicit-stamp pattern lives at each writer.

### One global `version_key` for every file

Pros: simpler registry.
Cons: would force a v3 -> v4 bump on `custom_builds.json` purely
to rename the key, with no behaviour change. Rejected; the
registry tolerates per-file version_key.

---

## References

* `core/schema_versioning.py` -- the registry, migration helpers,
  and SchemaTooNewError.
* `stream-overlay-backend/lib/schema_versioning.js` -- the JS mirror.
* `core/migrations/__init__.py` -- registration template.
* `core/data_store._stamp_for_save` and `_strip_schema_meta` --
  the explicit stamping wrapper used by every Python writer.
* `tests/core/test_schema_versioning.py` -- pin tests.
* `stream-overlay-backend/__tests__/schema_versioning.test.js`
  -- pin tests on the JS side.
