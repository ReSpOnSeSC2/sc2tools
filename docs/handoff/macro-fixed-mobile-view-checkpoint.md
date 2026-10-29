# Fixed mobile Macro overview

Status: delivered as PR814 at main `0b90c1b8`; local phone and actual desktop acceptance recorded.

The owner's latest correction supersedes PR812's adjustable overview: mobile
Macro should stay at 50%, with no Fit, plus, minus, percentage or zoom-help row.
Army, Workers, Supply, Income, Bank, APM and All stay on one compact row; narrow
screens can scroll that row horizontally. The original metric selection and
keyboard behavior remain.

The modal overview uses a fixed local transform. Its logical width follows twice
the available width, keeping the chart and both army columns inside the phone.
Logical roster targets are 48px so they remain 24px at 50%. Metric, bank,
supply-block and Close controls, and unit-detail portals, remain unscaled.
Dense content retains its reachable local scroll region. Desktop and full-game
views retain their existing sizing. Document zoom, viewport metadata, account
preferences and passive page scrolling are unchanged.

The former zoom-specific unit assertions are replaced to reflect the owner's
explicit removal of that feature. Selection, focus, orientation, late-data,
game-change, reopen, global-style and unsupported-observer coverage remain.
Modal close/navigation restoration tests are preserved. The original prerelease
requirements and the completed local/production checks are qualified below.

Base: delivered main `dfe4d6234e9242bad9ff5d4a52ad2e36cbb7bc78`.
Cache: `C:/SC2TOOLS/.cache/macro-fixed-mobile-view-20261028`.
All original budgets and engine assets remain protected. No API, native-agent,
flag, provider or infrastructure change is part of this correction. The program
remains incomplete at 124 complete / 53 partial / 20 open (73 unfinished).

Verification and delivery
-------------------------

One current focused run passed 132 cases in 13 files, whole-web types and strict
lint for nine owned files. Its 3,535 web inputs match clean `5d5bbc0`. Direct Next
Build03 passed all 83 unchanged budgets with 6,994 source files and unchanged
40/7/4 asset guards. Browser03 passed all four original cases and 16 full-default
Axe scans with zero violations; all eight LOCAL captures match raw attachments.
The keyboard repair reveals the full focused metric locally and confines plain
vertical keys to an overflowing overview after child handlers.

Exact-head CI subsequently passed 10,089 web tests (one existing skip) and 591
responsive cases (92 existing skips). The squash tree equals tested `5d5bbc0`.
Actual Production Ready/main and primary-domain checks accepted the 1920x1024
desktop view. Escape restored focus in the immediate observation; a later null
accessible label is preserved, so sustained focus is not claimed. Close restored
focus and exact page position, and actual full-game navigation retained normal
global viewport/zoom state. A full-game accessible-name observer miss remains.
Both owned production tabs closed; no private account/game values or images
are included in the sanitized receipt.

Earlier 126-case checks, pre-keyboard builds and phone diagnostics remain
historical. Source03 passed 132 cases but had three type errors and one lint
warning; source04 reran all three checks successfully. The first postbrowser
asset command omitted its snapshot argument; the corrected call passed. Two
historical process unknowns were explicitly absent, including potential
orphans; current owned/unknown/listener counts were zero, without kills. The
first CI deadline cancellation remains beside its successful unchanged-head
retry. Local fixtures do not exercise actual Next routing or production phones.
No roadmap status or requirement changes in this documentation.
