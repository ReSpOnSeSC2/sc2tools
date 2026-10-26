# Mobile navigation Sheet checkpoint

2026-10-26. Branch `codex/wave5-mobile-nav-sheet`, based on main `1ad5dafa`,
in `.worktrees/wave3-owner-neighbors`. Prior Try source, assets and caches are
preserved. Frozen Notification source is in its separate worktree.

## Source-only stage

The exact eight-path manifest was saved before edits as
`.cache/mobile-nav-sheet-owned-paths.txt`. This stage authors source, tests,
one actual-consumer browser fixture, Help and this checkpoint. No unit tests,
types, lint, Help generation, build, browser, Git mutation or deployment has
been run for this pack. Root owns Git and runtime permission; the active
dialog workstream still owns the local runtime slot.

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

## Authored verification, still unrun

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

- Root source review, then granted focused unit/related Header/Sheet/Modal/
  focus/Help checks, full web types, strict owned-file lint, deterministic Help
  generation and UI ratchet. No broader path or waiver is authorized here.
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
