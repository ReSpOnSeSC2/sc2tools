# Mobile navigation Sheet checkpoint

2026-10-26. Branch `codex/wave5-mobile-nav-sheet`, final local proof at
`00df65c739604bb59079a6dd1ea7ba6eec65dea0`, in
`.worktrees/wave3-owner-neighbors`. Root preserved the original eight-path
source as `d0ee472d`, its static proof as `c5c93fc8`, then normally integrated
the reviewed Notification dependency before the final artifact. Prior Try
source, assets, captures and caches are preserved. All local runtime jobs,
browsers and servers are closed. Root owns Git, capture copies and delivery.

Root verified all seven non-checkpoint final hashes, visually reviewed the
320px Light,390px Dark and1023px Light captures and added new byte-identical
copies as `mobile-nav-sheet-light-320.png`, `mobile-nav-sheet-dark-390.png` and
`mobile-nav-sheet-light-1023.png` in `docs/handoff/screenshots/`. The phone body
scrolls independently to reach lower links; title,44px Close and theme footer
remain visible. Original images and all prior receipts are preserved. Actual
main2743 has exactly the reviewed Notification dependency's tree, so its normal
ancestry reconciliation must leave this delivery tree unchanged.

## Final integrated local proof

The exact original eight-path manifest remains
`.cache/mobile-nav-sheet-owned-paths.txt`. All eight prebuild hashes stayed
unchanged through build, browser and visual verification. Only this checkpoint
changes afterward. Frozen production code required no repair during the final
runtime stage. Proof files are under `.cache/mobile-nav-final-00df65c7/`, with
integrated unit/static logs also named `.cache/mobile-nav-final-*`.

- **210 checks across 23 suites passed**, maximum two workers. This includes
  MobileNav and Header, Sheet/Modal/focus scopes, ThemeChoice/theme, Help,
  integrated Notification focus/placement, Replay sharing, copy recovery and
  owner-scoped requests. Whole web types passed before and after the build.
  Strict lint passed for all five owned code/test/fixture/Help paths with zero
  warnings and no inherited-warning exclusion. Fixture syntax was already
  verified in the static stage. The whole-app build retains its pre-existing
  lint warnings; it is not claimed warning-free.
- Canonical Help generation ran twice for **90 articles**; the generated
  content and SHA256 were deterministic and the original raw registry bytes
  were restored. All **19 UI-rule checks** passed. The full ratchet passed
  across **1,695 source files / 646 existing occurrences**, with no new or
  stale allowance: Notification's one retirement plus MobileNav's two.
- Fresh asset admission matched **40 normalized engine inputs**, source hash
  `18a2e1b56111045cdb441d9d8868eee0b36d0b158b34ea0a79e3b9a22a69e2b2`,
  canonical engine **`1.6.12/d27b37abb9997712`**, agent `0.24.7` and all five
  active asset digests/sizes. The strict sample reader accepted all four
  scrubbed payloads. This worktree's sample uses LF: raw and canonical bytes
  both measure **163,355**, SHA256
  `91a6735e50f45776c15642ebae53f1a3f9800c1db225a99e0e631be318820473`.
  All nine retained engine/Pyodide files, active pointer, sample and
  availability hashes are unchanged after the build. No asset copy,
  generation, engine compilation, download or pruning ran.
- One completed direct Next production build passed with official dummy/local
  CI flags, build ID **`26CpTnHkbQpXtrlB5bx6w`**, generating **143 static pages**.
  All **81 unchanged route budgets** passed: Community 188.6/190 kB, Today
  234.3/240 kB, opponent dossier 458.9/500 kB and Try 216.7/240 kB. No npm
  prebuild or publisher ran. Post-build web types and repeated asset admission
  passed.
- The **whole appearance suite passed 16 cases**, with **11 intentional
  skips**, across its original phone/tablet/desktop projects, one worker and
  zero retries. Both new MobileNav flows cover **320/390/768/1023 pixels** and
  **1024-pixel teardown**, using actual current production CSS/local fonts
  and installed Chromium 1228. Its executable SHA256 is
  `b798f9e53a98d29eb7f36f8c409f905d3184780a04d2bcb56989067194784bd1`.
- Native keyboard proof covers Close-first focus, the selected theme radio's
  Tab wrap, Close/Escape/scrim/destination/home closure, route changes,
  signed-out/player/admin destinations and auth return URLs, a newer Modal's
  first Escape, independent scroll-lock ownership and breakpoint cleanup.
  Measured geometry confirms the right edge, full height and up-to-448px
  width, viewport-contained header/footer, 44px Close and a scrollable phone
  content region. No body-level horizontal overflow was found.
- All **12 full AA scans** have zero serious/critical issues; no rule was
  disabled and `A11Y_COLLECT_ONLY` was unset. The two MobileNav fixture
  receipts record exactly **four synthetic `/v1/me` GETs**: one player and
  one admin GET per theme. Their unknown requests, rejected writes and
  nonlocal attempts are zero. No API write, actual account/provider action,
  account preference, clipboard or native agent/StarCraft operation ran.
  Theme changes are confined to synthetic browser contexts.
- **17 new cache-only captures** are retained: eight MobileNav widths/themes,
  existing real-page phone/compact captures and four More captures. The
  Light 320, Dark 390 and Light 1023 MobileNav images were visually inspected:
  text, header/Close and theme footer are legible and contained; the phone
  body scrolls independently for lower destinations and CTAs. Root owns any
  tracked review-image copies; no prior capture was overwritten.

Two setup expectations were preserved before correction. The cache-only
admission script initially expected Notification's CRLF sample bytes, rejected
this worktree's legitimate LF bytes, and was then corrected to the exact raw
canonical hash above without changing the sample. The first sandboxed build
attempt failed with filesystem `EPERM` creating ignored
`.next/static/chunks/app/overlay/[token]`; the unchanged direct build passed in
the approved host context. Neither was a product source failure. Original
scripts/logs remain alongside the final proof.

Key receipts: `asset-admission-{prebuild,postbuild}.json`, `prebuild-source.json`,
`build-artifact.json`, `next-build.log`, `budgets.log`, `types-postbuild.log`,
`browser-results.json`, `browser.log`, `final-browser-summary.json` and the
final source proof. Representative review captures are:

- `shots/contrast-accessibility-mobile-360-mobile-nav-light-320.png`
- `shots/contrast-accessibility-mobile-360-mobile-nav-dark-390.png`
- `shots/contrast-accessibility-mobile-360-mobile-nav-light-1023.png`

## Earlier static proof, before Notification integration

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

## Delivery gates

The local static, asset, build, budget, browser and visual gates above are
complete. Root owns final source/capture review, any fresh-main reconciliation
with runtime-tree equality, exact-head CI, reviewed commit/PR/merge and live
source/domain verification. Screenshots require root's exact path approval.
No broader path, primitive/API change, waiver, dependency or budget increase
was needed. This is one consumer migration, not completion of the full roadmap.

## Rollback

Revert this web-only pack to restore the prior menu implementation. No data
migration, production recomputation, integration activation or agent release
is included.
