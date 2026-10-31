# Dashboard cache: streak and macro report (October 30 UTC)

The program remains active and incomplete. Faster-dashboards slice C1 adds two
owner-game responses to the default-off private chart cache: the current
win/loss streak (`/v1/streak`) and the Macro tab's report (`/v1/macro/report`).
Source coverage grows from fifteen to seventeen response kinds. This is the
first admission under the checklist in
[ADR 0072](../adr/0072-serving-cohort-coherence.md#source-coverage-admission-checklist).
Each item is applied below with file:line evidence at this branch's head. API
paths are relative to `apps/api/src/`.

C1 is stacked on F1 ([PR #824](https://github.com/ReSpOnSeSC2/sc2tools/pull/824),
unmerged; this branch carries its head), which adds ADR 0072. Its admission checklist and
shared-fleet audit meet the ledger's precondition for wider coverage
(`docs/handoff/roadmap-progress-2026-10-28.json:1963`). C1 merges only after F1.

`USER_CACHE_ENABLED` stays off. While it is off, both routes call their service
and `res.json` as before (`routes/aggregations.js:26-28`;
`middleware/userCache.js:109-111`). No provider setting, flag, activation,
migration, background job, infrastructure or agent release is included. No
latency, request reduction or savings is claimed.

## What changed

- `middleware/userCache.js:9` adds `streak` and `macroReport` to the allowlist.
- `routes/aggregations.js:406,419` answer both routes through `send(kind)`
  instead of `res.json`. Services, filters, pipelines, limits and response
  shapes are unchanged.
- `apps/web/lib/conditionalApiScope.tsx:9` appends `/v1/streak` and
  `/v1/macro/report` at capability positions 15 and 16. Positions 0-14 do not
  move.
- Tests:
  - the route suite covers both kinds for 200 and 304, off parity, and owner
    and filter isolation. One fixture requests all thirteen non-dependent
    covered paths and checks that each keeps its own retained body, so a
    reused kind string fails. Never-retained routes must answer 200;
  - the real-Mongo coverage suite runs the real streak and macro report
    services;
  - a new full-app real-Mongo test
    (`apps/api/__tests__/userCacheStreakMacro.mongo.test.js`) checks that each
    writer listed under item 2 retires both retained bodies, and that a delete
    stopped after its pending mark, before the tombstone, retires them too;
  - the web tests pin positions 15 and 16 and rebuild both paths from 304s.
- `CHANGELOG.md` gains a line under Dashboard cache coverage.

## Admission checklist

1. **Owner games only.** Streak runs one aggregate on `games` that starts with
   `gamesMatchStage(userId, filters)` (`services/streak.js:51-65`). The macro
   report runs two on `games`, both built from `match = gamesMatchStage(userId,
   filters)` (`services/macroReport.js:102`). The first is a date-extremes
   pre-pass on `{ ...match, macroScore: { $type: "number" } }` (`:107-119`). Its
   type test replaces any `macro_min`/`macro_max` range that `gamesMatchStage`
   set (`util/parseQuery.js:288-295`), so for a bounded request it reads every
   scored game that matches the other filters. The second is one `$facet` on the
   unmodified `match` (`services/macroReport.js:248-254`). Both keep the owner,
   deletion and exclusion clauses (`util/parseQuery.js:242-247`), and the parsed
   bounds are part of the key (`middleware/userCache.js:257`). Neither kind has a
   `$lookup`, `$unionWith` or another collection.
2. **Fenced writers.** Streak reads `result` and `date`
   (`services/streak.js:55-61`). The macro report reads `macroScore`,
   `top3Leaks`, `result`, `date`, `opponent.race`, `myBuild` and `durationSec`
   (`services/macroReport.js:67,109,113-114,163-172,178-180,188,296`). Each is
   already read by a covered kind: the summary's recent games read `date`,
   `opponent.race`, `result` and `myBuild` (`services/aggregations.js:96-103`),
   the macro summary reads `macroScore` and `top3Leaks` (`:557-566`), and the
   game-length filter reads `durationSec` for every kind
   (`util/parseQuery.js:309-315`). Filter fields are the same `gamesMatchStage`
   fields every covered kind reads. The new test checks that ingest, reupload,
   resumed quarantine, hide, unhide, the macro write
   (`services/perGameCompute.js:476,498`) and a completed delete each retire both
   bodies (`apps/api/__tests__/userCacheStreakMacro.mongo.test.js:42-70`). A
   delete whose payload purge fails retires them through its pending mark alone
   (`services/gameControls.js:121,124`;
   `apps/api/__tests__/userCacheStreakMacro.mongo.test.js:72-84`).
3. **No completed owner-data memo.** Both services keep only `db`
   (`services/streak.js:29-31`; `services/macroReport.js:83-85`), hold no memo
   and do not run through TrendsRequests.
4. **No clock in the result.** Neither file calls `Date.now`, an
   argument-less `new Date()` or `$$NOW`. The macro report's trend split is the
   midpoint of the date span of the scored games that match the other filters
   (`services/macroReport.js:339-346`), not a window from the current time.
5. **Other collections only before admission.** Neither route reads anything
   before `send` beyond auth and `parseFilters(req.query)`
   (`routes/aggregations.js:402-406,415-419`).
6. **No unproved global input.** Neither computation reads a curve, profile or
   other global input. Both are non-dependent kinds
   (`middleware/userCache.js:7`).
7. **Complete key.** The only request input is the query string. It is parsed
   by `parseFilters` and passed to `send` as filters, with empty options
   (`routes/aggregations.js:405-406,418-419`). The services take only `userId`
   and those filters.
8. **Size.** Streak's body is three fields (`services/streak.js:101`), so it is
   structurally bounded. The macro report is not. Its score and duration
   buckets are fixed at five each (`services/macroReport.js:35-50`) and its
   build segments are capped at eight (`:53,200-201`), but the leak ledger has
   one row per distinct leak name (`:162-175,414-452`) and the matchup segments
   one per distinct first letter of the opponent's race (`:176-182`). The agent
   emits a small fixed set of leak names (`util/parseQuery.js:102-105`), so
   typical bodies hold a few dozen rows. The macro recompute write does not
   enforce that set (`routes/perGame.js:218-222`), so the 512 KiB entry cap is the
   only enforced bound (`middleware/userCache.js:10`): a larger body goes out as
   an uncached 200 (`:211-217`).
9. **Callers.** Each method has one caller: `deps.macroReport.report`
   (`routes/aggregations.js:406`) and `deps.streak.current` (`:419`). Both use
   the app-level instances (`app.js:717-718,1780-1786`). A source search finds
   no other caller; the `streak` fields in other services are separate
   computations. Neither method runs through TrendsRequests, so neither has a
   join for a first observation to keep. HEAD requests skip the guard
   (`middleware/userCache.js:109-111`), but for these kinds they only compute
   and discard the body. The web calls `/v1/streak` from the dashboard KPI strip
   (`apps/web/components/analyzer/DashboardKpiStrip.tsx:178`) and
   `/v1/macro/report` from the Macro tab
   (`apps/web/components/analyzer/MacroTab.tsx:41-42`).
10. **Wiring.** Both routes use `send(kind)` (`routes/aggregations.js:406,419`)
    and both kinds are in `ALLOWED_ROUTES` (`middleware/userCache.js:9`). The
    route tests compare status, body and headers on the off path with the same
    router without a cache, and check that the off path makes no revision call
    (`apps/api/__tests__/userCacheRoutes.test.js:52-61`). The web list now holds
    seventeen of its 32 bits, and the test pins the new positions
    (`apps/web/lib/__tests__/conditionalApiScope.routes.test.ts:11-12`).
11. **Fleet note.** Neither service holds process-local state (item 3). The
    retained key has only the standard parts: owner, kind, parsed filters,
    empty options and the revision snapshot (`middleware/userCache.js:257`).
    The only unguarded path is HEAD, which keeps nothing (item 9). Both kinds
    therefore inherit G1-G6 and the first-observation rule unchanged. G1-G3 stay
    unmet. G4 is the only bound on the G1 and G2 gaps, and on G3 when the bump
    fails: entries leave the cache 600 s after they are stored, and a body's
    data can be older by the computation's duration, since neither kind adopts
    a join.

## Verification

Local checks ran at `1fecfca0`, whose application files equal `83e53307`
([receipt](validation/dashboard-cache-streak-macro/local-verification.json)):

- **API.** Whole-API types pass. Configured lint has 757 warnings and 0
  errors, the same as F1's head, and the two changed source files add no
  configured or strict message. Fifteen affected suites pass 293 of 293 cases,
  14 of them new. They ran in band on cached MongoDB 7.0.14 with downloads
  disabled, and no MongoDB process was left over.
- **Web.** Whole-web types pass and the changed files lint clean. Nine
  conditional-API and KPI-strip test files pass 117 of 117 cases, 2 of them new.
- **Mutation.** Seven deliberate regressions each make the intended tests fail:
  streak removed from the allowlist, the macro report answered with plain
  `res.json`, `/v1/macro/report` missing from the web list, the two new web
  positions swapped, the pending-delete write left unfenced, the macro report
  reusing the macro summary's kind, and the macro write left unfenced.
- **Review.** An independent read-only review with a skeptic per finding found
  no blocking issue. Its confirmed findings and the cheap suggestions are
  addressed here.
- **Route budgets** are checked by the exact-head web CI (`perf:budget`), not
  locally.

## Limitations

- Every test runs one process. A contract and single-process tests cannot show
  the fleet behaviour G1-G3 describe. This is source coverage only and is never
  activation evidence.
- The macro report's size is not structurally bounded (item 8).
- With the flag on, both kinds share the cache's existing admission
  (`docs/engineeringexplanation.md:444-458`). The dashboard and the Macro tab
  each make three covered reads against an owner's two compute permits, so one
  read waits, and a wait over five seconds returns 503 `user_cache_busy`. No
  latency effect is measured or claimed.
- With `macro_min`/`macro_max`, the macro report's trend gate and split use every
  scored game rather than only those in the range
  (`services/macroReport.js:109,121-122,208`). This predates C1 and is unchanged
  by it.
- Exact-head CI, merge, deployment and production acceptance are recorded
  separately if and when they happen.

## Remaining dashboard work

The parent `faster-dashboards` item stays partial. The scoping order continues
with DA2 (bounded no-grant probes in the unwired device-auth lease), then C2
(net MMR by matchup), C3 (random summary's memo), C4 (the matchup time series'
curve proof), DA3, DA4, G1 (the chart-cache overlap guard), C5 and R1. Each
later coverage slice applies the same checklist. `analysis-corpus-local-cache`
follows the dashboard work, and the final `docs/SETUP_GUIDE.md` is still
required when the whole program is delivered.
