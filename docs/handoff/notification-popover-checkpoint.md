# Notification Popover checkpoint

2026-10-26. Branch `codex/wave5-notification-popover`, based on main
`1ad5dafa`, in `.worktrees/wave3-game-workspace`.

## Final local proof

Root preserved the focus repairs at `2a37da7c` and normally merged the
reviewed Replay sharing dependency into
`94c23ff51eeac0ecc4ab0784463916d685f3ada1`. The final runtime used that
integrated source. All ten owned prebuild hashes remained unchanged through
build and browser verification; only this checkpoint changes afterward.
The exact final hashes and documentation boundary are recorded in
`.cache/notification-popover-final-94c23ff5/final-source-proof.json`.

All local runtime jobs, browsers and servers are closed. The exclusive
runtime slot is released for root. No Notification PR, merge or production
publication is claimed here. Root owns Git, fresh-main ancestry reconciliation
and delivery; the frozen MobileNav and glossary packs remain separate.

Root verified all ten final owned hashes and visually reviewed the ready,
footer and stacked-dialog captures. Four new byte-identical copies are under
`docs/handoff/screenshots/`: `notification-ready-light-320.png`,
`notification-footer-dark-320.png`, `notification-newer-modal-light-390.png`
and `notification-ready-dark-1280.png`. Original captures remain preserved.
Current main `9bd115e9` has the exact tree of the reviewed Replay dependency
`8cec0cb5`; its normal ancestry merge must leave this delivery tree unchanged.

- Integrated verification passed **257 tests across 28 suites**, maximum two
  workers, including Notification's 39 checks plus related Replay, copy,
  owner-scope, Modal, focus and all Help contracts. Whole-web types passed
  before and after the build. Strict lint passed for all seven owned
  code/test/fixture/Help files with zero warnings. The 90-article Help index
  was verified deterministic without writing it. All 19 UI-rule tests passed;
  the ratchet passed over **1,695 source files / 648 existing occurrences**,
  with no new or stale allowance.
- The first final asset admission correctly rejected this worktree's old
  `fc21ebe5bf52a53c` pointer before any build. Root then restored exactly
  **three retained files** from the verified worktree: the `d27` ZIP, its
  manifest and the active pointer. The four Pyodide runtime files already
  matched, so no runtime copy was needed. The old pointer backup, restoration
  receipt and unchanged old-bundle hashes remain under
  `retained-engine-restoration/` in the final proof directory. No engine/sample
  generation, engine compilation, download or pruning ran. Admission and the
  direct build performed no additional asset copies.
- Fresh admission matched all **40 normalized engine inputs**, source hash
  `18a2e1b56111045cdb441d9d8868eee0b36d0b158b34ea0a79e3b9a22a69e2b2`,
  canonical engine `1.6.12/d27b37abb9997712`, agent `0.24.7` and all five
  asset digests/sizes. The actual strict reader accepted all four scrubbed
  sample payloads. Raw sample bytes remain **163,356 / SHA256
  `05e874e4792b9e054021efbe0008a935a4cd1c4e4395b1f3e061508b476f0c40`**;
  canonical LF bytes remain **163,355 / SHA256
  `91a6735e50f45776c15642ebae53f1a3f9800c1db225a99e0e631be318820473`**.
  Post-build admission confirms all source, assets, sample, availability and
  preserved old-bundle hashes are unchanged.
- One direct Next production build passed with official dummy/local CI flags
  and build ID **`fKmrIleejO4mjOBYWA3sT`**, generating 143 static pages. All
  **81 unchanged route budgets** passed: Community 188.6/190 kB, Today
  234.3/240 kB, opponent dossier 458.9/500 kB, Try 216.7/240 kB. The final CSS
  contains `!p-2`; actual panel padding measures 8px on both sides. No npm
  prebuild or asset generator ran. Inherited whole-app lint warnings remain
  in the build log; the owned-file strict check is clean.
- The unchanged final browser matrix passed **18/18**, one worker and zero
  retries, both themes across 360/768/1280 projects. It uses this build's
  production CSS/fonts and the installed full Chromium 1228 executable,
  whose path and SHA are recorded in `final-browser-summary.json`.
- Six additional native-browser cases at **320/390/1280**, both themes,
  passed held-list readiness under a newer Modal, unchanged Modal focus
  through the late list/read ACK, modal-first Escape, nonmodal Tab and outside
  pointer return. They measure panel bounds, 8px padding and immediate center
  hit-tests for every main panel control and the footer. There are **18 new
  cache-only captures**, with seven representative ready/footer/stacked
  phone and desktop images visually inspected. Footers are reachable and
  unobstructed; the newer Modal sits above the notification panel.
- All **24 full AA scans** have zero serious/critical issues, with no excluded
  rule or new allowance. Ordinary incomplete annotations remain recorded.
  The matrix records **150 synthetic GETs / 24 read-ack POSTs**; the compact
  capture matrix records **48 GETs / 18 read-ack POSTs**. Total admitted
  synthetic transport is **198 GETs / 42 read-ack POSTs** with exact bodies.
  Actual account, provider, consent, clipboard or native-share writes remain
  **zero**, as do unknown requests, rejected writes and nonlocal attempts.

The first compact runner expected seven GETs after native Tab left the
document and a click refocused it. Its preserved failure showed the existing
unread focus revalidation adds one read-only GET. The corrected cache-only
ledger asserts exactly seven before Tab and exactly eight after refocus,
without changing source or omitting an assertion. Original runner, partial
captures, log and failure receipt remain preserved; final captures use the
separate `captures-final/` directory.

Final proof files, relative to `.cache/notification-popover-final-94c23ff5/`:

- `integrated-units.log`, `strict-eslint.log`, `help-determinism.log`,
  `ui-rules.log` and `ui-ratchet.log`.
- `asset-admission-prebuild.json`, `asset-admission-postbuild.json` and the
  initial rejected-admission log.
- `next-build.log`, `budgets.log`, `build-artifact.json` and post-build types.
- `browser/results.json`, 18 `browser/aa/` reports and `browser-final.log`.
- `capture-results-final.json`, `captures-final.log`, `captures-final/` and
  `final-browser-summary.json`.

Representative inspected captures are `320-light-ready.png`,
`320-dark-footer.png`, `390-light-newer-modal.png`, `390-dark-ready.png`,
`1280-dark-ready.png`, `1280-light-footer.png` and
`320-dark-newer-modal.png` under `captures-final/`. Root owns any later
review-image copies into tracked documentation; no original image is replaced.

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

## Original authored verification plan (historical)

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

## Delivery gates

The local runtime gates above are complete. Root still owns final source and
capture review, fresh-main ancestry reconciliation with runtime-tree equality,
exact-head CI, reviewed commit/PR/merge and live source/domain verification.
Tracked screenshot copies require root's exact path approval. Other roadmap
consumer migrations remain separate work.

## Rollback

Revert this web-only pack to restore the prior notification overlay. There is
no data migration or production recomputation to reverse.
