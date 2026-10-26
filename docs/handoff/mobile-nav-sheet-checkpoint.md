# Mobile navigation Sheet checkpoint

2026-10-26. Branch `codex/wave5-mobile-nav-sheet`, current static-proof source
`fae1ba88d0901b0691f269235d8dc60733ee4e63`, in
`.worktrees/wave3-owner-neighbors`. Root preserved the original eight-path
source as `d0ee472d` and normally integrated main `9bd` before this proof.
Prior Try source, assets and caches are preserved. Notification integration
is still required before the final artifact; no MobileNav build or browser
proof has run yet.

## Current static proof

- 87 checks in 14 focused suites passed: MobileNav (12), Header navigation
  (13), shared Sheet/Modal/focus scopes, ThemeChoice/theme and Help contracts.
  Log: `.cache/mobile-nav-current-static-units.log`.
- Whole web types passed. Strict lint passed across all five owned code files
  with zero warnings and no inherited-warning exclusions. The first strict
  run identified two new accessibility warnings in the test Link mock because
  its `href` was hidden in spread props. Making that existing prop explicit
  preserved behavior; the 12 MobileNav checks and strict lint passed afterward.
  Both first-run and repaired logs are retained under
  `.cache/mobile-nav-current-static-*`.
- Canonical Help generation ran twice for 90 articles, with deterministic
  SHA256 `36c349983b1476de9558c7fb581ee2be7732e3278615b41596438fb0ce807398`.
  Committed registry content matched; its original raw bytes were restored.
  The pre-generation snapshot and determinism log remain in `.cache`.
- All 19 UI rule checks passed. The full scan passed for 1,695 source files
  and 647 existing occurrences, with no new or stale allowance. The only
  allowance changes remain the two planned MobileNav removals.
- No actual account, preference, provider or clipboard operation was run.
  No engine generation, production build, browser run or Git mutation was
  performed in this static stage. Root owns integration and delivery.

## Historical source-only stage

The exact eight-path manifest was saved before edits as
`.cache/mobile-nav-sheet-owned-paths.txt`. This stage authors source, tests,
one actual-consumer browser fixture, Help and this checkpoint. No unit tests,
types, lint, Help generation, build, browser, Git mutation or deployment has
been run at that initial stage. Root owns Git and runtime permission. The
later approved static proof is recorded above separately from that history.

## Implemented scope

- MobileNav uses existing `Sheet side="right" size="sm"`, its standard
  full-width/up-to-448px sizing, `Site navigation` title and 44px Close. The
  existing branded home link, every destination/auth gate/active state, CTA
  callback and footer ThemeChoice remain. The footer retains bottom safe-area
  padding. The stable `mobile-nav-drawer` controlled-content ID preserves
  Header's unchanged `aria-controls` relationship.
- Shared Modal owns focus, nested Escape, Tab containment, body-lock counting
  and return focus. The first stop is now Close. Remove the local portal,
  scrim, keyboard/focus helpers, timer and manual scroll-lock ownership.
- A consumer-owned `(min-width:1024px)` listener closes state using the latest
  callback. The former `lg:hidden` only hid the old drawer while retaining its
  lock/handler. Header's existing pathname closure and all link-selection
  callbacks remain unchanged. No Header or primitive API extension is needed.
- Remove only MobileNav's retired dialog/ring baseline entries. Its three
  hand-rolled CTA allowances remain for their separate migration.

## Authored verification

- Preserve the three existing MobileNav cases, updating first focus to shared
  Close. Add four dismissal paths, latest callback/breakpoint closure and
  listener cleanup, initially-desktop admission, nested-parent Escape with an
  independent body lock, and both audience CTA branches.
- Update the existing real-page navigation case in `appearance.spec.ts` to the
  shared Close-first keyboard order; retain its System/Light/Dark assertions.
- New `mobile-nav-fixture.mjs` runs actual Header, MobileNav, NavAuthGate,
  AuthContextLink, Sheet/Modal, ThemeChoice, clientApi/SWR, production CSS/fonts
  and logo. Clerk/navigation and unrelated Bell/coaching boundaries are
  synthetic. Only exact authenticated fixture `/v1/me` GETs return typed
  `isAdmin` payloads. Unknown GETs, every write and nonlocal traffic are counted
  and rejected; no real account/provider/clipboard receives a write.
- Two new flows in the existing appearance spec cover Light/Dark with explicit
  320/390/768/1023 widths, signed-out/player/admin gates, destination and
  external-route closure, home, selected-radio Tab wrap, newer Modal Escape,
  independent scroll locks, wide-screen scrim dismissal and 1023→1024 teardown.
  Full AA scans, footer/scroll/44px/viewport bounds and build/CSS/API receipts
  are authored. The matrix runs once per theme in the mobile project; the
  other projects intentionally skip this duplicate explicit-width matrix.

## Remaining gates

- Root integration of verified Notification source before artifact validation.
  Static gates above passed; no broader path or waiver was required.
- After root's normal retained engine/sample source/hash admission, one
  current production build, post-build types and unchanged route budgets.
  No engine compilation, pruning, dependency install or budget increase.
- Actual-source browser matrix with one worker and installed pinned Chromium;
  preserve failure artifacts and review representative captures. Screenshots
  are not yet owned; root must approve exact new committed paths.
- Current main reconciliation, exact-head CI, reviewed commit/PR/merge and live
  source/domain verification. This is one consumer migration, not completion
  of the full roadmap.

## Rollback

Revert this web-only pack to restore the prior menu implementation. No data
migration, production recomputation, integration activation or agent release
is included.
