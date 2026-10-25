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

Final integration is based on current main96a55ecd, including Dashboard701 and
subsequent owner Companion changes. Both Heartbeat paths retain policy state_dir
alongside the new dashboard/history callbacks. Ghost examples and Build Studio
both remain in Content navigation and API services.

Private definition/version writes and linked check-in renames are one Mongo
transaction; notifications occur only after commit. A cross-process interleaving
regression proves a losing stale admin rename cannot partially change games.
Standalone development owner saves may fall back only when the first
transactional read is rejected before any write. Versioned custom and preset
admin saves/restores return503 without modifying definitions/history when
transactions are unavailable. A late transaction error never triggers fallback.
Community history/restores include listing text and the independent definition.

Validation on the integrated source:

- Complete engine suite:1066 passed,4 skipped. Catalog fingerprint check passes.
- Actual built Pyodide:10 tests passed against fresh CPython replay goldens,
  both Archon Drop matrices, policy install/canonical hashes/recorded clocks,
  real-unit rules and detector surface isolation.
- Affected API:19 real Mongo/API suites,297 passed. After final listing-restore
  and transaction503 edits,55 Studio/policy tests passed again. Full API types
  and strict new source/test lint pass. Local Mongo tests require unsandboxed
  process/loopback access; the sandbox startup timeout was infrastructure only.
- Web:32 tests across seven Studio/admin navigation/worker/cache suites; full
  types and changed source strict lint pass. Delayed-cache regression proves
  successful saves reset the draft before cache acknowledgement.
- Reproducible browser fixture: `node apps/web/tests/manual/build-studio.cjs`.
  Both390/1440 touch/keyboard flows pass with production CSS: actual released
  Prism6:00→5:30 criteria, review-before-write, failed-save draft retention,
  discard guard, success focus restoration, private/removed-community details,
  zero horizontal overflow, JS errors or external requests. Screenshots were
  visually inspected and are in docs/screenshots/admin-build-studio-{390,1440}.png.
- Current integrated full native suite and production build/budgets are running;
  final outcomes will be recorded before readiness/merge. Earlier native2158/1
  skip evidence is superseded by this pending current-main run.

No production policy edits, account publication, user messages, database changes,
restores, deletes or migrations were executed. No version/tag/sign/release work.
