# Mechanics progress over time

Implements `mechanics-progress` and its macro-score-trend-and-dedupe augment on `codex/wave3-mechanics-progress`, reusing the clean preserved `wave3-my-reviews` worktree. Main through PR707 and the reviewed game-benchmarks foundation `e13a2098` are integrated. Merge after PR708. The prior reviews branch is preserved. Remote checks and merge remain required before calling this shipped.

## Behavior and data

Macro has one Mechanics progress card above the aggregate report. Macro score, APM and SQ share the existing `/v1/timeseries` resource, filters and calendar bucket. Switching metrics does not fetch another metric resource. The existing Mongo group adds APM/SQ means and separate `macroN`, `apmN` and `spqN` counts. Missing values do not lower an average, real zeros remain observations, and account/race/date filtering and interval coarsening are preserved. Global history's existing projection carries the same two additional slim-row fields.

The chart uses theme tokens, responsive SVG, true calendar spacing and straight observed segments. Missing measurements and missing calendar periods interrupt the line. Fewer than five measured games produce a hollow point; a missing legacy count is explicitly unknown and also hollow. Inspect period provides the value/count without hovering. Grouping shares the SSR-safe `analyzer.trends.bucket` preference with Trends and Build mix. Previous-filter data is labeled and dimmed while refreshing.

Opponent league reference is optional and initially off. It requires explicit ranked-1v1 filters, one concrete race pair and a selected opponent league bracket. These brackets group replays by the opponent's recorded league, a proxy for opposition level. The existing cached `useBenchmarks` table supplies a metric-specific median only with at least 50 measurements and valid deciles. Previous answers, failed lookups and mismatched league/matchup tables stay out of the chart. In particular, a cached table cannot survive an authoritative 404 suppression. It compares a population median with personal period means, not a target or causal claim.

MacroSummaryCard retains score, coverage and the existing backfill action. LeakLedgerCard is the single leak list, while FocusCard retains Fix this first. A no-score state offers Score my older games with an online paired app, otherwise desktop setup. Summary and empty state share one backfill action/job poll. APM/SQ remain available even without macro scores. The optional focus-cost overlay is omitted because the existing timeseries has no per-period leak costs.

Builds now mounts the existing Build mix matrix, with the same bucket preference and existing my-builds endpoint. Theme tokens and translucent fills retain readable count text in both themes.

## Verification

- 143 assertions across 19 affected web/Help/state suites pass. Real consumers cover metric-specific counts, the hollow threshold, calendar geometry/gaps, stored grouping, median suppression, online/offline backfill and the measured plot mounting after an initially unmeasured metric.
- 98 API assertions pass, including real Mongo aggregation of null/string/missing/zero metrics, independent counts, account/race/date bounds, query coalescing/date-probe reuse and existing global timeseries behavior.
- Full web/API TypeScript and strict changed web/new API source lint pass. The aggregation file retains its five existing warnings; the extended timeseries method adds none.
- Final required-engine production build and every unchanged budget pass after all review fixes: landing 214.1/215 kB, Today 224.4/240, game 314.6/440 and opponent 490.5/500.
- 96 localhost browser checks pass at 320/390/768/1440 in light and dark, using actual Macro/Builds components, fetch hooks, production CSS and committed fonts. They verify real calendar geometry, gap breaks, sample markers, metric-switch request reuse, opponent-bracket reference, shared grouping, online/offline empty actions, late plot measurement, readable controls and no page overflow. Build mix count text meets at least 4.5:1 computed contrast over its translucent fills in both themes. Inspected screenshots are in `screenshots/mechanics-*.png`.
- Independent API/calendar/reference and UI reviews confirmed the scalar-only aggregation extension, metric counts, calendar geometry and proxy wording. Cached-table-on-404 and conditional plot measurement findings are fixed and covered by regressions; the reviewers rechecked the fixes with no remaining blocker.

Reproduce browser evidence from `apps/web` with `node tests/manual/mechanics-progress.cjs` after building. Auth/API/Next and unrelated MMR panels are explicit synthetic boundaries; non-local requests are blocked and mocked backfill never contacts an Agent. No new endpoint, infrastructure, environment variable, migration, AI feature or budget increase.
