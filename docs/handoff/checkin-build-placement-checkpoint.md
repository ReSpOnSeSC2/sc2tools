# Check-in build action placement — 2026-10-27

The queue card's direct **Add new build…** action now sits beside
**Replay classified as** and opens the player's own source events. The opponent
row explicitly says **Add opponent build…** and keeps the opponent perspective.
Both actions retain the shared editor and existing save/check-in flow. The
own action uses the same busy/missing-matchup guard as Change.

Help and the changelog describe the direct actions. The existing custom
picker's focus behavior is retained: it mounts after an explicit user action
and restores focus on Cancel. Its inherited autoFocus lint warning now has
an explanatory, narrowly scoped pragma rather than a behavior change.

## Verification

Evidence: `C:\SC2TOOLS\.cache\checkin-build-placement-verification-20261027`.

- Whole-web types passed. Strict scoped lint and 81 tests in four existing
  consumer/helper files passed, including each perspective's source events,
  source replay, save callback and correct check-in/correction payload.
- Own production build: `-w819VobkHPjxiLUaevnc`. All 81 original route budgets
  passed; the 96-article Help registry regenerates without a content change.
- Actual queue, shared new-build/editor, SWR, HTTP transport and realtime
  client ran with declared framework/auth/socket boundaries and disposable
  loopback responses. Four Chrome cases at 390/1280 in light/dark passed:
  own action shows Gateway at 1:05; opponent action shows Robotics Facility
  at 3:00; Cancel returns to the queue.
- Twelve raw AA scans have zero violations. Four clipped mobile editor hint
  nodes hit axe grid errors and were reviewed against the rendered palettes;
  the queue scans have no incomplete findings. This is not product-wide AA
  certification. Root reviewed all four committed queue captures.
- No external request, page/console/request/server error or mutation write.
  The browser fixture does not save/check in/rematch a real game. Consumer
  tests cover save payloads separately. It does not prove production auth.
- The real provider unmounted and the one declared socket per case disconnected.
  Browser, HTTP server and sockets closed; all 20 observed runtime identities
  retired, with no owned listener. Shared engine assets/sample stayed unchanged.
- The first cache-only visual preflight stopped because ESLint ignored files
  outside its base path. Running it from the cache root checked the same files
  with strict syntax/unused/undefined/function-size/complexity rules. No browser
  case or accessibility assertion was skipped to obtain the passing run.

The four production/test/Help/changelog files were unchanged between the own
build and final browser proof. Screenshot/checkpoint additions are documentation.
This follow-up joins the reference-save correction in PR 790; the new head must
pass required CI before merge and coordinated deployment verification.

No migration, infrastructure, environment variable, provider activation,
agent version or tag is required. Revert this UI commit to restore the prior
layout; saved builds and check-in records need no conversion.
