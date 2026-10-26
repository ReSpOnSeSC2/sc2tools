# Notification Popover checkpoint

2026-10-26. Branch `codex/wave5-notification-popover`, based on main
`1ad5dafa`, in `.worktrees/wave3-game-workspace`.

## Source-only stage

The exact ten-path manifest was written before edits to
`.cache/notification-popover-owned-paths.txt`. Source, tests, a browser fixture,
Help and this checkpoint are authored. No tests, types, lint, generation,
production build, browser, Git mutation or deployment has been run for this
pack at this stage. Root owns Git and the runtime grant; another workstream
currently owns the local runtime slot.

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
