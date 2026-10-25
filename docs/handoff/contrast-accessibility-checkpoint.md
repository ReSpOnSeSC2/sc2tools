# Contrast, appearance and the public accessibility gate

ADR0061 keeps text ink separate from white-label button fills, retunes Light
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

The public statement and Help describe the WCAG2.2AA target and known limits,
without claiming full conformance. The design-system guide now describes the
actual palette, fonts, tokens, controls, layers, focus, data and motion behavior.
Recommended JSX accessibility rules warn without activating rules disabled by
the upstream recommendation. Named horizontal scrolling regions deliberately
remain keyboard-focusable; their narrow lint comments document this purpose.

An old production baseline collected 114 route/theme/viewport scans with 1598
serious/critical findings, including repeated contrast failures across the 197
definition entries. A wrong Definitions heading expectation was corrected and
its six baseline scans rerun. The first candidate's126 scans reduced findings
to62. All12 actual keyboard/System checks passed; three viewport-inapplicable
cases were skipped. Those findings identified tinted-state pairs, dark Studio
preview inheritance, faded labels, download fills and the nonfocusable timing
table. All were corrected in source for the next complete production scan.

The gate uses axe4.11 with WCAG2A/AA/2.1AA tags and rejects serious/critical
nodes. Its exception file starts empty and matches exact route, theme,
viewport, rule and target with a required reason. No rules are disabled. Local
collection mode cannot bypass CI. Automated checks supplement actual keyboard
and visual review; they do not cover every assistive technology or replay map.

The initial production build and every unchanged budget pass, including
Today238.7/240, Overlay239.6/240 and widget323.8/325kB. Shared theme/chrome,
Help/contrast/carousel checks passed302; the subsequent rendered fixes and
onboarding/guide checks pass286 across21 suites. Full types exposed and fixed
an article block using the wrong list discriminator; strict changed-source lint
now passes with zero warnings. Final production, full-suite, visual, independent
review and exact-head remote gates remain required before merge.

Current released main includes Reference editing and the passive opponent
scrolling fix. Opponent order stays Brief, Tendencies, Timings, History, Ladder,
Identity. No engine/native/API, model/provider, account, production-data,
integration enabling, version/release or infrastructure change is included.
