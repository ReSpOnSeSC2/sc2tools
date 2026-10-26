# Notification Popover checkpoint

2026-10-26. Branch `codex/wave5-notification-popover`, based on main
`1ad5dafa`, in `.worktrees/wave3-game-workspace`.

## Source-only stage (initial historical freeze)

The exact ten-path manifest was written before edits to
`.cache/notification-popover-owned-paths.txt`. Source, tests, a browser fixture,
Help and this checkpoint are authored. No tests, types, lint, generation,
production build, browser, Git mutation or deployment has been run for this
pack at this stage. Root owns Git and the runtime grant; another workstream
currently owns the local runtime slot.

## First runtime stage, before the final artifact

Root preserved the source pack and integrated main at
`06c4311c11416e03a4cce6d8d7d5945c54f4da40` before granting this runtime slot.
The original source-only receipt remains preserved. The current ten-path
freeze is `.cache/notification-popover-first-runtime-freeze.json`.

- The added held-list/newer-keyboard-Modal regression reproduced a real
  failure: list readiness moved focus from the newer Modal to a notification
  row. The exact read body and retained New styling already passed. The RED
  is `.cache/notification-popover-held-newer-modal-red.log`.
- NotificationPanel now consumes its one entry-focus attempt at readiness
  and uses the existing `canReturnFocus` helper to respect the active Modal
  focus domain. A Panel regression also verifies that suppressed entry focus
  does not return on a later update after that Modal closes.
- The first browser diagnostic found an authored locator error: the load
  failure alert includes its Try again button in its full text. The spec now
  asserts the visible alert's complete message and its visible Try again
  button separately. No error assertion was removed or hidden.
- With that assertion repaired, the real browser reproduced cached-error
  reopen focus failure. The child layout effect tried to focus while the
  Popover was hidden for its initial placement. A real-Popover unit then
  reproduced the same hidden focus attempt. Both REDs remain in
  `.cache/notification-popover-cached-error-focus-red/` and
  `.cache/notification-popover-hidden-placement-unit-red.log`.
- Only while that known dialog has inline `visibility:hidden`, the Panel
  now observes that dialog's style attribute. Once placement makes it
  visible, it resolves the current connected row/header, consumes the entry
  attempt and applies the same Modal-domain guard. The scoped observer is
  disconnected on success, dependency change or unmount. Normal visible and
  standalone entry stays synchronous. No timer, shared primitive/helper/API,
  fetching, read-acknowledgement or other data effect changed.

Current focused verification passed: 39 tests across the four Notification,
Popover and historical placement suites; full web types; strict ESLint with
zero warnings for the seven owned code/test/fixture/Help files; 77 Help tests
across 12 suites including deterministic index verification; 19 UI-rule tests
and the unchanged UI ratchet of 650 existing occurrences. The previously
reviewed custom-Popover `autoFocus={false}` lint pragma remains; no new lint
configuration, baseline allowance or inline exemption was added here.

The **PRIOR-CSS diagnostic** passed all 18 browser cases in Light and Dark at
360, 768 and 1280 pixels, with native focus, cached-error reopen, nonmodal Tab,
outside pointer dismissal, newer-dialog Escape, exact synthetic read bodies,
retained New styling, pagination and full AA scans. All 18 evidence receipts
have empty accessibility issues, rejected writes, external attempts and
runner errors. Fresh-entry flows issue one read POST, empty/error flows zero,
and paging flows three with the expected two ID batches and explicit
`all:true`. Receipts are consolidated in
`.cache/notification-popover-prior-css-evidence-summary.json`.

The browser used the installed pinned full Chromium at
`C:/Users/jay19/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe`,
SHA256 `b798f9e53a98d29eb7f36f8c409f905d3184780a04d2bcb56989067194784bd1`,
with one worker, zero retries and no application/API server. The execution
sandbox prevented that executable from launching; the authorized local
synthetic diagnostic ran outside it. Initial config and launch failures were
preserved before correction. No browser was downloaded or installed.

These browser results are **not final artifact or geometry proof**: retained
CSS came from build `w6MBSN3zIpSbpI6_jAAiE` and lacks the new important padding
class. The assets and hashes are recorded in
`.cache/notification-popover-prior-css-assets-explicit.json`. No current
production build or post-build verification has run. All runtime jobs are
closed; pause before the final build while root integrates the reviewed
Replay dependency and grants the final artifact stage. Root still owns Git,
integration and release. MobileNav and glossary sources remain frozen.

## Implemented scope

- NotificationBell uses the existing nonmodal Popover, a unique dialog ID and
  `aria-controls`, with `autoFocus={false}`. NotificationPanel remains lazy and
  focuses the first committed row, or its empty/error heading, after the
  existing ready-and-merged gate. It no longer renders a second dialog.
- Shared placement, top-layer Escape, outside pointer dismissal and return
  focus replace Bell's duplicate placement/document handlers and immediate
  forced bell focus. The panel remains nonmodal: no body lock or Tab trap.
- Fetching, read acknowledgements and their bodies, retry, pagination, socket
  cadence, per-open New styling and account scoping are unchanged. Historical
  `notificationPanelPlacement` re-export and tests remain.
- Remove only NotificationPanel's retired `dialog-outside-ui` allowance. Bell's
  unrelated badge text allowance is retained. No primitive extension, API
  change, provider action, dependency, migration or agent release is included.

## Authored verification, still unrun

- Extend the existing Bell suite with held-list entry/no early read write,
  real Popover dialog linkage, nonmodal Tab, outside pointer focus, later
  Modal Escape ownership and late closed-page suppression. Preserve every
  existing pagination, New-state, read-retry and account-switch case.
- Extend the existing Panel focus suite with empty/list-error/unread-error
  heading focus and later focus preservation. Panel is content only.
- New `notification-popover-fixture.mjs` and `.spec.ts` use actual Bell,
  dynamic/lazy Panel, clientApi/SWR, Popover, Modal, production CSS and bundled
  fonts. Auth, socket and navigation boundaries are synthetic. GET endpoints
  return exact typed notification DTOs. Only valid fixture-origin read-ack
  POSTs are admitted and counted; every unknown GET/write and nonlocal
  attempt is recorded and rejected. No real account/provider/clipboard write
  is performed. Test receipts include the actual production build ID, CSS
  names, GETs and exact synthetic read bodies.
- Three flows per theme cover held readiness/nonmodal/native focus and newer
  Modal Escape, error/empty retry, and 45-row paging with explicit mark-all.
  Each flow includes full AA scans and viewport bounds. The configured phone,
  tablet and desktop projects exercise both themes; local proof should also
  include 320px and 390px widths without changing project configuration.

## Remaining gates

- Root source review; first granted focused unit run and repair any real
  failures without waivers. Run related Popover/placement/focus/Help checks,
  full web types, strict owned-file lint, deterministic Help index and UI
  ratchet. Do not broaden the manifest without root approval.
- Admit retained engine/sample assets only after root's normal source/hash
  checks, then one current production build with unchanged route budgets and
  post-build types. No asset compilation, pruning or dependency installation
  is authorized by this checkpoint.
- Run actual-consumer browser proof with one worker and the installed pinned
  Chromium; preserve failures and inspect representative captures. No
  screenshots are owned yet; root approval is required for exact new paths.
- Fresh-main reconciliation, exact-head CI, reviewed commit/PR/merge and live
  source/domain verification remain outstanding. MobileNav→Sheet and other
  roadmap consumer migrations remain separate work.

## Rollback

Revert this web-only pack to restore the prior notification overlay. There is
no data migration or production recomputation to reverse.
