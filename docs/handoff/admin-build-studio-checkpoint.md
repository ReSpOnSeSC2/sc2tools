# Admin Build Studio checkpoint

This implements the user's requested editable catalog for all released presets,
private custom definitions and community snapshots. It is separate from planned
admin-polish-5/6/7 and admin-polish-8/9/10; those packs are not claimed here.

The shared active policy is schema/evaluator1, canonical SHA-256, bounded data
only, and validated independently by Python/Node. Personal Protoss PvX presets
and generic opponent Protoss presets have explicit separate detection surfaces;
Terran/Zerg retain their shared trees. Custom winners have precedence. A replaced
released label cannot bypass its replacement. Unedited trees keep their released
precedence. Both Archon Drop released predicates consume centralized criteria,
including observed real Warp Prism completion <=360 seconds.

Global SITE_CONFIG stores the active CAS-protected manifest and immutable
revisions in one Mongo transaction. Actor attribution stays in erasure-aware
admin audit. Shared public manifests contain no private build/owner/replay data.
Private/community edits hold the target owner's existing shared write lease,
check definition/publication versions and retain ten safe historical snapshots.
They cannot remove an erasure/restore lock or silently republish removed content.
Invalid oversized legacy projections are explicitly marked and cannot overwrite
their original full documents.

Native healthy-heartbeat refresh and browser pre-analysis refresh retain a
validated durable last-good manifest, with bundled released fallback. Unsupported
versions/labels/hash changes fail validation rather than executing data. The raw
parser sends bounded allowlisted evidence with explicit per-axis custom winner,
released baseline, completeness and recorded clocks. Ingest can recompute stale
compatible evidence without guessing from lossy display logs. Raw evidence is
transient and excluded from the slim game document. Existing check-in selections
remain displayed while detector results update separately. Older clients and
incomplete evidence retain their uploaded labels; update and reanalyse to adopt
current policy. Existing history is not silently backfilled by an admin save.

Admin Content → Build Studio provides source/owner labels, stable keyset pages,
criteria and authored reference step editing, raw-event preview, before/after
review, CAS conflict draft retention, historical definition review, and complete
policy-history inspection/restore as a new immutable version. Reference steps are
not detection criteria. Procedural defaults do not fabricate steps from stubs.
Mobile and desktop use the shared focus-trapped editor sheet/panel.

Validation checkpoint before final main integration:

- Complete native suite:2158 passed,1 expected non-Windows skip,78 subtests using
  the pinned project venv. A system-Python run lacked s2clientprotocol; the pinned
  environment resolved this without changing or weakening its runtime test.
- Complete engine suite:1054 passed,4 skipped before the final surface fixtures;
  updated targeted policy/Archon/catalog suite147 passed. Final full run pending.
- Actual built Pyodide:10 tests passed, including fresh CPython replay envelopes
  identical, both Archon Drop anti-false-positive matrices, and policy install,
  canonical hashes, recorded clocks, real-unit rules and detector surfaces.
- API50 real Mongo/HTTP tests passed before an added legacy projection guard;
  the updated suite and final affected existing classifier checks are pending.
- Web22 tests passed across editor/catalog/history/worker/cache before the final
  visible-sheet and refresh-order regressions; final suite/types/lint pending.
- API full types and strict new source/test lint passed before final docs/guard.

Final production budgets, phone/desktop screenshots and exact-head integration
checks will be recorded before the draft is frozen. No production policy edits,
user messages, database changes, restores, deletes or migrations were executed.
