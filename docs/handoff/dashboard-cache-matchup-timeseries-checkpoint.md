# Dashboard cache: matchup time series (October 30 UTC)

The program remains active and incomplete. Faster-dashboards slice C4 adds the
matchup win-rate-over-time chart (`/v1/timeseries/matchups`), with its rating
windows, to the default-off private chart cache as a curve-dependent kind.
Source coverage grows from twenty to twenty-one response kinds, and the
dependent kinds from four to five. Each item of the
[ADR 0072 checklist](../adr/0072-serving-cohort-coherence.md#source-coverage-admission-checklist)
is applied below with file:line evidence at this branch's head. API paths are
relative to `apps/api/src/`.

This kind's global input, the MMR expectation curve, reached an in-flight join:
the chart shared work under a key with no curve part, so two requests under
different curve proofs could have shared one computation. C4 threads the
captured proof into the calculation and skips the chart join whenever a proof is
supplied; the curve-independent date-range probe stays shared. ADR 0072's
checklist preamble, items 1, 3 and 6, two rows of its cross-process table and
its list of first-observation sources change in the same pull request, as its
update rule asks. C4 is based on `main` after the F1-C3 stack merged
(`2fabe343`), and this pull request also records that stack's delivery.

`USER_CACHE_ENABLED` stays off. While it is off, the route calls the service
with its original three arguments and `res.json`, so the inner join and the
per-request curve read are unchanged (`routes/aggregations.js:150-156,469-470`;
`services/aggregations.js:680-683`). No provider setting, flag, activation,
migration, background job, infrastructure or agent release is included. No
latency, request reduction or savings is claimed.

## What changed

- `middleware/userCache.js:7` adds `matchupTimeseries` to the dependent kinds,
  and through them to the allowlist (`:8-9`).
- `routes/aggregations.js:150-156` answers through a shared curve-dependent
  helper (`:463-474`) with exactly the options object the service receives:
  `{ interval, tz, groupByOwnRace }`. `sendStrength` (`:455-461`) now delegates
  to the same helper, and the four strength routes' calls are unchanged.
- `services/aggregations.js:674-683` passes an optional captured snapshot
  through. Work under a proof never joins in-flight chart work; proof-less calls
  keep the original join key.
- `services/trendsAggregations.js:36,45,456-461` takes the snapshot, and one
  helper picks the curve: the proof's curve when one is supplied (a null curve
  stays Elo), otherwise the memo's. That one curve feeds both the Mongo
  expectation and every rating window (`:86-98`). The helper also lowers the
  function's strict complexity from 15 to 13.
- `apps/web/lib/conditionalApiScope.tsx:9` appends the path at capability
  position 20; positions 0-19 do not move.
- Tests:
  - unit tests check that a captured proof drives the Mongo expectation and
    every rating window without reading the memo, that an Elo proof stays Elo,
    that the proof-less join key and probe-then-curve order are unchanged, that
    work under different proofs never shares a computation while proof-less
    requests still join, and that different proofs share the owner's date-range
    probe while another owner never does
    (`apps/api/__tests__/matchupTimeseriesProof.test.js:33-83`);
  - a new real-Mongo suite with the real curve service checks the original body
    under the captured curve, a 304 and no public curve read for three option
    sets (`apps/api/__tests__/userCacheMatchupTimeseries.mongo.test.js:74-87`);
    one captured curve across Mongo and every rating pair when the memo changes
    before work (`:88-102`); a request after a curve expiry or retirement running
    its own computation (`:103-124`); a 200/no-store initiator and a 503 joined
    follower when the proof retires mid-work (`:125-142`); retention that ends with
    the proof (`:143-153`); no 304 after an unknown publish (`:154-162`);
    byte-identical off behaviour with the inner join kept (`:163-181`); a HEAD
    that never captures and is never adopted by a later GET (`:182-196`); and
    admin global trends' three-argument call (`:197-206`);
  - the route suite checks all five dependent kinds for one captured proof
    reaching the service, a new tag per proof, a 200/no-store retired proof, the
    chart's option keys, HEAD without capture and off parity
    (`apps/api/__tests__/userCacheRoutes.test.js:196-249`);
  - the real-Mongo coverage suite runs the real chart with the real curve
    service through ingest, reupload, quarantine and an unknown commit
    (`apps/api/__tests__/userCacheCoverage.mongo.test.js:37-38`);
  - the web tests pin position 20, keep the admin global path uncovered, rebuild
    the path from 304s and move the non-allowlisted control to the opponent MMR
    buckets (`apps/web/lib/__tests__/conditionalApiScope.routes.test.ts:16-17`;
    `apps/web/lib/__tests__/clientApi.conditional.test.tsx:65,87`).
- ADR 0072, the engineering explanation and the admin console text now count
  twenty-one covered kinds and five dependent ones, and `CHANGELOG.md` gains a
  line under Dashboard cache coverage.

## Admission checklist

1. **Owner games only (preamble amended).** The computation runs the shared
   date-range probe and one chart aggregate on `games`, both selecting rows with
   `gamesMatchStage(userId, filters)` first (`services/aggregations.js:634-637`;
   `services/trendsAggregations.js:40,46-47,86-89`), with no `$lookup`,
   `$unionWith` or other collection. Under an enabled cache the curve document is
   read in capture, after response admission and before the key is formed
   (`middleware/userCache.js:115,274-278`), so it is not a read in the
   computation; HEAD and the off path keep the original memo read after the
   probe (`services/trendsAggregations.js:42-45`).
2. **Fenced writers.** The rows are the stage's rows only. The chart reads
   `date`, `result`, `myRace` and `opponent.race` for its points, and the
   ratings' ladder, result and MMR fields for its rating windows
   (`services/strengthAdjusted.js:59-65,87-93`); the date-range probe reads only
   `date`. Covered kinds already read all of them on the same rows: the four
   strength kinds run the same strength stages after the same stage
   (`services/aggregations.js:139-147`); the summary's matchup facet reads
   `opponent.race` (`:87,879-890`) and its race grouping reads `myRace` through
   the stage (`:58-59,1040-1053`; `util/parseQuery.js:261-262`); and the
   timeseries reads `date` and `result` (`services/aggregations.js:477-489`).
   So item 2's shortcut applies.
3. **No completed owner-data memo (amended).** There is no `cached()` call.
   Proof-less work joins under `["matchupTimeseries", userId, filters, opts]`, an
   in-flight join the invalidator retires (`services/aggregations.js:682`;
   `app.js:1004-1007,1011-1019`; `services/trendsRequests.js:31-36`); work under a
   proof joins nothing. Item 3 now says item 6 also governs a join whose result
   depends on a global input.
4. **No clock in the result.** Day buckets truncate each row's own date in the
   request's time zone; no `Date.now`, argument-less `new Date()` or `$$NOW`
   reaches the probe, the pipeline or the body
   (`services/trendsAggregations.js:36-98`). The curve memo's expiry only ages
   reuse, behind item 6.
5. **Other collections only before admission.** Before `send`, the route reads
   only auth and the query string (`routes/aggregations.js:138-156`). The curve
   capture reads the expectation document after admission and before the key, as
   for the four strength kinds; the proof is part of the key and is checked again
   at publication (`middleware/userCache.js:258,287-292`).
6. **No unproved global input (now met).** One captured proof drives the key
   (`middleware/userCache.js:258`) and the calculation: the Mongo expectation
   (`services/trendsAggregations.js:87`; `services/strengthAdjusted.js:63`) and
   every rating window (`services/trendsAggregations.js:97`;
   `services/strengthAdjusted.js:111-121`). Work under a proof skips the chart
   join (`services/aggregations.js:682`), so a follower under a different proof
   cannot adopt it (`apps/api/__tests__/matchupTimeseriesProof.test.js:64-73`;
   `apps/api/__tests__/userCacheMatchupTimeseries.mongo.test.js:103-124,182-196`).
   The date-range probe reads no global input and stays shared
   (`apps/api/__tests__/matchupTimeseriesProof.test.js:74-83`). Entries expire
   with their proof (`middleware/userCache.js:268-270`).
7. **Complete key.** `send` receives the parsed filters and exactly the options
   object the service receives (`routes/aggregations.js:152-153`), and the route
   test checks that identity for every option
   (`apps/api/__tests__/userCacheRoutes.test.js:219-231`). The service reads only
   those options and filters (`services/trendsAggregations.js:37-40`);
   `group_by_race_played` stays in the key though this service ignores it, which
   costs only reuse. The proof enters only through its key part.
8. **Size.** Not structurally bounded. Grouped daily buckets allow up to 365
   buckets of 25 race pairs (`services/trendsAggregations.js:70`;
   `config/constants.js:188`), about 1.3 MB of point rows, plus at most 16 rating
   pairs of 50 samples (`services/strengthAdjusted.js:85-91`), about 100 KB.
   Typical single-race histories fit the 512 KiB entry cap
   (`middleware/userCache.js:10`); larger bodies go out as an uncached 200
   (`:211-217`).
9. **Callers.** The route, on the app-level service whose joins the invalidator
   retires (`app.js:712,1004-1007,1780-1786`). Admin global trends calls the
   method with three arguments and no proof on a separate service per call, with
   its own TrendsRequests, so it is not a first-observation source for guarded
   requests (`services/adminGlobalTrends.js:112-120,174-177`). HEAD skips the
   guard and keeps the original join, as ADR 0072 lists for every kind. Coaching
   never calls this method. On the web, the chart and the rating card read the
   same path, so they share one SWR key and one request; the rating card's hook
   rewrites the path only in admin global mode, which stays uncovered
   (`apps/web/components/analyzer/charts/MatchupOverTimeChart.tsx:26-27`;
   `apps/web/components/analyzer/charts/MatchupRatingCard.tsx:19-20`;
   `apps/web/lib/trendsDataContext.tsx:59-66`).
10. **Wiring.** The route uses `send(kind)` through the helper
    (`routes/aggregations.js:153,473`), and the kind is a dependent one
    (`middleware/userCache.js:7`). The route tests compare the off path with the
    same router without a cache
    (`apps/api/__tests__/userCacheRoutes.test.js:240-249`), and the real-Mongo
    off test shows identical bytes and the kept join
    (`apps/api/__tests__/userCacheMatchupTimeseries.mongo.test.js:163-181`). The
    web list now holds twenty-one of its 32 bits
    (`apps/web/lib/__tests__/conditionalApiScope.routes.test.ts:16`).
11. **Fleet note.** The kind adds no process-local state. The retained key has
    the standard parts plus the proof's key part (`middleware/userCache.js:257-258`),
    as the four strength kinds' keys do, and entries live at most as long as the
    proof (`:268-270`). The unguarded paths are HEAD and the date-range seeders,
    which ADR 0072 now lists together. The kind inherits G1-G6 and the
    first-observation rule; G1-G3 stay unmet.

## Verification

Local checks ran at `000734b6`; mutations ran at `ef4d67c4`, and the only later application change is one review comment
([receipt](validation/dashboard-cache-matchup-timeseries/local-verification.json)):

- **API.** Whole-API types pass. Configured lint has 758 warnings and 0 errors, the same as C3. The changed files add no
  configured or strict message: the router's length warning drops from 351 to 349 lines and the chart's strict complexity
  from 15 to 13. Both new suites pass strict lint.
- **Suites.** Thirty API suites pass 539 of 539 cases, in band on cached MongoDB 7.0.14 with downloads disabled, and no
  MongoDB process was left over.
- **Web.** Web types and the three changed web files' lint pass, and fifteen client, capability, Trends and matchup
  chart test files pass 156 of 156 cases.
- **Mutation.** Fifteen deliberate regressions each make the intended tests fail, from a kind that is allowlisted but not
  dependent, through a memo read on either side of the calculation and proof work that rejoins chart work, to an
  eagerly captured proof, a date-range probe without its owner and a strength route that drops its proof.
- **Review.** One independent read-only reviewer found no code defect; its seven minor documentation findings are
  addressed in `000734b6` and these docs.

## Delivery of F1-C3

The F1, C1, DA2, C2 and C3 pull requests (#824, #825, #826, #828, #829) merged
bottom-up with merge commits on the owner's request, after exact-head CI passed
on each. `main` at `2fabe343` equals C3's tested tree, and both production
deployments succeeded for that commit with public health checks; signed-in
read-only acceptance was not performed, because no session was signed in
([receipt](validation/faster-dashboards-delivery/production-2fabe343.json)).
`USER_CACHE_ENABLED` stays off and the device-auth lease stays uninjected.

## Limitations

- Every test runs one process. Source coverage only; never activation evidence.
- With the flag on, the chart now takes the cache's admission
  (`docs/engineeringexplanation.md:444-458`); before C4 it took none. The Trends
  tab's first load makes several covered reads, so one can wait, and a wait over
  five seconds returns 503 `user_cache_busy`.
- Reuse lasts at most as long as the curve proof, 60 s or less, and a follower
  joined to this two-aggregate computation gets 503 `user_cache_changed` if the
  memo expires mid-computation.
- Bodies over the entry cap, such as long daily histories with several played
  races, are never retained.
- Skipping the chart join under a proof gives up coalescing for concurrent
  requests that have no retainable key, and each runs its own two-aggregate
  computation: an owner mid-write or marked dirty; every request while no current
  proof can be issued, from the start of a curve recompute until it publishes and
  for up to 60 s after a failed or unacknowledged one
  (`services/mmrExpectation.js:109-111,122-124`;
  `services/strengthCurveSnapshots.js:32,34`); and every request while the stored
  curve fails validation (`services/strengthCurveSnapshots.js:83-96`). Admission
  still bounds them.

## Remaining dashboard work

Faster-dashboards stays partial. The remaining slices are DA3, DA4, G1 (the
chart-cache overlap guard slice, not guarantee G1), C5 and R1; DA6, wiring the
device-auth REST adapter, stays deferred. The analysis-corpus local cache
follows, and the final `docs/SETUP_GUIDE.md` is still required at program
completion.
