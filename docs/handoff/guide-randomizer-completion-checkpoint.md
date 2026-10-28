# Guide glossary and randomizer accessibility completion

Source candidate prepared 2026-10-28 on `codex/guide-randomizer-completion`,
based on `477298dd7c397af2baaa79d19736ae43d1a4510d`.

This slice addresses the remaining source gaps for `builds-polish-7` and
`guides-polish-4`. Bounded local tests, types and strict lint have passed;
production build, budgets, browser and deployment acceptance remain pending.
Root owns the roadmap ledger and release receipts.

The existing randomizer motion hook now combines the OS preference with the
root `data-motion="reduce"` preference, including changes while open. All
eleven build reveal styles pass that result to the shared winner card. Reduced
winners use a 200 ms opacity transition without pulse, zoom, overshoot or
confetti; Gacha also keeps its charging orb and beams still. Matching injected
CSS covers the OS and page preference before the hook updates. Normal reveal
timings, sound configuration, winner, odds, filtering, persistence and widget
URLs keep their existing contracts.

The stage publishes a screen-reader status only after the current reveal
completes: build name, rarity and full-pool probability. A keyed spin resets
the status before paint. Retired or duplicate completion callbacks cannot
announce a new spin or complete its caller. The reveal frame owns the live
region, and the caller's completion still runs once.

The guide legend uses the existing Term/InfoTip primitive for Likely range.
The import-free glossary adds likely-range, publishing-floor and trend-arrow,
with links to the existing reading-guide-stats anchors. Numeric floors and
trend thresholds remain in their existing constants and legend/Help copy.
Both Help articles and the changelog describe the delivered behavior.

Scoped regressions cover motion preference changes, reduced and normal winner
styles, CSS fallbacks, Gacha completion, every reveal style's announcement,
repeat spins, late callbacks, full-pool odds, the real glossary tip and Help
link parity. Existing catalog-count assertions are updated to include all
three new terms; no assertions or tests are removed.

## Bounded local verification

Root granted the serialized local slot. The final run used the already
installed dependencies at
`C:/SC2TOOLS/.worktrees/handoff-ci-repair/apps/web/node_modules`, through this
checkout's owned junction. It downloaded or changed no dependencies.

- All **439 tests in 60 suites** passed with at most two workers. This includes
  the actual guide page/one-legend contracts, existing InfoTip interaction,
  guide copy/constants, Help links/search/rendering, full-pool randomizer
  behavior, real reduced-motion hook and Gacha, and every style's resolved
  announcement plus repeat-spin/retired-callback regressions.
- Fresh whole-web `tsc --noEmit --incremental false` passed.
- All **24 owned TypeScript files** passed strict lint with zero ESLint
  warnings or errors. Next's existing CLI deprecation and multiple-lockfile
  notices are preserved in the log; no source/config workaround was applied.
- `git diff --check` passed before verification. All tool-managed test/type
  sessions exited, and no browser, server or listener was started by this
  verification. The dependency junction remains for root's next checks.

Evidence is in `.cache/guide-randomizer-verification-20261028/`. The initial
older dependency tree passed the scoped tests but lacked `@axe-core/playwright`
for whole-web types. That failed type log and the dependency comparison remain
preserved. Because its Next version also differed, the complete 439-test scope
was rerun successfully using root's exact retained dependency tree before the
fresh type and lint checks. No assertions or types were weakened.

The source/file hashes and queued build/budget/browser commands are recorded in
`.cache/guide-randomizer-implementation-ready-20261028.json`. No commit or push
was performed. No API, agent, native, engine, provider, infrastructure, product
flag or Macro changes are included.

## Browser-discovered contrast correction

The first browser AA run found an eliminated Oracle legend label at 2.31:1:
the previous label colour was compounded with 0.55 opacity on its entire pill.
The source candidate now keeps the strike-through, moves fading onto the icon
alone and uses readable muted label text. A focused regression reads actual
component colours and tests normal/highlighted, active/eliminated combinations
against the dark arena surfaces. The failed browser evidence remains preserved;
the new delta still requires its scoped test, type/lint and browser validation.
No assertion or accessibility check is removed or excluded.

## Page-only and live motion preference correction

Browser run 03 passed all eleven OS-reduced reveal styles, then detected a
running transform transition under page-only reduction. The focused run 04
identified HorseRaceReveal's Racer scaling from 1 to 1.2 with its hardcoded
300 ms transform transition after the winner was visible. The diagnostics and
failed evidence remain under the browser reviewer's retained run directories.

Source inspection also found unconditional chip/auxiliary transitions in
Fighter, Sumo, Asteroid, Swarm and Claw. The product RevealFrame now supplies a
scoped class whose descendants disable transitions under either OS reduction
or `[data-motion="reduce"]`. This immediately cancels existing transitions
when the preference changes, before the hook update. The winner's later,
equally specific override keeps only its allowed 200 ms opacity transition.
Static placement transforms, normal reveals and fixture styles are unchanged.
Regressions assert the scope on all eleven frame paths and both CSS preference
fallbacks. This new delta still requires fresh unit/type/lint and actual browser
validation; older successful receipts do not qualify the changed source.
