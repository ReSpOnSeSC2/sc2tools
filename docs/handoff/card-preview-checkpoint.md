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
