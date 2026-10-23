# Wave 3 card preview/reset/keyboard checkpoint

Isolated `codex/wave3-card-previews` branch in
`C:/SC2TOOLS/.worktrees/wave3-card-previews`, stacked on private scouting #691
`db421836`. Complete final-plan spec, augments (none), audit and howto read for
`agent-gui-expansion-1`. Root owns dependency-order merge and release.

Implementation complete; final full/package/web checks remain: local sample models and preview action isolation,
90-second/Escape lifecycle and immediate real-card replacement; Settings Cards
controls and generic position reset with off-UI persistence; Enter/Down/Up search
flow and unchanged Ctrl+Enter confirmation; actual Qt/runner/state regressions,
help and README updates. Controller business logic is unchanged (verified empty controller diff).

No AI features/calls, new infrastructure, production operations, version bump,
installer execution, signing, tag or release. Private scouting #691 is frozen
clean at `db421836` with current main `b86ca989`; local integrated API133 and help72
pass, both types pass. Exact-head GitHub python/API/web workflows for #691 are
all successful. Expansion focused native/runner/state suite: **187 passed**.

Implemented fixed sample models (known race, default ZvP, Alcyone and scouting),
local action interception with no controller/network/browser work, app-local
Escape/90-second expiry and immediate real-card priority, generic placement reset
and off-UI durable save, Cards controls usable while check-ins are off, and actual
Settings queue URL wiring. The latest accepted replay race is persisted on the
upload worker; older history cannot replace it. Search Enter picks/focuses the
first displayed match, Down focuses without selecting and Up returns to search;
Ctrl+Enter remains the card confirmation shortcut. Help/README/Unreleased entries
are updated. Real Qt regressions include glyph metrics, actions, timer dispatch,
drag/reset, keyboard focus and native no-activation flags. Full suite, frozen
package smoke, screenshots, web checks and draft PR remain required.


## Integrated verification checkpoint

Current main `441582d0` (including merged scouting #691) merged cleanly at
`78032e52`. Source controller business logic is unchanged. All 187 focused checks
pass. The first full suite found one new test's 40 ms fixed wait was too short
for actual Qt timer delivery under package-build load; the other 2,151 tests
passed. The regression now waits for the actual Qt timeout signal with a bounded
1-second deadline and still asserts the production timer is 90 seconds, active,
and closes the card. The timeout/package subset passes **24 checks**.

The offline frozen-GUI diagnostic now actually paints both previews through
production Settings callbacks, in addition to the five pages/Streams check,
without state/service/thread/network bootstrap. Three reviewed native screenshots
are in `docs/handoff/screenshots/desktop-card-preview-*.png`; final chip styling
and final source/full/package/web checks are in progress. Both web types and all
72 help checks passed before the final main integration; rerun after it.
