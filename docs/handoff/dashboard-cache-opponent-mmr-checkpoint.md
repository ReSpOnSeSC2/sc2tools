# Dashboard cache: opponent-MMR histogram and drill-down (October 30 UTC)

The program remains active and incomplete. Faster-dashboards slice C5 admits
two charts to the default-off private chart cache:

- `/v1/opp-mmr-buckets`, the win rate by opponent MMR;
- `/v1/opp-mmr-buckets/games`, the games behind one bar.

Source coverage grows from twenty-one to twenty-three response kinds. API paths
are relative to `apps/api/src/`.

Both charts read the owner's own `opponents` rows as their MMR fallback, and
both computed a trust floor from the current time. Admitting them needed three
changes:

- every in-process writer of the `opponents` collection now runs inside the
  owner's `UserRevision` fence, snapshot restore's and account erasure's
  collection loops included;
- with the cache on, the trust floor is truncated to the UTC day and keys the
  body;
- ADR 0072's admission checklist admits both exceptions explicitly.

`USER_CACHE_ENABLED` stays off. With the flag off, both routes pass exactly
their original options and answer byte-identically. No provider setting, flag,
migration or infrastructure change is included. C5 is stacked on G1
([PR #834](https://github.com/ReSpOnSeSC2/sc2tools/pull/834)) and merges after
it.

## What changed

- **Writers.** Thirteen direct sites now run inside
  `gameWrite(this.userRevision, userId, ...)`, each wrapped on the call's own
  lines, so no line moves:
  - nine in `services/opponents.js`: recording a game, refreshing metadata, four
    resumed-replay counter repairs, the pulse character and revealed-name
    backfills, and the manual pulse retry;
  - four in `services/gdpr.js`: the rebuild's delete and insert, and the recount's
    delete and upsert.

  Snapshot restore and account erasure write whole per-user collections through
  dynamic handles in their collection-list loops. Both loops now pass the shared
  `chartInputFence` (`services/gdpr.js:1599-1602`), which selects the owner's
  fence for games and opponents, so restore's delete and insert and erasure's
  delete of `opponents` are fenced too (`services/userBackups.js:273`;
  `services/gdpr.js:452`). Both edits change the call's own line, and the helper
  follows every cited line.

  The heal migration `db/migrations/2026-05-12-heal-opponent-current-name.js`
  is the only other writer. It stays an out-of-band writer under ADR 0072.
  `WRITER_SET_VERSION` moves to `2026-10-30.2`
  (`middleware/userCacheGuard.js:13-15`).
- **Trust floor.** `oppMmrTrustDayFloor` takes the same 365-day horizon back
  from the start of the UTC day. The service computes with a keyed floor when
  it gets one and otherwise keeps the continuous floor
  (`services/trendsOppMmr.js:87-108,166,489`). The routes add the keyed floor to
  their options only while the cache is enabled
  (`routes/aggregations.js:248,265,528-532`).
- **Admission.** `ALLOWED_ROUTES` adds both kinds (`middleware/userCache.js:9`).
  Both routes answer through `send` with exactly the options the service
  receives. The web capability list appends both paths at positions 21 and 22
  (`apps/web/lib/conditionalApiScope.tsx:9`).
- **ADR 0072** (its update rule asks for this in the same pull request):
  - item 1 admits the owner-scoped `opponents` lookup;
  - item 4 admits a clock value that reaches the computation only through the
    key;
  - the coverage count, the G1 writer evidence and the out-of-band migration
    list are updated.

## Admission checklist

1. **Owner data only.** Every games read uses `gamesMatchStage(userId, filters)`.
   The one other read is a `$lookup` on the owner's `opponents` rows by `userId`
   and `pulseId` equality (`services/trendsOppMmr.js:261-284`), which the
   amended item 1 admits.
2. **Fenced writers.** The games fields both charts read are already read by
   covered kinds, and the games writers are fenced. The fields read from
   `opponents` rows are `mmr`, `race` and the row's existence. Every in-process
   writer of the collection is fenced, the restore and erasure loops included,
   and exact inventory tests enforce it
   (`apps/api/__tests__/opponentsWriterFence.test.js:21-25,53-79`).
3. **No completed memo.** Both run only through TrendsRequests joins
   (`services/aggregations.js:739,741`).
4. **Clock.** The trust floor reaches the computation only through the key on
   the cache path, which the amended item 4 admits. The flag-off path keeps its
   original read.
5. **No route-level read** of another collection.
6. **No global input.**
7. **Complete key.** Filters, the width or band edges, and the keyed floor are
   all parsed before admission.
8. **Size.** The histogram is structurally bounded at 80 bars
   (`OPP_MMR_MAX_BUCKETS`), a few kilobytes. The drill-down is capped at 2000
   rows (`OPP_MMR_BAND_GAMES_MAX`), roughly 300 bytes each. A full band can pass
   the 512 KiB entry cap and then goes out as an uncached 200.
9. **Callers.** The route is the only caller of the app-level methods. Admin
   global trends calls both on a service it builds per call, which has its own
   TrendsRequests (`services/adminGlobalTrends.js:113,125,174-177`;
   `services/aggregations.js:44`), so it is not a first-observation source. On
   the web, the histogram chart and the drill-down modal read the two paths;
   admin global mode rewrites them to the admin route.
10. **Wiring.** Both routes use `send(kind)`, both kinds are allowlisted, the off
    path passes no floor, and the web list appends without moving a position.
11. **Fleet note.** No process-local state is added. The key has the standard
    parts plus the options, so both kinds inherit G1-G6 and the
    first-observation rule unchanged.

## Tests

- `apps/api/__tests__/opponentsWriterFence.test.js` (new):
  - the exact direct-writer inventory, and the migration plus the one read-only
    collection alias (`apps/api/__tests__/opponentsWriterFence.test.js:21-35`);
  - every loop over `USER_SCOPED_COLLECTIONS` or `RESTORABLE` that writes must
    pass the chart-input fence, which fences games and opponents; the lists'
    uses and the other dynamic collection handles are counted, and those
    handles' key lists never name `opponents` (`:53-79`).
- `apps/api/__tests__/oppMmrTrustFloor.test.js` (new). It shows:
  - the day floor's boundaries, with the continuous floor unchanged;
  - a keyed floor drives the histogram, its width probe and the drill-down;
  - an invalid floor falls back;
  - both routes key the cached body by the day's floor, a request after UTC
    midnight misses;
  - with the cache off the routes pass exactly their original options, compared
    strictly so an undefined member fails
    (`apps/api/__tests__/oppMmrTrustFloor.test.js:60-81`).
- `apps/api/__tests__/userCacheOppMmr.mongo.test.js` (new) runs on real Mongo
  with the full app:
  - for both paths, bodies are retained; recording a game, recounting and
    rebuilding each retire them; another owner's write does not
    (`apps/api/__tests__/userCacheOppMmr.mongo.test.js:60-79`);
  - snapshot restore and account erasure each write the owner's `opponents`
    rows inside the owner's fence and bump `dataRev` before the next collection
    (`:84-103`).
- Updated:
  - the routes suite now covers the pair as allowlisted kinds;
  - the vetoed pulse heal now expects exactly one revision run, from its fenced
    opponents write;
  - the web capability tests expect positions 21 and 22, with `/v1/games-list`
    as the uncovered control.

## Review

One independent, read-only review found no high-severity defect. Its findings
are fixed:

- **Medium.** Snapshot restore and account erasure wrote `opponents` through
  dynamic handles outside the owner's fence, which the inventory test could not
  see. Both are fenced through `chartInputFence`; the inventory test and the
  real-Mongo case above cover them.
- **Low.** The docs said every writer was already fenced, and two citations
  were off; the claims and citations above are corrected.
- **Low.** The flag-off options check used `toEqual`, which ignores undefined
  members; it is strict now.

Exact-head CI on the fixed branch then failed one suite outside the local set:
`apps/api/__tests__/deviceCredentialWriterInventory.test.js` counted only
`mutate` and `communityMutation` as wrappers that hand back their work's
promise, so erasure's device-token delete inside `gameWrite` looked unsettled.
`gameWrite` returns that promise too (`util/userRevision.js:163`), so it joins
the list. The change is test-only, and the suite passes locally.

## Verification

Local checks ran at `c7b5ef93`, C5 with G1's review fixes merged in and its own
review fixes applied. The receipt is
`docs/handoff/validation/dashboard-cache-opponent-mmr/local-verification.json`,
which supersedes the first one.

- **API.** Whole-API types pass. Configured lint reports 758 warnings and 0
  errors, the same as C4. The changed files add no configured or strict
  message; the router's length falls from 349 to 348 lines, and `restore`'s
  complexity from 19 to 18. The new suites pass strict lint.
- **Suites.** Seventy-three API suites pass 1025 of 1025 cases in band,
  on cached MongoDB 7.0.14 with downloads disabled. They are G1's thirty-six,
  every suite that names a C5 writer or route, and the backup, restore and
  erasure suites. No MongoDB process was left over.
- **Web.** Types and the changed files' lint pass; eight test files pass
  109 of 109 cases.
- **Mutation.** 14 of 14 deliberate regressions are killed, among them
  restore and erasure leaving `opponents` unfenced, the shared fence dropping
  it, and an undefined floor on the flag-off path.

## Limitations

- With the flag on, the trust floor moves once per UTC day. A game within one
  day of the 365-day horizon can count as trusted until the next UTC midnight,
  while the flag-off path keeps the continuous floor.
- With the flag on, each opponents write adds one `dataRev` bump, so a backfill
  bumps once per row it changes, and a restore or an erasure bumps once more.
  With the flag off, `gameWrite` adds no database command.
- Drill-down bodies over 512 KiB are not retained.
- Single-process tests: no fleet, activation, latency or savings claim. G1-G3
  stay unmet.

## Remaining dashboard work

R1, the activation review, remains, and it needs the owner. ADR 0072's device-auth
gates (repair, election, clock, cohort qualification and the activation CAS)
and the chart cache's G1-G3 stay unmet.
