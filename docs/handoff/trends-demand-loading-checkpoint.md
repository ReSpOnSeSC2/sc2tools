# Trends charts on demand — handoff

Canonical item: `faster-dashboards` (Wave 5), web demand-loading portion.
Worktree: `C:\SC2TOOLS\.worktrees\wave3-my-reviews`; branch:
`codex/wave5-trends-demand-loading`. Authored scope is 14 text paths, including
four product files. Six historical screenshot paths remain absent; the browser
plan reserves six cache captures for review. No screenshot delivery is claimed.

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

## Browser results and pending chart repair

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
cases; paired work remains unrun. Two AA scans completed (initial: no serious
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
17 did not run**, zero retries/flaky cases; paired work remains unrun. Initial
AA reported no serious issues (contrast incomplete); Time AA was not reached,
so the chart AA repair is not browser-proved. Eight GETs settled (two cold, two
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

The proposed spec correction retains the first passive gesture and cold ledger,
waits for the admitted above-card PvZ rating UI/data and settled reads, then uses
the same native passive gesture to continue reading Performance at its real
position. All original nav/focus/URL/filter/retention assertions, the 5s highlight
assertion and 120s case bound remain. This checks final navigation against the
rendered viewport instead of a transient label during expansion. **Browser
validation of this correction is UNRUN.** Product/fixture/configuration,
assets, budgets and calculations remain unchanged by this test correction.

## Remaining validation and delivery

Root owns review, commits, runtime grants and delivery. Preserve the old 857,
f713, 40fa and diagnostic packets. After accepting the spec/checkpoint proposal,
refresh the explicit current-source → retained-857 bridge for the test-only
change, retaining the one chart's attribute/class proof and fixture/checkpoint
allowlist. Production source is not wholly unchanged; do not relabel the retained
build as a new build. Admit complete CSS filename
sets/bytes, fonts, Chrome, current source and exact concrete output paths.
LIST/RUN reporter JSONs must have separate filenames. Keep CI=1, truly remove
A11Y_COLLECT_ONLY/TRENDS_LIST_ONLY, and retain one worker, zero retries and
maxFailures=1. Preserve first RED and positive owned identity/listener closure.

The main plan remains 18 cases, 30 shared serious/critical AA scans and six cache
captures across 360/768/1280, light/dark, personal/global, navigation, retention,
owner retirement and Retry. Paired work remains two cases/four fresh UTC contexts,
personal/global dark desktop; only two raw-hashed legacy product files differ.
Its cold → filter → Performance → Inspect sequence is not full traversal. Keep
actual GET owner/path/query/phase/settlement and static-resource ledgers separate;
no measured saving exists yet. Framework/auth and unrelated Help/report leaves
are adapters. AA is not universal accessibility proof. Page/HTTP ledgers do not
instrument native invocations, sockets, beacon or clipboard.
