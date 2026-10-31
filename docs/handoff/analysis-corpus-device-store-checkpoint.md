# Analysis corpus: history kept on this device (AC3, October 31 UTC)

The program remains active and incomplete. This is slice AC3 of roadmap item
`analysis-corpus-local-cache` (ledger ordinal 75). It meets the item's third
remaining requirement in source: "Implement bounded IndexedDB account/version
storage, atomic watermark/delta merge and snapshot fallback." AC3 is stacked on
AC2 ([PR #841](https://github.com/ReSpOnSeSC2/sc2tools/pull/841)), whose
changed-since route it reads, and merges after it. It also adds a corpus epoch to
the snapshot and changes routes. API paths are relative to `apps/api/src/`; web
paths are written in full.

It is dormant in production. A device copy is created only for an account that
asked to keep its history on this device, and nothing in the UI asks yet: AC5
adds that one-time gate. Every other account loads exactly as before. No flag,
provider setting or infrastructure changes. The item stays partial.

## The device copy

`apps/web/lib/analysisCorpus/deviceStore.ts` keeps the copy in an IndexedDB database of
its own, `sc2tools-analysis-corpus`, apart from Instant Analysis:
- **Accounts.** One record per account, holding its choice to keep history
  here. It has the stored corpus's marks (corpus version, epoch and watermark)
  and its row count, or no marks when the choice stands with nothing usable.
- **Games.** One strict analysis row per game, keyed by account and game id.
- **Bounds.** One account at a time and at most 20,000 rows. A snapshot clears
  both stores and writes its rows and record in one transaction, so another
  account's history never stays beside it
  (`apps/web/lib/analysisCorpus/deviceStore.ts:144-161`).
- **Merge.** A delta applies its writes and removals in order and moves the
  marks in one transaction, only while the stored marks still equal the ones it
  started from. Past the row limit it rolls back
  (`apps/web/lib/analysisCorpus/deviceStore.ts:202-242`).
- **Reset.** Dropping a copy keeps the account's choice. Deleting the whole
  database is the last resort (`apps/web/lib/analysisCorpus/deviceStore.ts:170-193`).
- **Reads.** Every stored value is checked against the account. A copy that
  does not check out reads as unreadable, and the caller takes a snapshot
  (`apps/web/lib/analysisCorpus/deviceStore.ts:118-136,259-288`).
- **Opening.** A probe never creates the database: aborting the first upgrade
  leaves nothing behind, which Chromium 152 confirmed. It reports a database
  that was never there separately from one that is refused or slow. An open
  slower than 3 s gives up and closes a connection that arrives late
  (`apps/web/lib/analysisCorpus/deviceStore.ts:25,50-109`).

`apps/web/lib/analysisCorpus/deviceNote.ts` keeps a `localStorage` note naming the
account whose history this browser keeps
(`apps/web/lib/analysisCorpus/deviceNote.ts:14-37`). The provider reads it at once,
without loading the device store or touching IndexedDB. It is only a hint, and
IndexedDB stays the source of truth:
- a note that names a missing copy costs one probe, after which the note is
  forgotten;
- an unreadable note means the provider probes;
- a copy whose note cannot be written (storage full) is not kept, so it is never
  orphaned.

## Syncing

`apps/web/lib/analysisCorpus/changes.ts` reads every changes page after a set of marks
and merges the changes newest first; the latest change to a game wins
(`apps/web/lib/analysisCorpus/changes.ts:84-125`). A snapshot is needed instead when:
- the server asks for one;
- the server predates the route and answers 404;
- the corpus version or epoch moves between pages;
- a page is malformed;
- the delta runs longer than a snapshot would.

`apps/web/components/analyzer/arcade/hooks/analysisCorpusSync.ts` runs one sync for an
account that keeps a copy or asked to
(`apps/web/components/analyzer/arcade/hooks/analysisCorpusSync.ts:77-179`):
- **With a copy.** The stored rows show first, a changes read brings them up to
  date, and the merge is written back.
- **Before a snapshot.** A copy that only a snapshot can bring up to date is
  dropped first, so a failed snapshot cannot leave it in place.
- **Snapshot.** A fetched snapshot shows before its save finishes, and then
  replaces the copy. It is kept only when every page came from one epoch
  (`apps/web/components/analyzer/arcade/hooks/analysisCorpusSync.ts:107-113`). A copy
  the snapshot cannot replace (a failed save, no marks, mixed epochs, the
  ceiling) is dropped.
- **Failed reads.** A read that fails leaves the device alone unless this
  account asked to keep a copy.
- **Cancellation.** Once the run is cancelled, nothing more is written to the
  device.

## The corpus epoch

A stored row changes only when its change stamp moves. So the API derives an
epoch from the rules that decide what a row holds and which games belong: the
analysis projection, the membership filters, the serializer, the removal rule
and the snapshot read (`services/analysisCorpusChanges.js:29-36,123-128`).
- **Where it appears.** Every snapshot page carries it, not only the first
  (`routes/games.js:304`), as does every changes answer. A changes read from
  another epoch answers `snapshotRequired: "corpus_epoch"`
  (`services/analysisCorpusChanges.js:71-73,110-119`). So a snapshot that spans
  an epoch-changing deploy is never stored, and a copy from other rules is
  replaced rather than updated row by row.
- **When it moves.** A rule change moves the epoch with no one having to
  remember to bump it. A harmless edit to those functions costs each device one
  snapshot. `CORPUS_RULES_REVISION` covers what the digest cannot see, such as
  the snapshot cursor's helpers.
- **Strictness.** `corpus_epoch` is required, like `corpus_version`
  (`services/analysisCorpusChanges.js:161-164`).

## The provider

- **Who touches the device.** An account that neither asked to keep a copy nor
  is noted as keeping one reads its snapshot at once, exactly as before: the
  first request starts in the same turn, with no download and no IndexedDB
  access. Only the other accounts load the sync and the device store, through a
  dynamic import kept out of the dashboard's first-load JavaScript; `/app` was at
  238.8 of its 240 kB budget
  (`apps/web/components/analyzer/arcade/hooks/useAnalysisGames.ts:311-312`).
- **Chunk failures.** The snapshot read is static, so a chunk that cannot load
  (a tab from before a deploy) still loads the corpus in memory
  (`apps/web/components/analyzer/arcade/hooks/useAnalysisGames.ts:156-202`).
- **Keeping a copy.** `keepOnDevice()` asks for a copy. Once the device records
  the choice, the request is cleared, so a tab does not recreate a copy that
  another tab cleared
  (`apps/web/components/analyzer/arcade/hooks/useAnalysisGames.ts:259,277,342`).
- **Retention.** An account switch still hides the old account's corpus at once.
  A cancelled run's late stored copy or snapshot never replaces the new
  account's corpus. The provider holds one flat array.

## Tests

- **Device store** (`apps/web/lib/analysisCorpus/__tests__/deviceStore.test.ts`):
  - the probe and absence, and the open deadline with its late close;
  - one account at a time, reset, delete, in-order merges, and both exact row
    limits;
  - two merges racing from the same marks, of which exactly one writes;
  - stale marks (including the epoch) and unreadable copies.
- **Changes** (`apps/web/lib/analysisCorpus/__tests__/changes.test.ts`): paging, every
  snapshot fallback, and order within one delta.
- **Sync** (`apps/web/components/analyzer/arcade/__tests__/analysisCorpusSync.test.ts`),
  21 cases including:
  - nothing created for an account that did not ask, and a note naming a missing
    database forgotten;
  - stored copies newest first, the merge limits, the ceiling, no marks and
    mixed or missing page epochs;
  - a refused copy whose snapshot fails, a failed save, a failed drop, failed
    reads and an unwritable note;
  - each abort point, a snapshot shown while its save runs, and a copy another
    tab moved.
- **Provider**
  (`apps/web/components/analyzer/arcade/__tests__/useAnalysisGames.test.ts`):
  - keeping only on request;
  - the stored copy first, then a changes-only sync;
  - snapshot fallback and mixed page epochs;
  - a kept choice found again;
  - another account's copy never shown;
  - an account switch mid-sync, with no write after it;
  - a cancelled account's late stored copy or snapshot;
  - a missing IndexedDB, a chunk that cannot load, and a copy another tab
    cleared.
- **First request.** `apps/web/components/realtime/allConsumers.test.tsx` still sees the
  first corpus request in the same turn.
- **API** (`apps/api/__tests__/analysisCorpusChanges.mongo.test.js`,
  `apps/api/__tests__/gamesAnalysisCorpus.test.js` and
  `apps/api/__tests__/analysisCorpusEpoch.test.js`):
  - the epoch on every snapshot page and changes answer, and an epoch mismatch;
  - a missing or malformed epoch;
  - the epoch moving with the projection, the serializer, both membership
    predicates and the snapshot read, with its input list pinned.

## Review

Three independent read-only passes reviewed the slice.

**One reviewer (at `d4803497`)** found no high-severity issue, two medium and
three low:
- **Medium.** A copy that a fallback snapshot could not replace was kept, and
  shown first on every load.
- **Medium (latent).** Nothing invalidated device copies when the API changes
  what a row holds or which games belong.
- **Low.** A failed read could let an account that never opted in replace
  another account's copy. Opening IndexedDB had no deadline. Several tests did
  not prove their claims.

The fixes are the drop rules, the corpus epoch, read-error isolation, the 3 s
deadline and new tests.

**A workflow of four lenses (protocol, store, provider, tests) and a critic (at
`08429854`)** confirmed those fixes. All four lenses found one medium gap: only
the first snapshot page carried the epoch, so a snapshot spanning an
epoch-changing deploy could keep old rows under the new epoch. It also found six
low items:
- a refused copy surviving a failed snapshot;
- memory-only accounts now waiting on a download and a probe, which
  `allConsumers` caught;
- a fatal chunk failure;
- writes after cancellation;
- an epoch test that did not tie the constant to its inputs;
- surviving mutants.

`53eabe5f` fixed them all; the device note dates from there.

**A second workflow of three lenses and a critic (at `53eabe5f`)** confirmed
those fixes and found only low items:
- a note never forgotten when the database itself is gone;
- a failed save's drop running after cancellation;
- an unwritable note orphaning a copy;
- untested guards, including the per-page epoch at the provider and a
  chunk-failure test that never reached the import.

`208598af` fixed them all.

## Verification

Local checks ran at `208598af`, on AC2's head `37ea2ce4`. The receipt is
`docs/handoff/validation/analysis-corpus-device-store/local-verification.json`.

- **API.**
  - Whole-API types pass.
  - Configured lint reports 765 warnings and 0 errors. The changed
    files add no configured or strict message, and the new suite passes strict
    lint.
  - 145 suites pass 2,213 of 2,213 cases in band, on
    cached MongoDB 7.0.14 with downloads disabled. They are every suite that
    loads the changes module or names a stamped writer, the restore or wipe
    path, a background index or the corpus routes, plus the epoch suite.
- **Web.**
  - Whole-web types pass.
  - Configured lint reports 190 warnings and 0 errors. The changed
    files add no message, and the new files have none.
  - The UI lint passes.
  - All 1,042 web test files pass with one isolated worker at a time: 10,191
    cases, with 1 skipped by the suites themselves.
  - A single-process run (vitest's `singleFork`, which shares globals across
    files) is not representative. In it, 77 unrelated files failed and one file
    stalled, while a sample of 8 of them passes in isolated runs.
- **Mutation.** 51 of 51 deliberate regressions are killed, 43 in the web
  suites and 8 in the API suites.
- **Bundle.** Local production builds use the public flags CI sets.
  - `/app` is 240.5 kB of first-load JavaScript (gzip), against
    240.0 kB for the same local build of AC3's base: 0.5 kB more.
  - `/settings` and `/try` are 0.1 kB more, and every other route is unchanged.
  - Local builds run larger than CI's: main's `/app` is 238.8 kB in CI, and at
    the base `/community` and `/guides` exceed their budgets locally.
  - So CI is projected near 239.3 of `/app`'s 240 kB, and its own build remains
    the gate. AC4 and AC5 will need to load their additions on demand.
- **Browser.** In Chromium 152, aborting the first upgrade left no database.

## Limitations

- Dormant until AC5's gate calls `keepOnDevice`; nothing in production creates a
  copy before then.
- Until AC4, a copy stays on disk after sign-out, an account switch or Delete
  history. It is never shown to another account, and the version check replaces
  it after a wipe.
- A stored copy can show briefly before a sync replaces it. This happens when
  another device wiped or restored history, or when the rules changed.
- Device rows are ordered by date with ties by game id; snapshots use the
  database's order. The consumers re-sort where order matters.
- Device reads and writes have no deadline once the database is open.
- The no-create probe was checked in Chromium only.
- No latency, request-reduction or savings claim.

## Remaining for the item

- **AC4, web:** clearing on sign-out, account switch and Delete history, and
  retiring stale owner and version work.
- **AC5, web:** the one-time history gate, the count and refresh footer, Backups
  & data local bytes and Clear controls, and Help.
