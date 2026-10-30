# Dashboard cache: random summary (October 30 UTC)

The program remains active and incomplete. Faster-dashboards slice C3 adds the
random-race summary (`/v1/random-summary`), which the analyzer's matchup picker
reads, to the default-off private chart cache. Source coverage grows from
nineteen to twenty response kinds. Each item of the
[ADR 0072 checklist](../adr/0072-serving-cohort-coherence.md#source-coverage-admission-checklist)
is applied below with file:line evidence at this branch's head. API paths are
relative to `apps/api/src/`.

This is the first kind admitted that had a completed-result memo, which
checklist item 3 disqualifies: a process that observes an owner for the first
time keeps such a memo, so a request that skips the guard, such as a HEAD, could
leave a body that a later guarded GET retains under a newer revision. The
service now skips its 60-second memo whenever the cache is enabled and keeps it
unchanged while the cache is off or absent. ADR 0072's item 3, its
cross-process table and the checklist preamble change in the same pull request,
as its update rule asks. C3 is stacked on C2
([PR #828](https://github.com/ReSpOnSeSC2/sc2tools/pull/828)), DA2
([PR #826](https://github.com/ReSpOnSeSC2/sc2tools/pull/826)), C1
([PR #825](https://github.com/ReSpOnSeSC2/sc2tools/pull/825)) and F1
([PR #824](https://github.com/ReSpOnSeSC2/sc2tools/pull/824)), and merges after
them.

`USER_CACHE_ENABLED` stays off. While it is off, the route calls its service and
`res.json` as before, and the memo answers as before (`routes/aggregations.js:26-28,110`;
`middleware/userCache.js:109-111`; `services/aggregations.js:360-362`). No
provider setting, flag, activation, migration, background job, infrastructure
or agent release is included. No latency, request reduction or savings is
claimed.

## What changed

- `middleware/userCache.js:9` adds `randomSummary` to the allowlist as a
  non-dependent kind.
- `routes/aggregations.js:110` answers through `send("randomSummary")` with the
  parsed filters and empty options, and passes `memo: !deps.userCache?.enabled`
  to the service.
- `services/aggregations.js:351,360-362` takes that switch: the 60-second
  `cached()` memo answers only when the switch is on and the filters are empty;
  every other request runs through `TrendsRequests.run`, an in-flight join. The
  calculation (`:366-446`) and the response shape are unchanged, and every source
  edit keeps line counts.
- `apps/web/lib/conditionalApiScope.tsx:9` appends the path at capability
  position 19. Positions 0-18 do not move.
- Tests:
  - a new real-Mongo suite runs the production composition (`buildApp`) with the
    cache on and off, and stands in for another API process with a game write
    that reaches none of this process's invalidators plus a stored `dataRev`
    increment. A HEAD that finished before that write leaves nothing the first
    guarded GET can retain
    (`apps/api/__tests__/userCacheRandomSummary.mongo.test.js:60-73`); an
    observed owner's next GET is retired with a 503 and then reads fresh
    (`:75-85`); filtered, unfiltered and race-filtered requests keep separate
    bodies and validators, and a local write retires each of them (`:87-103`);
    and with the cache off the memo still shares one answer for its minute,
    race-only requests included, while filtered requests read fresh (`:105-122`);
  - the route suite adds the kind to its 200/304, off parity, isolation and
    kind-separation tests, drops it from the never-retained list, and checks
    that GET and HEAD pass `memo: false` exactly when the cache is enabled
    (`apps/api/__tests__/userCacheRoutes.test.js:186-193`);
  - the real-Mongo coverage suite runs the real service through ingest,
    reupload, quarantine and an unknown commit
    (`apps/api/__tests__/userCacheCoverage.mongo.test.js:38`);
  - unit tests check that with the switch off, concurrent loads still join but
    completed answers are never reused, and that concurrent filtered and
    unfiltered loads never share a computation
    (`apps/api/__tests__/randomSummaryCache.test.js:77-93`);
  - the web tests pin position 19 and rebuild the path from 304s
    (`apps/web/lib/__tests__/conditionalApiScope.routes.test.ts:15`;
    `apps/web/lib/__tests__/clientApi.conditional.test.tsx:65`).
- ADR 0072, the engineering explanation and the admin console text now count
  twenty covered kinds, and `CHANGELOG.md` gains a line under Dashboard cache
  coverage.

## Admission checklist

1. **Owner games only.** The kind runs one aggregate on `games` whose first
   stage is `gamesMatchStage(userId, filters)` (`services/aggregations.js:367-370`),
   with no `$lookup`, `$unionWith` or other collection (`:368-396`). Every row it
   counts passes that stage; there is no wider read.
2. **Fenced writers.** Besides the stage's own fields, it reads `result` through
   the result buckets (`services/aggregations.js:22-27,371,870-877`) and `myRace`
   (`:377-379`), only on rows the stage selects. Covered kinds already read both
   on the same rows: the summary buckets `result` after the same stage
   (`services/aggregations.js:68-72`), and the summary's race grouping matches
   each race through `myRace` inside that stage
   (`services/aggregations.js:58-59,1040-1053`; `util/parseQuery.js:261-262`).
   So item 2's shortcut applies and no new writer evidence is needed: in-process
   writers of those fields run inside `gameWrite`, and out-of-band writers stay
   G1 gaps, as for every covered kind.
3. **No completed owner-data memo (now met).** Under an enabled cache the route
   passes `memo: false` (`routes/aggregations.js:110`), so the service uses only
   `TrendsRequests.run` (`services/aggregations.js:360-362`), an in-flight join
   the invalidator retires (`app.js:1004-1007,1011-1019`;
   `services/trendsRequests.js:31-36`). Only `cached()` fills the memo map
   (`services/trendsRequests.js:42-67`), and on the app-level aggregations
   service random summary is its only caller (`services/aggregations.js:361`), so
   a cache-enabled process never fills or consults it. The HEAD test shows
   that the scenario item 3 describes, a completed body left outside the guard
   and adopted by a first observation, does not occur
   (`apps/api/__tests__/userCacheRandomSummary.mongo.test.js:60-73`). A HEAD
   still in flight when that GET arrives can be joined; that is the join residual
   ADR 0072's first-observation rule records for every covered kind. The kind
   runs no `dateRange` probe.
4. **No clock in the result.** The computation (`services/aggregations.js:366-446`)
   calls no `Date.now`, argument-less `new Date()` or `$$NOW`. The memo's expiry
   only ages reuse, and an enabled cache never reaches it.
5. **Other collections only before admission.** Before `send`, the route reads
   only auth and the query string (`routes/aggregations.js:106-110`).
6. **No unproved global input.** The computation uses `games`,
   `gamesMatchStage`, `bucketSwitch` and two constants
   (`services/aggregations.js:17,20`); it reads no curve or profile. It is a
   non-dependent kind (`middleware/userCache.js:7`).
7. **Complete key.** `send` receives the parsed filters and empty options
   (`routes/aggregations.js:110`). The service reads only those filters, minus
   `race` and `groupByRacePlayed`, which it ignores
   (`services/aggregations.js:353-355`). The key keeps both, which costs only
   reuse, as the race-filtered request shows
   (`apps/api/__tests__/userCacheRandomSummary.mongo.test.js:89-95`). The memo
   switch is process configuration, fixed for the process's life, not a request
   input. A key over 16 KiB is never retained (`middleware/userCache.js:259-260`).
8. **Size.** Structurally bounded: a total, three per-race rows of five numbers,
   the best and worst race names and one constant
   (`services/aggregations.js:412-445`), about 350 bytes of JSON, far below the
   512 KiB entry cap (`middleware/userCache.js:10`).
9. **Callers.** The route is the only caller of `randomSummary`
   (`routes/aggregations.js:110`), and it uses the app-level service whose joins
   the invalidator retires (`app.js:712,1004-1007,1780-1782`). HEAD requests skip the guard
   (`middleware/userCache.js:109-111`) but, under an enabled cache, also skip the
   memo, so they can leave only a join, as ADR 0072 already lists for every
   covered kind (`apps/api/__tests__/userCacheRoutes.test.js:186-193`). On the
   web, the matchup picker reads the path through `useApi`, whose conditional
   client now covers it (`apps/web/components/analyzer/MatchupPicker.tsx:51`).
   The picker mounts in the analyzer filter bar and the fingerprint card, and the
   admin Global trends filters reuse that bar
   (`apps/web/components/analyzer/FilterBar.tsx:52,54`;
   `apps/web/components/analyzer/FingerprintCard.tsx:274`;
   `apps/web/app/admin/global-trends/GlobalGameFilters.tsx:44`).
10. **Wiring.** The route uses `send(kind)` (`routes/aggregations.js:110`) and
    the kind is in `ALLOWED_ROUTES` (`middleware/userCache.js:9`). The route
    tests compare the off path with the same router without a cache
    (`apps/api/__tests__/userCacheRoutes.test.js:54-63`), and the cache-off
    production-composition test shows the memo unchanged
    (`apps/api/__tests__/userCacheRandomSummary.mongo.test.js:105-122`). The web
    list now holds twenty of its 32 bits, and the test pins the new position
    (`apps/web/lib/__tests__/conditionalApiScope.routes.test.ts:15`).
11. **Fleet note.** The kind adds no process-local state: under an enabled cache
    it drops the one completed memo it had, and ADR 0072's table now records
    that the memo answers only while the cache is off. The retained key has only
    the standard parts (`middleware/userCache.js:257`), and its only unguarded
    path is HEAD, already listed. The kind inherits G1-G6 and the
    first-observation rule unchanged; G1-G3 stay unmet. G4 is the only bound on
    the G1 and G2 gaps, and on G3 when the bump fails: entries leave the cache
    600 s after they are stored, and a body's data can be older by the
    computation's duration and by an adopted join's age, under 30 s.

## Verification

Local checks ran at `10cdb0fd`, the review follow-up on `b555b34e`
([receipt](validation/dashboard-cache-random-summary/local-verification.json)):

- **API.** Whole-API types pass. Configured lint has 758 warnings and 0 errors.
  The one warning more than C2 recorded is in `main`'s new
  `apps/api/__tests__/opponentsRaceHistory.test.js`, merged in through
  `ca095617`. The files C3 changes add no configured or strict message, and the
  new suite passes strict lint.
- **Suites.** Twenty-two suites (C2's twenty plus random summary's unit and
  real-Mongo suites) pass 449 of 449 cases, in band on cached MongoDB 7.0.14 with
  downloads disabled, and no MongoDB process was left over.
- **Web.** Web types pass, the three changed web files pass lint with no
  warning, and ten client, capability, KPI-strip and matchup-picker test files
  pass 129 of 129 cases.
- **Mutation.** Twelve deliberate regressions each make the intended tests fail:
  the kind left out of the allowlist; plain JSON on the route; the memo kept
  under an enabled cache, dropped without one, or kept for HEAD; a cache key
  without the filters; the service ignoring the switch or memoizing filtered
  answers; a join key without the filters; a memo test on the raw filters; and
  the web path left out or moved.
- **Review.** An independent read-only review with a skeptic per finding found
  no blocking issue. Its one major was a CHANGELOG sentence promising that a
  reused summary always matches the latest games, which ADR 0072's G1-G3 rule
  out; it is corrected. Its minor and nit findings are addressed in `10cdb0fd`
  and these docs.

## Limitations

- Every test runs one process. Source coverage only; never activation evidence.
- With the flag on, the picker's summary takes the cache's admission like every
  covered read (`docs/engineeringexplanation.md:444-458`). It asks once per
  browser document and account, when the first filter bar with the picker
  mounts (on phones, when the Filters sheet first opens), because its SWR
  options turn off revalidation on focus, reconnect and stale mounts
  (`apps/web/components/analyzer/MatchupPicker.tsx:51-55`). A wait over five
  seconds returns 503 `user_cache_busy`, which SWR's default error retry
  requests again.
- With the flag on, the summary is retained per owner revision instead of being
  shared for a minute. The first GET after a write in this process recomputes.
  After another process's write, an observed owner's first GET gets 503
  `user_cache_changed` with `Retry-After: 1`, and the retry recomputes. While an
  owner is uncacheable (a write in progress, a dirty mark after a skipped or
  failed revision bump, owner overflow or a poisoned process;
  `util/userRevision.js:134-137`), every request recomputes and shares only
  in-flight joins, as for every covered kind; before C3 those requests shared
  one answer per minute. No latency is measured.
- With the flag off, the memo answers exactly as before C3, including its
  existing one-minute window.

## Remaining dashboard work

Faster-dashboards stays partial. The remaining slices are C4 (matchup time
series), DA3, DA4, G1 (the chart-cache overlap guard slice, not guarantee G1),
C5 and R1; DA6, wiring the device-auth REST adapter, stays deferred. The
analysis-corpus local cache follows, and the final `docs/SETUP_GUIDE.md` is
still required at program completion.
