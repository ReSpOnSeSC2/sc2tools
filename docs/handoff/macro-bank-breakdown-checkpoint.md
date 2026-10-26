# Macro Bank breakdown

2026-10-26. `codex/fix-macro-bank-breakdown`, based on `dce88719`.

Bank offers Total (default), Minerals and Gas within the existing metric
multi-select/All controls. Its validated device preference is saved separately.
The selected-time panel and hover card show all three values for both players
from the roster's prior sample. Components stay independent; Total requires
both. Measured zero remains zero and missing/invalid data stays unknown.
Changing resource view preserves inspection time, roster and existing in-place
graph seeking. Modal and full-game Macro share this implementation.

The roster Army caption now uses the existing neutral text utility for both
sides; colored card borders and numeric values are unchanged. This repairs the
first browser accessibility failure without requiring a new CSS utility.

Validation at `67131607`: whole-web types passed; UI rules 19/19 and the
unchanged ratchet passed; focused web tests 108/108 and Help tests 46/46 passed.
Strict lint retained one source-supported inherited Supply blocks label warning
as a separate raw exit1. The host direct Next build generated 145 pages; all 81
unchanged route budgets, post-build types and own asset pre/post checks passed.
Build `wRb84uDIwOd8STObHsL8o` preserves canonical source 40, retained assets 9 and
sample games 4. No API, engine or agent release changes are needed.

Final repair checks: roster tests 14/14 and strict single-file lint passed at
`56ec58cb`; TimelineControls strict lint passed at `d1d5511a`. The final four
shared-chart cases (light/dark, 320/1280) passed with eight shared AA scans and
no issues. The fixture closed after 89 loopback GETs with no unknown/writes;
browser ledgers and owned host listeners were clear. Root reviewed all four
captures: phone resource buttons fit one row and 600 stays readable with the
lead below; desktop remains clear.

This proof explicitly bridges current `d1d5511a` source to original `67131607`
build/CSS, not a build of the later class-only repairs. It does not establish
fresh full-game/modal E2E coverage. Missing, zero and invalid resource cases
remain unit evidence. Final cached evidence is
`.cache/macro-bank-browser-d1d5511a/final-receipt.json`.

Combined PR780 web CI at `4d01aa81` reported 9,157 passed, two failed and one
skipped. Both failures came from the APM test's `dd.flex-wrap` selector also
matching the newly wrapped instantaneous values. The helper now anchors to the
game-average definition and reads the following pace definitions. Both exact
expected average strings and all assertions are unchanged. Focused APM validation
at `93e8d225` passed 18/18 tests and strict single-file lint; no metric or product
source changed.

First failures remain under `.cache/macro-bank-static-prep-17e3b95d/results/Types/`,
`.cache/macro-bank-build-prep-67131607/first-red-receipt.json` (sandbox EPERM),
and `.cache/macro-bank-browser-67131607/first-red-browser-receipt.json`.
The shipped scope is 15 paths including the existing CompositionSnapshot and APM test files.
No new Help path was added, so Help index generation is unnecessary.
