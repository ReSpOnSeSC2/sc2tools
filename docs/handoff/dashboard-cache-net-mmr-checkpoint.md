# Dashboard cache: net MMR pair (October 30 UTC)

The program remains active and incomplete. Faster-dashboards slice C2 adds the
two net-MMR responses to the default-off private chart cache: net MMR by matchup
(`/v1/mmr-by-matchup`) and its opponent drill-down
(`/v1/mmr-by-matchup/opponents`). Source coverage grows from seventeen to
nineteen response kinds. Each item of the
[ADR 0072 checklist](../adr/0072-serving-cohort-coherence.md#source-coverage-admission-checklist)
is applied below with file:line evidence at this branch's head. API paths are
relative to `apps/api/src/`.

These are the first kinds that read hidden, pending-deletion and tombstoned
rows, which `gamesMatchStage` excludes; the macro report's pre-pass already
reads out-of-filter scored rows (`services/macroReport.js:107-122`). So this
slice amends checklist items 1 and 2, records the macro pre-pass under the new
wording, and names coaching's net-MMR call as a first-observation source in
ADR 0072 (the update rule asks for both in the same pull request). C2 is stacked
on DA2 ([PR #826](https://github.com/ReSpOnSeSC2/sc2tools/pull/826)), C1
([PR #825](https://github.com/ReSpOnSeSC2/sc2tools/pull/825)) and F1
([PR #824](https://github.com/ReSpOnSeSC2/sc2tools/pull/824)), and merges after
them.

`USER_CACHE_ENABLED` stays off. While it is off, both routes call their service
and `res.json` as before (`routes/aggregations.js:26-28`;
`middleware/userCache.js:109-111`). No provider setting, flag, activation,
migration, background job, infrastructure or agent release is included. No
latency, request reduction or savings is claimed.

## What changed

- `middleware/userCache.js:9` adds `netMmrByMatchup` and `netMmrByOpponent` to
  the allowlist as non-dependent kinds.
- `routes/aggregations.js:341-343` and `:367-378` answer both routes through
  `send(kind)` with exactly the options each service receives: `{ tz,
  groupByOwnRace }` for the matchup view, and the drill-down's race, search,
  minimum pairs, sort, order, limit and offset. Services, filters, pipelines and
  response shapes are unchanged, and every edit keeps line counts.
- `apps/web/lib/conditionalApiScope.tsx:9` appends both paths at capability
  positions 17 and 18. Positions 0-16 do not move.
- Tests:
  - the route suite covers both kinds for 200 and 304, off parity, owner and
    filter isolation and kind separation. Its option test checks that every
    route option gives its own key and that the object the cache keys on is the
    object the service receives;
  - the real-Mongo coverage suite runs the real net-MMR services, and every
    write in its fixture changes an accepted pair (the ingest, reupload and
    quarantine steps keep one; the unknown commit turns the last one into an
    outlier drop);
  - a new full-app real-Mongo test
    (`apps/api/__tests__/userCacheNetMmr.mongo.test.js`) drives seven fenced
    writes to rows or fields a net-MMR body reads (hiding the next game,
    reuploading the hidden game's MMR, unhiding, quarantining the next game, a
    later game outside an `until` filter, an opponent identity heal and a delete)
    and checks that each retires both retained bodies. Two of them, the hidden
    game's MMR reupload and the later game, change a body only through rows
    `gamesMatchStage` excludes; the heal changes a field only the drill-down
    reads; the others change displayed rows;
  - the web tests pin positions 17 and 18 and rebuild both paths from 304s.
- `CHANGELOG.md` gains a line under Dashboard cache coverage.

## Admission checklist

1. **Owner games only (amended).** Each kind runs one aggregate on `games`
   (`services/trendsNetMmr.js:430-432`; `services/trendsNetMmrOpponents.js:292`),
   with no `$lookup`, `$unionWith` or other collection. The pairing window starts
   with `{ userId, isResumedFromReplay: { $ne: true } }`
   (`services/trendsNetMmr.js:95`), so it is owner-scoped, and
   `gamesMatchStage(userId, filters)` applies after `$setWindowFields`, before
   any row is counted (`:90,150`). Rows the stage excludes (hidden,
   pending-deletion, tombstoned and out-of-filter rows) still shape counted rows,
   only through what the window reads on them: `userId` and
   `isResumedFromReplay` (membership), `myToonHandle`, `myLadderRace`, `myRace`,
   `isLadderGame` and `playerCount` (partition, `:100,117-128`;
   `services/trendsRegionExpr.js:93-95`), `date` and `gameId` (sort, `services/trendsNetMmr.js:133`), and
   `gameId`, `myMmr` and `myMmrSource` (the next reading `$shift` copies,
   `services/trendsNetMmr.js:134-143`). On quarantined rows the window reads only the membership fields,
   because its first match drops them. Tombstones are stripped rows
   (`services/gameControls.js:130`) that fall in a partition whose rows always
   drop as `excludedNonRanked1v1` (`services/trendsNetMmr.js:122-127,221-224`).
2. **Fenced writers (amended).** On displayed rows a covered kind already reads
   each field except `opponent.pulseId` and `opponent.pulseCharacterId` (for
   example MMR progression, `services/trendsInsights.js:96-123`, and the summary,
   `services/aggregations.js:69-104`). Two cases need their own writer evidence:
   the window's fields on rows `gamesMatchStage` excludes, and those two identity
   fields, which only the drill-down reads (`services/trendsNetMmrOpponents.js:143-147`).
   Every in-process writer of those fields or rows runs inside `gameWrite` with
   the app-level revision: ingest and reupload (`services/games.js:464-505`,
   which refuses tombstoned and pending rows at `:301-302`), resumed quarantine
   (`:594-639`), hide and unhide (`services/gameControls.js:85-87`), pending
   delete (`:121`), tombstone (`:130`), restore
   (`services/userBackups.js:273-284`), account erasure and the full or ranged
   history wipe (`services/gdpr.js:202,444-452,927-929`) and the opponent identity
   heal (`services/opponentGameStamps.js:145-155`). The new test drives seven of
   these writes end to end: two change a body only through excluded rows
   (`apps/api/__tests__/userCacheNetMmr.mongo.test.js:52,55`), and one changes
   the drill-down-only identity field (`:56`). Its delete step retires on the
   pending mark; no retained body can observe the tombstone replace, because the
   delete holds the mutation fence and snapshots refuse a fenced owner
   (`services/gameControls.js:101,138`; `util/userRevision.js:125`). So the
   tombstone's own fence rests on inspection, as does restore's, which
   `apps/api/__tests__/userRevisionDestructiveWriters.test.js:39-53` also covers.
   Unfenced in-process writes touch only fields neither kind reads, such as
   `_cleanupRequired` (`services/gameControls.js:136`). The out-of-band 8-pool
   rename changes display-filter fields only and stays a G1 gap
   (`db/migrations/2026-09-30-rename-8-pool-builds.js:50,115-119`). Manual edits
   and raw restores, such as the timebase migration's documented
   drop-and-`$out` rollback (`db/migrations/2026-05-17-rescale-timebase.js:97-101`),
   can rewrite any field or row and stay G1 gaps, as for every covered kind.
3. **No completed owner-data memo.** Both methods run through
   `TrendsRequests.run` (`services/aggregations.js:749,751`), an in-flight join
   the invalidator retires (`app.js:1004-1007,1011-1019`;
   `services/trendsRequests.js:31-36`). Neither calls `cached()` or runs the
   `dateRange` probe.
4. **No clock in the result.** None of `services/trendsNetMmr.js`,
   `services/trendsNetMmrOpponents.js` or `services/trendsRegionExpr.js` calls
   `Date.now`, an argument-less `new Date()` or `$$NOW`. Day buckets truncate
   each row's own date in the request's time zone
   (`services/trendsNetMmr.js:351,383`).
5. **Other collections only before admission.** Before `send`, each route reads
   only auth and the query string (`routes/aggregations.js:336-343,352-378`).
6. **No unproved global input.** The computations use `games`,
   `gamesMatchStage`, `bucketSwitch` and `pickTimezone`
   (`services/trendsNetMmr.js:46-53`); neither reads a curve or profile. Both are
   non-dependent kinds (`middleware/userCache.js:7`).
7. **Complete key.** `send` receives the parsed filters and exactly the options
   object each service receives (`routes/aggregations.js:341-343,367-378`), and
   the services read nothing else (`services/trendsNetMmr.js:414-415`;
   `services/trendsNetMmrOpponents.js:116-122`). The route test checks that the
   object the cache keys on is the one the service receives
   (`apps/api/__tests__/userCacheRoutes.test.js:118-132`). Raw strings can split
   equivalent requests into separate keys, which costs only reuse. A key over
   16 KiB is never retained (`middleware/userCache.js:259-260`).
8. **Size.** Net MMR by matchup is structurally bounded: at most nine matchups,
   25 coverage rows and seven regions, plus one row each for daily totals and
   extremes (`services/trendsNetMmr.js:416-429,464-492`;
   `services/trendsRegionExpr.js:51-58,69-80`;
   `util/regionFromToonHandle.js:47-54`). The drill-down is not: a page holds up
   to 500 rows plus two leaders (`services/trendsNetMmrOpponents.js:15-16,120`),
   and the Opponents tab requests 500-row pages
   (`apps/web/lib/netMmrOpponents.ts:166,227-232`). Typical pages fit: a row has
   17 fields (`services/trendsNetMmrOpponents.js:330-349`), about 365 bytes of
   JSON with typical identity strings, so a 500-row page with its two leaders is
   about 185 KB, roughly a third of the 512 KiB entry cap
   (`middleware/userCache.js:10`), and the race modal's 25-row page
   (`apps/web/components/analyzer/charts/NetMmrRaceOpponentsModal.tsx:31,110`) is
   about 10 KB. Only identity strings near the validator caps
   (`validation/gameRecord.js:206,211,215,233`), which the name fallbacks copy
   (`services/trendsNetMmrOpponents.js:208-217,328-333`), can push a 500-row page
   over the cap; such a page goes out as an uncached 200
   (`middleware/userCache.js:211-217`).
9. **Callers.** Net MMR by matchup has three: its route
   (`routes/aggregations.js:336-347`), coaching's performance view outside
   `send` on the same app-level instance (`routes/coaching.js:580-583`;
   `app.js:712,1453`), and admin global trends on a separate service under its
   own scope (`services/adminGlobalTrends.js:15,174-177`). Coaching's call is the
   new unguarded first-observation source; ADR 0072 now names it, with the
   requests whose join key it can equal (`routes/coaching.js:560-569,857-866`).
   The drill-down has its route (`routes/aggregations.js:352-382`) and admin
   global trends only. HEAD requests skip the guard for both, as ADR 0072
   already lists. On the web, the matchup chart, MMR progression's daily-record
   strip (same path and SWR key) and the race modal reach the guarded routes
   through the conditional client
   (`apps/web/components/analyzer/charts/NetMmrByMatchupChart.tsx:152-154`;
   `apps/web/components/analyzer/charts/MmrProgressionChart.tsx:255-261`;
   `apps/web/components/analyzer/charts/NetMmrRaceOpponentsModal.tsx:127`). The
   Opponents tab fetches with `cache: "no-store"` outside that client, so it gets
   no 304 reuse (`apps/web/lib/netMmrOpponents.ts:233-237,299`).
10. **Wiring.** Both routes use `send(kind)` (`routes/aggregations.js:342,378`)
    and both kinds are in `ALLOWED_ROUTES` (`middleware/userCache.js:9`). The
    route tests compare the off path with the same router without a cache
    (`apps/api/__tests__/userCacheRoutes.test.js:54-63`). The web list now holds
    nineteen of its 32 bits, and the test pins the new positions
    (`apps/web/lib/__tests__/conditionalApiScope.routes.test.ts:13-14`).
11. **Fleet note.** Neither service holds process-local state; their modules
    hold constants only (`services/trendsNetMmr.js:25-44`;
    `services/trendsNetMmrOpponents.js:15-33`). The retained key has only the
    standard parts (`middleware/userCache.js:257`). The unguarded paths are HEAD
    for both kinds and coaching for the matchup view, now both listed in ADR
    0072, so both kinds inherit G1-G6 and the first-observation rule. G1-G3 stay
    unmet. G4 is the only bound on the G1 and G2 gaps, and on G3 when the bump
    fails: entries leave the cache 600 s after they are stored, and a body's data
    can be older by the computation's duration and by an adopted join's age,
    under 30 s.

## Verification

Local checks ran at `f9cc5ccc`, the review follow-up on `78d42380`
([receipt](validation/dashboard-cache-net-mmr/local-verification.json)):

- **API.** Whole-API types pass. Configured lint has 757 warnings and 0 errors.
  The changed files add no configured or strict message; the router's inherited
  length warning now counts 351 lines instead of 352, because one code line
  became a comment. The new suite passes strict lint.
- **Suites.** Twenty suites (the cache, the routes, the trends and net-MMR
  services, coaching and admin global trends) pass 433 of 433 cases, in band on
  cached MongoDB 7.0.14 with downloads disabled, and no MongoDB process was left
  over.
- **Web.** Web types pass, the three changed web files pass lint with no
  warning, and nine client, capability and KPI-strip test files pass 119 of 119
  cases.
- **Mutation.** Eleven deliberate regressions each make the intended tests fail:
  either kind left out of the allowlist, the matchup route answering with plain
  JSON, the matchup key dropping the grouping or truncating the zone, the
  drill-down key dropping the search or clamping the limit, the hide and the
  identity heal left unfenced, and the web path left out or the positions
  moved.
- **Review.** An independent read-only review with a skeptic per finding found
  no blocking issue. Its one confirmed major, that the delete step cannot
  isolate the tombstone write, is addressed in item 2, which now says that fence
  rests on inspection. Its test and wording findings are addressed in
  `f9cc5ccc` and in these docs.

## Limitations

- Every test runs one process. Source coverage only; never activation evidence.
- The drill-down's size is not structurally bounded (item 8), and the Opponents
  tab's no-store fetch gets no 304 reuse.
- With the flag on, both kinds share the cache's existing admission
  (`docs/engineeringexplanation.md:444-458`); before C2 these routes took no
  permit. The Trends tab's Performance & MMR group now makes three covered reads
  (MMR progression's two and session patterns;
  `apps/web/components/analyzer/charts/MmrProgressionChart.tsx:252-261`;
  `apps/web/components/analyzer/TrendsTab.tsx:228-247`) against an owner's two
  compute permits, so one read waits, and a wait over five seconds returns 503
  `user_cache_busy`. The Opponents tab's drill-down fetch does not retry: a 503
  on any of its pages shows MMR impact as temporarily unavailable until the
  filters or `dbRev` change or the tab remounts
  (`apps/web/lib/netMmrOpponents.ts:238-241,261-284`;
  `apps/web/components/analyzer/OpponentMmrImpact.tsx:64-69`). Activation must
  accept this or add a bounded retry. No latency effect is measured or claimed.
- Ungrouped net MMR by matchup sorts races by net MMR with no tie-break
  (`services/trendsNetMmr.js:427-429,456`), so equal values can come back in
  either order and change the ETag. That costs only reuse; the web always groups
  by matchup (`apps/web/lib/netMmrOpponents.ts:148-152`).
- Exact-head CI, merge, deployment and production acceptance are recorded
  separately if and when they happen.

## Remaining dashboard work

The parent `faster-dashboards` item stays partial. The scoping order continues
with C3 (random summary's memo), C4 (the matchup time series' curve proof), DA3,
DA4, G1 (the chart-cache overlap guard), C5 and R1. `analysis-corpus-local-cache`
follows the dashboard work, and the final `docs/SETUP_GUIDE.md` is still
required when the whole program is delivered.
