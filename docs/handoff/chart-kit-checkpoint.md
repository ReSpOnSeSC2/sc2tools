# Chart kit checkpoint

2026-10-25, branch `codex/wave5-chart-kit`, worktree
`C:\SC2TOOLS\.worktrees\wave3-game-workspace`, base
`08aebcc218f900c4b1ff7585f71218c47d43da12`.

## Source scope

- Reuse useChartTheme/ChartTooltip/WinRateComparison/QueryState; add the kit,
  memoized resolved colors, frame, table, legend and optional count column.
- Refresh all fallback tokens and add paired series/ramp/neutral CSS colors with
  replay overrides, contrast and color-distance regressions.
- Migrate the nine named MMR/Macro/H2H/form consumers and the matrix ramp.
  Preserve rate denominators, filters, order, domains and game/drill callbacks.
- Keep old hook fields, concrete ramp defaults and exported chart math helpers
  compatible for pending dossier/execution work.
- Update Reading the charts, Charts design guidance, Trends Phase 2, ADR0066 and
  unreleased changelog. This does not complete the wider UI roadmap.

## Validation boundary

Source is implemented and frozen for focused proof. Whole web types passed.
The first bounded unit pack passed 435 tests and exposed two fixture assertions
that expected a thousands separator the existing MMR formatter does not emit;
the new hook suite also failed before registration because jsdom interpreted a
file URL as HTTP. The assertions now match the preserved formatter and the hook
fixture reads its stylesheet from the working directory. The affected two suites
then passed all 17 tests. The final focused pack passed 464 tests across 19
suites, including actual-token contrast/color distance, hook compatibility,
consumer projections, stale-query behavior, table/drill actions and Help.

The new-source lint audit found one named table-scroll region requiring keyboard
focus. Its one-line accessibility-rule exception follows the existing Download
precedent; no global rule was changed. Three inherited label/figure warnings in
modified consumers remain recorded separately. Final new-source strict lint
passes; the changed-source audit has zero errors and those same three warnings:
BattlefieldTab's existing form label and MatchByMatchTimeline's existing
keyboard-enabled figure/tabindex. Whole web types pass again.

All 18 shared UI-rule tests pass. The first scan correctly rejected 59 retired
hex allowances; prune-only removed them without adding an allowance. The final
scan passes over 1,648 source files with 684 inherited occurrences. Help registry
generation reports 89 articles and produces no registry diff. The generated
contrast table includes the four chart text colors and two explicit mark pairs.

Root independently reviewed the kit, frame, comparison samples, tooltip tokens,
matrix ramp, legacy color callsites and color-distance calculations without a
material finding. A single final production build is authorized after focused
tests and actual browser proof pass. Browser proof has passed; production build
has not run for this pack yet. Heavy jobs are serialized (two unit workers, one
browser worker); real accounts/providers and production data are outside scope.

At this checkpoint, every chart runtime job is closed. The isolated actual-
component fixture used one pinned Chromium worker and intercepted every request;
no application server or real API was used. Root will preserve the exact owned
source and merge current main before the single final production build.

## Browser findings and repairs

The sandbox browser failed to launch before fixture rendering; the same pinned
Chromium worked with reviewed host access. Two fixture-only assertions needed
repair: compare exact rendered sRGB channels instead of CSS color serialization,
and fulfill only the synthetic Alcyone LE map-image request with local art. All
other requests stay intercepted and denied. No provider or real API was reached.

All eight browser cases then passed across 320/390/768/1440 in both themes,
including actual axes, tooltip, color, sample, table, keyboard, callback,
reduced-motion and serious/critical axe checks. Human screenshot inspection
nevertheless found a real visual defect at 320px: the optional count column left
the comparison scale too narrow, making endpoint labels overlap. The repair
stacks comparison names above the scale/rate/count on small screens only when
that count column is enabled. Calculations and actions are unchanged. A geometric
browser assertion now checks visible 0/50/100 labels have positive gaps at every
width. The four affected MMR/Macro cases passed again in both themes/all four
widths; all four 320px captures were visually inspected after the repair. The
eight applicable browser cases are green, with 24 unique theme/width captures
and no remaining observed visual defect.

The responsive repair passes 21 affected unit tests and strict component lint;
the final browser-source changes pass full types and strict two-file lint.
The final affected captures are under `apps/web/.cache/chart-kit-browser-host-4`;
H2H/theme/reduced-motion proof is under `chart-kit-browser-host-3`. Earlier
failure traces and captures remain intact. `.cache/chart-kit-owned-paths.txt`
lists the 40 semantic source paths; Help's generated index has only
normalization/stat churn and an empty normalized diff.

Logs are retained in `apps/web/.cache/chart-kit-final-{types,new-lint,owned-lint,units}.log`,
`chart-kit-ratchet-{rules,prune,final}.log`, `chart-kit-help-generation.log` and
`chart-kit-contrast-table.md`. Initial failed fixture logs remain preserved too.

## Build asset boundary

The direct Next build reuses this checkout's retained engine 1.6.12 bundle
`fc21ebe5bf52a53c` (manifest metadata agent 0.24.6); chart source changes do not
change the engine. Root approved preserving that exact cache and pointer without
compiling or copying engine assets. Production's separately hash-verified
`dbb0c612b7e7fab6` bundle includes agent 0.24.7 metadata/platform output. This local
chart proof does not replace the separate production engine/release proof.

The delegated worker owns six MMR/H2H consumers, their tests and the isolated
browser fixture/spec. The parent worker owns the kit, tokens, Macro/Score/Form,
matrix bridge, documentation and final integration. No Git mutation or external
write has been performed by this workstream.
