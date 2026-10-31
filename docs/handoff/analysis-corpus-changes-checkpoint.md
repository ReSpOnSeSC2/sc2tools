# Analysis corpus: changed-since reads (AC2, October 31 UTC)

The program remains active and incomplete. This is slice AC2 of roadmap item
`analysis-corpus-local-cache` (ledger ordinal 75). It meets the item's second
remaining requirement in source: "Define/implement changed_since, cursor,
removed tombstones/exclusions and corpusVersion; dataRev is explicitly not a
durable change feed." AC2 is stacked on AC1
([PR #840](https://github.com/ReSpOnSeSC2/sc2tools/pull/840)), whose change stamp
it reads, and merges after it. API paths are relative to `apps/api/src/`.

No web client uses the new route yet; AC3 adds the device store. No flag,
provider setting or infrastructure changes. The item stays partial.

## The protocol

1. **Snapshot.** The first page of `GET /v1/games/analysis-corpus` now also
   carries `corpusVersion` and `watermark`. Both are read before the page itself,
   so the watermark never passes a row the snapshot missed
   (`routes/games.js:300-306`; `services/analysisCorpusChanges.js:58-60`). Later
   pages answer as before.
2. **Delta.** `GET /v1/games/analysis-corpus/changes?since=<watermark>&corpus_version=<n>`
   returns the owner's games stamped after `since`, oldest stamp first. Pages
   follow an opaque `(updatedAt, _id)` cursor
   (`services/analysisCorpusChanges.js:71-92`; `routes/games.js:307-308`), and the
   `_id` tiebreak keeps rows that one bulk write stamped alike in order. The
   query is validated before it takes the single corpus lane, and a `since` more
   than 60 s ahead of this server is refused
   (`services/analysisCorpusChanges.js:64-67,110-116`).
3. **Items.** A corpus row comes back exactly as a snapshot item. A row that left
   the corpus comes back as `{gameId, removed: true}`. That covers tombstoned,
   pending-deletion, hidden and resumed-replay-quarantined rows
   (`services/analysisCorpusChanges.js:96-101`).
4. **Watermark.** The final page returns
   `watermark = max(since, first page time - 5 min)`
   (`services/analysisCorpusChanges.js:15,89`). Stamps use the issuing process's
   clock when the write starts, and an owner transaction commits well inside five
   minutes, so a row stamped before the watermark has already committed. Rows near
   the watermark can come back twice; applying an item twice is harmless.
5. **Snapshot required.** The delta answers `{snapshotRequired, corpusVersion}`
   with no items in two cases:
   - the client's `corpus_version` differs (`"corpus_version"`);
   - `since` is older than the stamp floor (`"before_stamps"`, with `deltasFrom`).

## Hard deletes and the corpus version

A hard delete leaves no row to report. Three operations do one:
- a history wipe (`services/gdpr.js:927-929`);
- a restore's first step (`services/userBackups.js:274`);
- account erasure's games delete (`services/gdpr.js:444-452`), which covers an
  erasure that fails after it.

Each runs inside `withCorpusRemoval`, which increments the owner's
`users.corpusVersion` before and after the work, and again when the work throws
partway (`util/corpusUpdatedAt.js:50-57`). A snapshot taken while the delete ran is
refused afterwards. A successful erasure removes the owner, so there is nothing
left to sync. `dataRev` is not used.

`gdpr.js` and `userBackups.js` keep their line counts: the import replaces a blank
line, and each wrapper sits on the call's own lines.

## The stamp floor

A process from before AC1 writes unstamped rows during a rolling deploy, for at
most 300 s after the new process listens (ADR 0072, G1). So:
- **Creation.** When the service is built at boot, it creates a durable
  `siteConfig` floor 7 minutes ahead if none exists. Concurrent boots agree,
  because the upsert matches on `_id` (`services/analysisCorpusChanges.js:18-19,27-53`).
- **Caching.** The floor never moves, so each process caches it, and a failed read
  is retried by the next request.
- **Older watermarks.** A watermark before the floor needs a snapshot. The answer's
  `deltasFrom = floor + 5 min` says when a snapshot's watermark reaches past the
  floor, so a client need not loop on snapshots before then
  (`services/analysisCorpusChanges.js:77`).

The floor is created at this slice's first deploy, so it is long past when AC3's
client first asks for changes.

## Shared page handling

Both routes run through one admitted, abort-aware page handler. It validates the
query first and then holds the single corpus memory permit until the response is
written (`routes/games.js:99-153`), so a delta never retains a second page beside a
snapshot. Moving the snapshot handler out of `buildGamesRouter` shortens it from
668 to 633 lines. The page limit and its ceiling are the snapshot's.

## Tests

`apps/api/__tests__/analysisCorpusChanges.mongo.test.js` (new) runs on real Mongo
through the full app:
- The first snapshot page carries the version and watermark, and later pages do
  not. A delta returns stamped rows identical to snapshot items, with a watermark
  trailing by the overlap (`apps/api/__tests__/analysisCorpusChanges.mongo.test.js:46-63`).
- Rows that one bulk write stamped alike all page through (`:65-77`).
- Hidden, deleted and quarantined rows come back as removals, and pages follow a
  cursor to a watermark (`:79-96`).
- A wipe and a restore bump the version, so an older client must take a snapshot
  (`:98-107`).
- Two booting processes agree on one floor, and an older watermark is told when
  deltas start (`:109-118`).
- A wipe that fails partway, and an erasure that fails after its games delete,
  still bump the version twice (`:120-130`).
- A write that commits just after a pass, stamped before the pass ended, comes
  back from the returned watermark (`:132-138`).
- Another owner's rows never appear. Malformed input is refused, including a
  `since` in the future (`:140-149`).

A route test with a mocked page load shows that a delta waits for a snapshot
page's corpus permit, and that a malformed changes query is refused while the
lane is still held (`apps/api/__tests__/gamesAnalysisCorpus.test.js:459-506`).
The device-credential writer inventory now also counts `withCorpusRemoval` among
the wrappers that hand back their work's promise.

## Review

One independent, read-only review found no high-severity issue. Its findings are
fixed or recorded here:
- **Medium.** The second bump was skipped when the delete threw partway. It now
  runs on that path too.
- **Medium.** The floor was created by the first delta request, so for about 12
  minutes after AC3's launch every delta would have needed a snapshot that could
  not yet succeed. The floor is now created at boot and cached, and the answer
  carries `deltasFrom`.
- **Low-medium.** Account erasure's games delete did not bump. It does now.
- **Low.**
  - Validation ran after admission. It now runs first.
  - A `since` in the future froze the watermark. It is now refused.
  - A rollback below AC1, and the deploy-overlap behaviour, are recorded under
    Limitations.

The review's test gaps are closed: a wipe and an erasure that fail partway, a
late commit, concurrent floors, a future `since`, and the delta route's shared
lane. An owner-bound version token was not added, because re-provisioning after
an erasure creates a new random owner id (`services/users.js:74`).

## Verification

Local checks ran at `8be5c842`, on AC1's head `e8e7cfdc`. The receipt is
`docs/handoff/validation/analysis-corpus-changes/local-verification.json`.

- **API.** Whole-API types pass. Configured lint reports 765 warnings and 0
  errors. The changed files add no configured or strict message, and the new
  files pass strict lint. `buildGamesRouter` shrinks, and the moved handler's
  complexity falls from 16 to 15.
- **Suites.** Ninety-nine API suites pass 1623 of 1623 cases in band, on
  cached MongoDB 7.0.14 with downloads disabled. They are every suite that names
  a stamped writer, the restore or wipe path, a background index or the corpus
  routes. No MongoDB process was left over.
- **Mutation.** 15 of 15 deliberate regressions are killed:
  - departed rows served, and quarantine not removed;
  - a wipe, restore or erasure that keeps the version, a single bump, and no bump
    on failure;
  - the version check and the floor check skipped;
  - a cursor without the `_id` tiebreak;
  - a watermark without the overlap;
  - snapshot marks on every page;
  - a future `since` accepted;
  - a delta given its own lane, and validation moved after admission.

## Limitations

- The overlap re-sends up to five minutes of rows on the next delta.
- A process crash between a hard delete and its second bump, with a snapshot
  taken between the first bump and the delete, could leave that device stale
  until its next snapshot. An exception in the delete no longer can.
- During a rolling deploy, a process from before this slice answers 404 on
  `/changes` and sends first snapshot pages without the marks; AC3 must treat
  both as "snapshot only".
- A rollback below AC1 lets unstamped rows land after the floor. Before rolling
  forward again, raise the floor document to the redeploy time plus 7 minutes.
- Out-of-band migrations neither stamp nor bump; a re-run needs a version bump by
  hand.
- No web client, latency, request-reduction or savings claim.

## Remaining for the item

- **AC3, web:** bounded IndexedDB account and version storage, an atomic
  watermark and delta merge, and snapshot fallback.
- **AC4, web:** clearing on sign-out, account switch and Delete history.
- **AC5, web:** the one-time history gate, the count and refresh footer, Backups
  & data local bytes and Clear controls, and Help.
