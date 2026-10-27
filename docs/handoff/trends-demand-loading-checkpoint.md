# Trends charts on demand — handoff

Canonical item: `faster-dashboards` (Wave 5), web demand-loading portion.
Worktree: `C:\SC2TOOLS\.worktrees\wave3-my-reviews`; branch:
`codex/wave5-trends-demand-loading`. Authored scope is 15 text paths and six
approved PNG captures, including five product files. Light/dark captures at
360/768/1280 are delivered in `docs/handoff/screenshots/trends-demand-*.png`;
their raw originals and proof packets remain preserved.

## Behavior

Summary, Games played and Win rate stay immediate. Lower charts activate on
approach (400px margin), explicit Load or section navigation, then retain their
controls while scrolling. Missing/unusable observation falls back to usable
content. Explorer preserves its true viewport signal for existing polling;
forced admission does not keep that signal true indefinitely. Existing collapse
storage and unmount semantics remain.

Passive scroll/resize observation changes only the section-nav highlight.
Explicit jumps alone admit/open destinations and own heading focus/scroll.
Retired callbacks cannot enqueue focus. The outer Explorer heading now uses
`trends-explorer-section-heading`; the real card's original heading ID remains.
No chart calculation, request-path builder, owner/filter API, server cache,
Settings, infrastructure or performance budget changed. This does not complete
the parent item's API-cache, lighter `/me`, device-auth or local-corpus work.

## Verified static result — exact historical source

At `93a94950772f358cf02f2a1672d2333d567a46f2` (tree
`f8b7e15536ae1dcadb201c4037da314c7c5ebff4`, base `9a68c480`), the retained
static run passed **219 tests across 19 files**, whole-web types, strict lint
for 11 files, Help rendering (92 articles) and 19 UI rule tests. The UI ratchet passed with 1,704
source files and 639 existing occurrences. These results apply to that exact source;
they are not proof of a later documentation or fresh-main integration commit.

Actual records are in `.cache/trends-demand-static-prep-93a94950/static/`:
`stages.json`, `units-results.json`, `units.log`, `types.log`, `strict.json`,
`help-determinism.json`, `ui-rules.log` and `ui-scan.log`. All six stages exited 0.
The MediaQueryList fixture amendment is included in this passing run. The two
earlier 218-pass/1-fail attempts and their raw repair records remain preserved.

## Production result — exact integrated source

Main `8a810711` was merged into this branch as `85748408948b3bc4cee8ee6f74923677d9425271`
(tree `655fde36542e0cef771f09f263e640e611d43ff3`). At that exact source, installed
Next built **145 pages**, all **81 unchanged route budgets** passed, and post-build
web types exited 0. BUILD_ID is `1TVmStDDPgYRFGOqDzOSR`. The production packet is
`.cache/trends-demand-production-prep-85748408/`; the earlier 93 packet and its
historical static proof remain preserved.

The build used the nine official dummy/local flags without npm prebuild,
generation, downloads, copying, pruning or installation. Own asset guards passed:
40 canonical engine inputs, five active assets, nine retained files and four
sample payloads. Source/browser guards passed 379 source pins, 22 browser pins,
the complete four-file CSS set, three fonts and full Chromium 1228, with clean
tracked source and no unknown untracked paths. Known Next/Browserslist/lint
warnings and local API `::1:8080` refusal remain raw; backend availability and a
warning-free build are not established. No historical 219-test run was repeated.

## Browser history and verified result

Actual discovery confirmed **18 main cases** and **two paired cases**. The first
main mobile/light case timed out at the fixture's Trends-heading wait:
**0 passed, 1 failed, 17 did not run**, zero retries/flaky cases. No AA scan,
capture or paired measurement completed. The main packet preserves that first
RED and its successful source/asset postguards; all 26 observed identities,
including postguard drivers, retired with no owned listeners.

A separate unchanged-fixture diagnostic captured **`ReferenceError: process is
not defined`** after 707ms, before mount/API reads. Its four document/CSS/script/
font GETs returned 200; cleanup closed the loopback server. Raw event ledgers,
HTML and the original failure are retained under
`C:\SC2TOOLS\.cache\trends-startup-diagnostic-85748408`; all 13 observed diagnostic
identities retired. The diagnostic is not a feature pass.

The fixture-only repair adds the established whole `process.env` browser literal
fallback while retaining its specific defines, real code, adapters, 120s bound
and assertions. Cleanup now includes existing page-error/resource ledgers;
startup errors and actual server/socket-close behavior remain unchanged. Its
HTTP-only coverage comment no longer claims native/socket instrumentation.
At `f713e621`, all four syntax checks (three helpers plus fixture), fixture-only
strict lint and fresh 18/2 discovery passed. The retained-857 build bridge verified
379 source/24 browser pins and 377 unchanged selected rows.

The retry loaded successfully, then the first mobile/light case failed after
2,777ms at the Time AA gate: an aria-labeled chart div lacked a valid role, and
the View opponents caption's 80% opacity yielded 4.26 contrast instead of 4.5.
Main result remained **0 passed, 1 failed, 17 did not run**, zero retries/flaky
cases; paired work was unrun at that stage. Two AA scans completed (initial: no serious
issues, contrast incomplete; Time: two serious issues, ARIA/contrast incomplete)
and one early 360px light capture was retained. All 13 GETs settled: two cold,
two filter, four passive, five Time; zero page errors, unknown HTTP requests or
rejected writes. Cleanup closed the server. The f713 packet and decoded AA/GET
ledgers under `C:\SC2TOOLS\.cache\trends-browser-retry-host-f713e621` preserve the
first AA RED; source/asset postguards passed and all 30 observed identities,
including postguard drivers, retired with no owned listeners.

At `40fa9098`, chart strict lint exited 0 and all five existing render/drilldown
checks across two files passed. The two attribute/class changes introduce no
new CSS utility, handler, data or calculation change. The next main run stopped
at the original passive Performance highlight assertion: **0 passed, 1 failed,
17 did not run**, zero retries/flaky cases; paired work was unrun at that stage. Initial
AA reported no serious issues (contrast incomplete); Time AA was not reached,
so the chart AA repair was not browser-proved at that stage. Eight GETs settled (two cold, two
filter, four passive), with zero page errors/unknown HTTP/rejected writes and
one early capture. Final source/asset guards passed; all 32 observed identities
including postguards retired with no owned listeners.

One separate read-only geometry diagnostic passed in 1,791ms, without replacing
that RED or establishing a feature pass. The admitted Matchup trends card grew
720→1,214.125px, pushing Performance down 494.125px at unchanged scrollY 2,329.
Its heading moved 116.84→610.97px below the nav threshold 203.59px; the highlight
briefly read Performance, then correctly returned to Overview. Focus stayed on
the unrelated input. The diagnostic's 15 observed identities retired; raw samples,
images and cleanup are in `C:\SC2TOOLS\.cache\trends-passive-geometry-diagnostic-40fa9098`.

The committed spec correction retains the first passive gesture and cold ledger,
waits for the admitted above-card PvZ rating UI/data and settled reads, then uses
the same native passive gesture to continue reading Performance at its real
position. All original nav/focus/URL/filter/retention assertions, the 5s highlight
assertion and 120s case bound remain. This checks final navigation against the
rendered viewport instead of a transient label during expansion. The full 60f
browser matrix below now validates this correction. Product/fixture/configuration,
assets, budgets and calculations remain unchanged by this test correction.

At `42a00175`, the updated spec passed strict lint and discovery still listed
18 main/two paired cases with unchanged titles. The browser run passed the
mobile light personal and global cases, then stopped at dark Time AA:
**2 passed, 1 failed, 15 did not run**, zero retries/flaky cases; paired work was
unrun at that stage. Six AA scans found one serious contrast issue on the 4,150 MMR headline
(#157d8c on #0f141c, 3.82 instead of 4.5), with incomplete findings retained in
raw receipts. One early capture and the three case ledgers are preserved under
`C:\SC2TOOLS\.cache\trends-browser-retry-host-42a00175`; their 15/18/13 API reads
settled with zero page errors, unknown HTTP requests or rejected writes. All
servers closed, source/asset postguards passed and all 37 observed identities
including postguards retired with no owned listeners.

Source review confirms a text-token mismatch: useChartTheme reads DOM tokens,
so no missing ThemeProvider is involved. `--accent` is a filled-control color;
`--accent-ink` is the existing label/text color in both themes. The MMR repair
changes only the Last recorded/Latest average item's color to
`rgb(var(--accent-ink))`. Series/marker colors, peak/success, trough/danger,
values, calculations and handlers remain unchanged; no CSS class, import or hook
is added. At `60f7ede9`, this file passed strict lint with zero errors and
warnings. No mirrored style unit was added or repeated.

At exact `60f7ede934578d09861154e1abaaf702116b71b4` (tree `affc0bbd`),
all **18 main and two paired browser cases passed**, with zero skips, retries,
flaky or unexpected results. All **30 shared AA scans reported zero issues**;
incomplete checks remain recorded (`color-contrast` in 30 scans,
`aria-prohibited-attr` in 24), so this is not universal accessibility proof.
Root viewed and approved all six light/dark 360/768/1280 captures. Source and
own-asset pre/postguards passed: 15 owned paths, 379 source/24 browser pins,
374 selected rows unchanged from 857, complete CSS4/fonts3/Chrome, 40 engine
inputs, five active assets, nine retained files and four sample payloads.

Main ledgers recorded 360 API reads, including three intentionally aborted,
unsettled old-owner held reads (one retirement case per viewport); the other
357 settled. There were zero page errors, unknown HTTP requests or writes;
96 static-resource GETs stay separate. All 18 main and two paired loopback
servers closed. A final positive host probe retired all **118 observed
identities**, including final postguard drivers, with no relevant process or
owned listener. The exact receipt and raw ledgers are under
`C:\SC2TOOLS\.cache\trends-browser-retry-host-60f7ede9` (`final-receipt.json`,
`case-aa-http-ledgers.json`, `observed-results-summary.json`); the preserved
summary correction only fixes empty-array counting, not raw AA findings.

Paired observations used four fresh UTC contexts, personal/global dark desktop,
and changed only two raw-hashed legacy product files. For the bounded
cold → filter → Performance → Inspect sequence, personal GETs were **24 → 10**
(cold/filter 12 → 3 each); global GETs were **22 → 10** (11 → 3 each).
All paired reads settled. This sequence is not full traversal or a universal
speedup measurement.

## Remaining delivery and proof limits

Root owns commits, fresh-main integration, PR and CI. This delivery preparation
changes only this checkpoint and raw copies of the six approved captures;
product/test source remains exact 60f. The browser freshly rendered that source
with retained OWN 857/tree655fde/BUILD_ID `1TVmStDDPgYRFGOqDzOSR` CSS/fonts;
it does not establish a new 60f Next build. The admitted five-path bridge covers
Net MMR attributes/class, MMR headline text-color value, fixture, spec and this
checkpoint. Historical 219/19 static proof remains tied to 93a94950; earlier
RED/diagnostic packets and build-warning/backend-availability limits remain.

Future integrated-head guards must refresh documentation/screenshot ownership
and changed upstream inputs; they must not relabel this source-bound proof.
Framework/auth and unrelated Help/report leaves are adapters. Page/HTTP ledgers
do not instrument native invocations, sockets, beacon or clipboard.
