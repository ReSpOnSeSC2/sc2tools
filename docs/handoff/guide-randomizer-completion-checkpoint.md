# Guide glossary and randomizer accessibility completion

Source candidate prepared 2026-10-28 on `codex/guide-randomizer-completion`,
using the repaired Help source at `97eca05c` after the original477298dd fork.

This slice addresses the remaining source gaps for `builds-polish-7` and
`guides-polish-4`. Local tests, types, strict lint, production build, all83
unchanged budgets and scoped browser/accessibility checks have passed.
Exact-head CI, merge and production acceptance remain pending.
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
Both Help articles and the changelog describe the new behavior.

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

## Unchanged build-guide budget correction

The combined d4ee182d production build measured the build guide at 175,467
first-load JavaScript bytes against its unchanged 175,000-byte cap. The parent
Help build measured 173,692 bytes. The failed build, all83 budget rows and prior
source proofs remain preserved. The dictionary was already lazy: its new
definitions were absent from the initial route chunks. The added initial
InfoTip/Popover client boundary in the collapsed server legend caused the
regression.

The guide-only boundary now keeps the readable server label and native
disclosure, and imports the unchanged real Term only after the legend is first
expanded. It shows truthful loading/failure/Retry states if that code is held
or unavailable; no pretend InfoTip button is rendered. Successful Retry may
return focus to the real named trigger only while that retry still owns focus
and no newer modal forbids it. Closing the disclosure or leaving the page never
auto-opens a tip. Once loaded, the existing Term, InfoTip, glossary retry and
Help/focus behavior remain intact. All three glossary definitions and all motion
changes stay present. Client code receives only the small copy strings, rather
than importing the server's guide-copy templates.

This optimization is a source candidate. Its focused tests, types/lint, rebuilt
all83 unchanged budgets and renewed actual browser proof still need to run;
no reduction is claimed from source analysis alone.

Independent source review additionally found that a rejected or timed-out Retry
replaced its focused button without restoring focus. The same scoped ownership
guard now restores the newly rendered Retry on failure as well as the actual
Term trigger on success. Regressions cover both failed retry outcomes, retained
late-result retirement and the existing newer-modal focus guard. No prior
assertion or test was removed; this source delta still requires verification.

## Current verified candidate

This section supersedes the pending local-verification wording above. The
final guide delta passes26 focused tests, fresh whole-web types and strict
lint on all30 owned TypeScript files. The preceding unchanged Randomizer
source passed443 tests in61 suites. No combined total or full-suite rerun is
claimed for the final guide delta.

Production build03 (`NuzyJUn7-az5xw0eEoVMe`) passes all83 unchanged route caps:
18 explicit and65 default caps. The build guide measures174.3 kB under175 kB.
The original175,467-byte failure and a later sandbox EPERM failure are
retained; the latter was rerun with the identical source and normal build
command outside the restricted sandbox. No asset generation, download,
pruning, dependency change or cap adjustment was used. Prebuild, postbuild
and postbrowser guards admit all40 canonical inputs, seven assets and the
four-game sample unchanged.

The new guide-only browser run03 passes24 cases and54 full WCAG A/AA scans
at320/390/1280 in both themes. It uses real React SSR/native disclosure,
held hydration and the actual separately loaded Term module. Repeated
transport failures are explicitly labelled promise-transport fixtures, using
the real component/Term/InfoTip lifecycle. They do not claim native ESM can
retry a cached rejected import. Deadline/late-result retirement, repeated
retry failure/success, closed disclosure and newer-modal focus all pass.
Runs01/02 preserve a fixture API mistake (`hidden` instead of Playwright's
`includeHidden`). Final checks inspect exact hidden DOM while closed, then
require the real accessible role/name after reopening; no assertion is lost.

A pinned27-input comparison supports reusing only12 prior Randomizer cases,
72 AA scans and132 style specimens. The prior six guide cases/24 scans are
superseded by the new24/54; they are not counted as rerun. Independent source
and browser reviews, budget rows and six current guide screenshots are in
`validation/guide-randomizer/`. All owned browser/build commands exited;
no application listener, native process or provider mutation was introduced.
The two roadmap items remain partial until actual CI and delivery pass.

## Final UI-ratchet repair

CI atcfce71a3 caught one new hardcoded muted label color in SpriteLegend.
The final label uses its existing light arena color. Strike-through and
icon-only fading retain elimination distinction while increasing contrast;
layout, motion, odds and selection are unchanged. The official prune command
removed only the now-retired old `#7d8595` debt allowance (one occurrence,
seven baseline lines). No UI rule, HEX allowlist, assertion or allowance was
added or relaxed. The original CI failure and intermediate stale-allowance
failure remain in the local packet.

All19 UI-rule checks pass. The complete ratchet passes1,768 source files and
638 existing occurrences with no new or stale allowance. Four actual-color
contrast cases, strict SpriteLegend lint and fresh whole-web types pass.
Production build04 and all83 unchanged budgets pass again, with40 canonical
inputs/seven assets/four sample games admitted before and after build/browser.

Fresh Randomizer run06 passes12 cases/72 full AA scans and132 all-style
OS/page-motion specimens. Its current33 source pins and27 runtime/style inputs
are in `validation/guide-randomizer/randomizer-final-white-independent-review.json`.
The guide's24 cases/54 scans are retained separately through21 consumer and
five CSS/font exact matches; they were not rerun after this color-only repair.
The previous whole32-file snapshot is not described as wholly unchanged.
Current screenshots carry the `final-` prefix. CI, merge and actual production
acceptance remain required before completion.
