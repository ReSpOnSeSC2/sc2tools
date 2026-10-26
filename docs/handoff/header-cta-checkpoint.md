# Header action links checkpoint

Root independently verified all six final owned hashes and visually reviewed
Light 1024 signed-out, Dark 1440 player and Dark 1280 signed-out captures.
Three byte-identical copies now live under `docs/handoff/screenshots/` as
`header-cta-light-1024-out.png`, `header-cta-dark-1440-player.png` and
`header-cta-dark-1280-out.png`. Original images and the verified copy receipt
remain in the cache. The tested product source is unchanged.

2026-10-26. Final local proof in `wave4-agent-dashboard`, branch
`codex/wave5-header-cta`, at
`c47047c264e2f022866c1aa300efa14a6caadb91`, including reviewed Platform,
Glossary, Mobile and Notification dependencies. All local runtime jobs,
browsers and servers are closed. Root owns final source/capture review,
test-only dependency reconciliation, Git and stacked delivery.

## Final integrated local proof

The original exact six-path manifest remains
`.cache/header-cta-owned-paths.txt`. Header, its consumer test, appearance
spec and checkpoint matched the first-static receipt; Changelog/baseline
differences were the integrated dependency union/retirement. No source or
test repair was needed during this final stage. All six prebuild hashes
remained unchanged through build, browser and visual proof; only this
checkpoint changes afterward. Evidence lives under
`.cache/header-final-c47047c2/`, with integrated static logs also named
`.cache/header-final-*`.

- **243 tests across 28 suites passed**, maximum two workers: Header/auth
  context, unsupported/private return paths, dynamic query and Suspense
  fallback, native LinkButton, recipe styles, Mobile/Sheet/Modal/focus/theme,
  canonical glossary and Help contracts. Whole web types passed before and
  after build; all three owned code/test files passed strict lint with zero
  warnings. The whole-app build retains inherited warnings separately.
- Read-only canonical Help determinism passed for **91 articles**, normalized
  SHA256 `b1af2309affec6feaf94224421684fda9de54b05dec06fd6ce8a5e864010a074`.
  Raw CRLF SHA256
  `1abb616ecd0a7145974c7cbfb2a72121c2b6df1a20a27fec5251e6411cf092ab`
  was preserved without writing the index. All **19 UI-rule checks** passed;
  the ratchet passed over **1,699 files / 642 existing occurrences**, with no
  new or stale allowance.
- All assets were already present. Fresh admission matched **40 normalized
  engine inputs**, source hash
  `18a2e1b56111045cdb441d9d8868eee0b36d0b158b34ea0a79e3b9a22a69e2b2`,
  canonical **`1.6.12/d27b37abb9997712`**, agent `0.24.7`, all five active
  asset digests/sizes and four strict sample payloads. Raw sample CRLF bytes
  remain **163,356 / SHA256
  `05e874e4792b9e054021efbe0008a935a4cd1c4e4395b1f3e061508b476f0c40`**;
  canonical LF bytes are **163,355 / SHA256
  `91a6735e50f45776c15642ebae53f1a3f9800c1db225a99e0e631be318820473`**.
  All nine retained old/active engine/Pyodide files, pointer, sample,
  availability and source hashes stayed unchanged after build. No copy,
  engine compilation, generation, publisher, pruning or download ran.
- One direct Next production build passed with official dummy/local flags,
  build ID **`2-1RqSXMLXm0hFWUs2bVM`**, generating **144 static pages**. All
  **81 unchanged budgets** passed: Home 193.1/215 kB, Community 188.6/190 kB,
  Today 234.3/240 kB, dossier 460.6/500 kB, Help article 196.1/200 kB and
  Try 216.8/240 kB. No dependency or budget increased. Post-build types and
  repeated asset admission passed.
- The **whole appearance spec** passed **18 cases / 15 intentional skips**
  across its original three project names, one worker and zero retries.
  Installed full Chromium 1228 uses SHA256
  `b798f9e53a98d29eb7f36f8c409f905d3184780a04d2bcb56989067194784bd1`.
  Every actual-consumer fixture uses this build's production CSS/local fonts.
- Both Header theme flows measure **1024/1280/1440** signed-out and player
  states: Sign in/Get started retain their safe auth destination and Open app
  stays `/app`. Native keyboard focus is visible, its shadow differs from the
  ordinary hard shadow, and pill radius remains unchanged. Text color is
  retained during hover while its background changes. The existing **36px
  height** and minimum 44px width are preserved; no 44px-height claim is made.
  Bounds, no horizontal overflow and **1023→1024** menu/CTA visibility pass.
- All **66 full AA scans** have zero serious/critical issues: **54 Header
  scans** (27 per theme: nine width/link combinations × rest/hover/keyboard
  focus) plus **12 related Mobile/More scans**. Collecting-only mode was unset;
  no rule or contrast check was excluded. Original System/saved mode, skip
  link, phone/compact controls, Mobile auth/navigation, nested Escape,
  scroll-lock/breakpoint and More/report handoff regressions all remain.
- Strict typed fixture ledgers record **six Header `/v1/me` player GETs**
  plus **four Mobile player/admin GETs**. Their unknown/rejected/nonlocal
  requests and API writes are zero. No actual account/provider, account
  preference, clipboard or native action ran; theme storage changes are
  confined to synthetic browser contexts. Dynamic query, private fallback
  and Suspense behavior are unit proof; the browser's fixture route is
  `/guides/pvz` without a query.
- **29 new cache-only PNGs** remain: 12 Header captures, 13 related
  phone/compact/Mobile captures and four More captures. Header Light 1024
  visitor, Dark 1440 player and Dark 1280 visitor images were visually
  inspected: links, focus rings and surrounding chrome are legible, contained
  and unclipped. Header captures show the last tested focused link; rest and
  hover are independently AA-tested. Root owns any tracked copies. Prior
  images, ignored caches and the two pre-existing `.tmp-*.cjs` helpers were
  preserved and not executed or modified.

No final-stage RED occurred. Local artifact proof refers to the exact source
above. Root's separate Platform CI committed-unmount test barrier is a test-only
dependency repair to be reconciled before delivery; these results do not
mislabel that later head as already tested or imply current remote CI/live
status. Root can establish runtime-tree equality when integrating it.

Key proof files: `prebuild-source.json`,
`asset-admission-{prebuild,postbuild}.json`, `help-determinism.json`,
`next-build.log`, `budgets.log`, `types-postbuild.log`, `build-artifact.json`,
`browser-results.json`, `browser.log`, `final-browser-summary.json` and final
source hashes. Representative captures relative to the final proof directory:

- `shots/contrast-accessibility-desktop-1280-header-cta-light-1024-out.png`
- `shots/contrast-accessibility-desktop-1280-header-cta-dark-1440-player.png`
- `shots/contrast-accessibility-desktop-1280-header-cta-dark-1280-out.png`

## Earlier first static validation

At `902a75a7` with final Mobile source integrated, the first static stage
passed 189 tests across 18 disjoint suites: actual Header/auth context,
Suspense fallback, supported return-path rules, Mobile navigation, shared
LinkButton and all Help contracts. Whole-web types and strict lint on all
three owned executable files pass with zero warnings. Help90 is deterministic
without writing it; all19 UI-rule checks and the unchanged ratchet of1,695
files/643 existing occurrences pass. No production or test source repair was
needed. Evidence remains in `.cache/header-first-static-902a75a7/`.

At that earlier boundary, root jobs were closed and final provider/glossary
integration/build/browser gates remained. Those local gates are now complete
above; source reconciliation and delivery remain root-owned.

## Initial source-only stage (historical)

2026-10-26. Source-only pack in `wave4-agent-dashboard`, branch
`codex/wave5-header-cta`, based on reviewed Mobile/Notification source
`00df65c7`. The delivered Replay branch and all old caches/images are retained.

The roadmap explicitly includes Header's three local CTA recipes. This narrow
six-path pack retains AuthContextLink for Sign in/Get started, uses shared
buttonClasses at secondary/primary small size, and uses LinkButton primary/small
for Open app. The 36px height and existing desktop visibility, auth/navigation
gates, return-path allowlist, Suspense fallback, menu and Appearance behavior
remain. The two local recipes and exactly three retired lint allowances are
removed. No shared API, button sizing, mobile CTA, wordmark or provider behavior
changes.

Focused consumer tests and actual-Header browser checks are authored. All tests,
types, lint, generation, build, browser, commit/PR and deployment gates remain
unrun. MobileNav currently owns the exclusive runtime slot. Root owns delivery;
source-only work must not compete with it.

The original six paths are recorded in `.cache/header-cta-owned-paths.txt`.
Independent source review found the product/auth/import change coherent. Before
runtime, root removed unsupported RTL ByRole `exact` options and strengthened
the browser proof to compare keyboard-focus shadow against the ordinary hard
shadow, verify retained pill radius and allow a bounded three-minute matrix.
Original and revised source-only hash receipts remain in `.cache/`.
Before final runtime, integrate the delivered Mobile source and verify all
source/retained engine/sample assets. Run meaningful Header/auth/button and
related Sheet/focus checks, full types, strict owned lint, deterministic Help
and unchanged UI ratchet. Then one production build/all81 budgets and pinned
full Chromium1228, one worker, actual current CSS/fonts. Check both themes,
desktop 1024/1280/1440, 1023→1024 visibility, hover/focus text contrast, native
keyboard and auth context with synthetic GET-only transport. Preserve failures,
capture hashes, unknown request ledgers and original evidence. No actual
account/provider, clipboard, native app or integration actions.

## Delivery and rollback

Local static, asset, build, budget, browser/AA and visual gates above are
complete. Root owns final review, any test-only/current-main reconciliation
with runtime equality, exact-head CI, stacked commit/PR/merge and live source
verification. No manual deployment retry, plan upgrade or remote action ran.
Rollback is a revert of this web-only consumer pack. No data migration or agent
release is involved. This is not completion of the remaining chrome/landing
CTA or wordmark work.
