# Contrast, appearance and the public accessibility gate

ADR 0061 keeps text ink separate from white-label button fills, retunes Light
semantic/race/control tokens and scopes dark replay/Studio previews. The CSS
matrix checks 209 actual token pairs, including a dark replay nested in Light;
its generated table matches docs/design-system.md. Real selected backgrounds
also receive production axe checks. No bundle budget is raised.

ThemeMode adds System while existing resolved Theme stays Light/Dark. One
subscription follows OS changes only in System, synchronizes browser tabs and
updates theme-color. Storage failures do not block a current-page choice or OS
fallback. The pre-paint script shares the same value space. The mobile drawer,
More sheet and supported account-menu action expose all three options; the
compact toggle retains one-press switching and opens options on hold,
right-click or Arrow Down. No account preference or backend is introduced.

The public statement and Help describe the WCAG 2.2 AA target and known limits,
without claiming full conformance. The design-system guide now describes the
actual palette, fonts, tokens, controls, layers, focus, data and motion behavior.
Recommended JSX accessibility rules warn without activating rules disabled by
the upstream recommendation. Named horizontal scrolling regions deliberately
remain keyboard-focusable; their narrow lint comments document this purpose.

An old production baseline collected 114 route/theme/viewport scans with 1598
serious/critical findings, including repeated contrast failures across the 197
definition entries. A wrong Definitions heading expectation was corrected and
its six baseline scans rerun. The first candidate's 126 scans reduced findings
to 62. All 12 actual keyboard/System checks passed; three viewport-inapplicable
cases were skipped. Those findings identified tinted-state pairs, dark Studio
preview inheritance, faded labels, download fills and the nonfocusable timing
table. All were corrected in source for the next complete production scan.

The gate uses axe 4.11 with WCAG 2 A/AA and 2.1 AA tags and rejects serious/critical
nodes. Its exception file starts empty and matches exact route, theme,
viewport, rule and target with a required reason. No rules are disabled. Local
collection mode cannot bypass CI. Automated checks supplement actual keyboard
and visual review; they do not cover every assistive technology or replay map.

The initial production build and every unchanged budget pass, including
Today 238.7/240, Overlay 239.6/240 and widget 323.8/325 kB. Shared theme/chrome,
Help/contrast/carousel checks passed 302; the subsequent rendered fixes and
onboarding/guide checks pass 286 across 21 suites. Full types exposed and fixed
an article block using the wrong list discriminator; strict changed-source lint
passes with zero warnings. Exact-head remote gates remain required before merge.

The complete frozen web run recorded 7,997 passing tests, one expected skip
and four failures in three guard files (861 suites passed). The failures
identified stale Clerk literal colors, two old fill-token expectations in the cascade guard and one
non-US spelling. Clerk mirrors and copy are corrected; cascade tests retain
their ordering/specificity checks while expecting the new ink roles. All 321
final affected assertions pass, including every failed guard and current-main
metadata/cards, Help and the real passive-focus test correction.

The second full production browser run passed 187 cases with 19 intentional
viewport/Clerk skips and one failure: Changelog's lazy Help fallback could be
empty while its module loaded. A 30-load diagnostic reproduced it 29 times.
The shared fallback now has a generic Help label, and Changelog supplies its
specific text explicitly. Its new regression failed before and all 34 affected
Help/import checks pass afterward. There are no allowlist exceptions. Seventeen
synthetic screenshots are saved; five representative phone/desktop
Light/Dark/menu/dialog captures were viewed.

The final production run of public-pages, appearance and public-seo passed
190 cases with 23 intentional viewport/Clerk-fixture skips. All 126 actual axe
route/theme/viewport scans report zero serious/critical nodes. Collection-only
mode was unset; the exception list remains empty. The run used the built
production app, local synthetic API fixtures and Instant Import set to all.
Its 17 new local captures do not replace the 17 reviewed tracked PNGs: every
tracked image hash is unchanged. Four final phone/desktop Light/Dark, menu,
dialog and guide captures were inspected without a visual blocker. Both local
fixture ports were stopped and released after the run.

Reproduce from apps/web with NEXT_PUBLIC_INSTANT_IMPORT=all and
A11Y_COLLECT_ONLY unset:

```powershell
node node_modules/@playwright/test/cli.js test tests/e2e/public-pages.spec.ts tests/e2e/appearance.spec.ts tests/e2e/public-seo.spec.ts --workers=2
```

The final release build and every unchanged performance budget pass, including
Today 238.7/240, Overlay 239.6/240 and widget 323.8/325 kB. The existing 25b
browser-engine artifact was reused without an engine build. A test-only type
correction removes unsupported Testing Library exact options; string role names
still match exactly and all seven affected Help/import checks pass. Final full
web types and strict changed-source lint pass with zero errors or warnings.

Current released main includes Reference editing and the passive opponent
scrolling fix. Opponent order stays Brief, Tendencies, Timings, History, Ladder,
Identity. No engine/native/API, model/provider, account, production-data,
integration enabling, version/release or infrastructure change is included.
