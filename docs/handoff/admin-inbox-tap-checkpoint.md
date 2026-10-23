# Mobile admin inbox detail repair

Branch: `codex/fix-admin-inbox-tap`, based on merged main `71d00337` (includes #692 list/history fixes, #693 shared game clock and #694 desktop previews).

## Root cause

`AdminEventRow` was a passive list item. The title, identity and message body had no link, button, click handler or detail route. Tapping them did nothing in both Dashboard Recent activity and Notifications. Only the separate inline Reply, Gmail and Infrastructure controls had behavior.

## Result

The shared row summary is a native full-width button with a dialog affordance. Tap, click, Enter and Space open complete content in the existing focus-trapped Modal (phone sheet / desktop side panel). Messages retain multiline content, included diagnostics and failed requests, report status/replies and original-email link. Signups/install events link to their account; job and backup alerts link to the real Infrastructure heading. Exact event time and allowlisted type-specific fields are readable without truncation. No arbitrary payload dump or new API is introduced. Close, Escape and backdrop dismissal restore focus to the row. Opening does not mark read or issue a write. An `anonymizedAt` marker is authoritative before any row or detail projection: only a generic deleted-account event label and time remain, even if an old payload still contains email, subject, body, diagnostics or browser/IP fields. Account, Gmail and reply actions are unavailable for those rows.

## Validation

- Five focused suites: 44 tests pass, including nine new interaction cases for every event type, actual support reply failure/retry, authoritative deleted-account projection with retained personal fields, payload allowlisting and focus restoration.
- Entire admin tree: 22 suites / 180 tests pass, including Dashboard, Notifications and the #692 delayed-navigation regressions. The separate notification-center consumer integration also passes all three tests.
- Full web typecheck and strict changed-file lint pass.
- Exact public CI flags: reviews/guides on, Instant Analysis all, required engine, production-format dummy Clerk keys. Production build and unchanged route budgets pass at `1758566b`; the subsequent deleted-marker projection is verified by the focused/full-admin tests, full types and strict lint, with final-head CI required before merge.
- Actual Notifications component browser fixture with production CSS and isolated API/auth/navigation boundaries at390 and1440: touch, Enter, Space, Escape focus return, full message/failed-request disclosure, account/job destinations and reply failure/retry all pass. Zero horizontal overflow, browser errors or external network calls. Synthetic fixture support data only; no production reports/replies/writes.
- Screenshots: `docs/screenshots/admin-inbox-details-390.png` and `admin-inbox-details-1440.png`.

## How to verify

1. As an administrator, open Notifications or Dashboard Recent activity.
2. Tap a support message's title, sender or body. Read its complete message and expand included failed requests.
3. Use Status / Reply inside the detail panel; a failed save keeps the draft and Retry repeats it. Send only a real intended response.
4. Close with Escape or Close and confirm focus returns to the row. Tab to a row and use Enter/Space to reopen it.
5. Open a signup/confirmed install and use Open account; open a job/backup alert and follow Open Infrastructure.
6. Check that merely opening details does not mark unread activity read. Use the explicit mark-read action when intended.

The all-build admin Studio and later admin packs remain isolated in their own worktrees; this urgent repair does not include or claim them.
