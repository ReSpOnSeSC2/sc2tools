# Macro Breakdown build selection

The owner accidentally selected a planned build and requested the same editing
controls directly in Macro Breakdown. A Planned badge is a confirmed check-in,
separate from the replay's detected label; changing detection rules does not
clear that choice.

## Behavior

- Both the standalone macro-score popup and the full game page's macro section
  show Build selection. Change build opens the existing real BuildCheckInCard
  within that surface. Its Change/Confirm, No set build, opponent correction,
  notes and Add new build flows remain authoritative.
- The heavy card/picker/editor module and check-in request load only on explicit
  intent. The macro body remains read-only/reusable for public and offline views.
  Build editing remains available when macro data is loading, missing or fails.
- Owner/game keys reset local editor/draft/import state. Default-expanded,
  request-state and heading-level card props are additive; existing card defaults
  retain their behavior. The macro section/card use h3/h4 under its h2.
- Closing or retrying modules/requests preserves useful keyboard focus, with
  no late focus steal after a user moves elsewhere. Chunk waits are bounded,
  failed imports have a fresh Retry, and nested Add new build Escape leaves the
  macro popup open.
- Existing shared SWR/provider revision refreshes the header, sibling cards and
  context; the inline macro callback also refreshes the game summary. Existing
  server games-changed events refresh lists and statistics. No endpoint added.

## Save ownership and duplicate editors

The reused write hook now scopes authentication, dispatch and completion to the
owner/game, including A→B→A and unmount. Its twenty-second deadline covers JWT,
fetch and response body; AbortSignals are transport options, not JSON fields.
Active-only owner/game pending claims disable duplicate writes across editor
instances and use entry identity so retired cleanup cannot unlock a new write.
There is no permanent game cache or new backend state.

Retired work emits no stale toast, state, callback or revision. Successful saves
bump shared revision before external toast/caller callbacks, preserving queue
unmount notification; subsequent delivery rechecks scope. Failures and custom
copy callbacks have the same retirement guards.

## Verification

- 178 focused checks across13 suites pass: real card/actions/queue consumers,
  read/write owner/game/ABA/deadline and synchronous callback retirement,
  duplicate pending state, retry/focus and Macro availability through errors.
- Real SWR/full game-page integration proves macro saves update the planned
  header and sibling card, and No set build restores the detected label. Those
  two checks passed again after a test-only typing correction.
- Full web types and strict21-file source/test/manual lint pass. The final two
  changed manual fixture files also pass strict lint.
- Production build and all unchanged budgets pass: Today238.8/240kB, game
  313.4/440, dossier452.5/500, overlay239.7/240 and widget323.8/325. Required
  engine25b300818c31d41b (1.6.12/Python3.14.2) rebuilt and smoke-checked.
- 242 browser assertions across320/390/768/1440, both themes and inline/modal
  views pass using actual components/client API/SWR, real production CSS/fonts
  and synthetic loopback endpoints. No unexpected/external requests or page
  errors; browser/server stopped. The first harness failure was a synthetic
  Next dynamic loading callback missing its real props; only the fixture was
  corrected before the green matrix.
- Root inspected the light320 inline, dark320 modal and light1440 modal
  captures, which are checked in. Sixteen final captures and logs remain in
  `.cache/macro-build-selector-*`. A separate failure capture is not a final
  product screenshot.

No production game/check-in was edited, no replay reanalysis was requested and
no new service, release, version or tag was created. Final current-main merge
proof and exact-head CI remain required before shipping.

The game-page and build-check-in Help articles now document correcting an
accidental selection, including No set build and the Macro Breakdown editor.
All 77 Help checks pass; the 88-article generated index remains unchanged,
and both edited articles pass strict lint.
