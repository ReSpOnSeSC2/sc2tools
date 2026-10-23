# Wave 2 chrome navigation and installed app checkpoint

Scope: full chrome-nav-polish-2, chrome-nav-polish-3 and chrome-nav-pwa-1 specs,
audit findings and howto (no augments). Isolated branch
`codex/wave2-chrome-navigation`, dependency-only base `73a51316` (What's New #671,
shipped main `746b05cb`, notification focus repair). Root owns integration and merge.
The owner checkout, protected focus/filter/Opponents sources and frozen drafts are
untouched.

## Implemented

- Pinnable 224 px rail with pre-paint bootstrap, storage/private-mode/device
  defaults, group captions, delayed description tooltips with Escape, preserved
  routed progress, Build stats/Build library names and short phone labels. More
  uses Modal and shared scroll locking, support/legal/status links, theme radios,
  install entry and the fuller avatar menu. Shared nav role gates remain intact.
- AgentSyncPill (SyncStatus alias) derives presence from the desktop heartbeat,
  uses authenticated SWR data, inserted-only optimistic count mutation and shared
  coalesced revalidation, a 30-second relative-time clock, secondary realtime
  details and Devices links. It does not mount useLiveGame or another transport.
  App activity is one 36 px row, hides on phone utility pages, and keeps community
  counts in a persisted xl+ disclosure. Marketing SiteStats remains full.
- One page-lifetime PWA store captures early, one-shot native prompts and installed
  state. The landing banner preserves its cooldown/copy, including clearing a
  dismissal when a new native event fires. More and Settings offer native install
  or lazy accessible iOS/Android steps and a success toast.
- Self-contained offline HTML is the only cached resource. Auth/API/page responses
  remain network-only; overlay/Dock navigations are excluded. Worker updates still
  require consent. Targeted help and route labels updated; 62-article index rebuilt.

## Data-grounded plan adjustment

The plan calls `/v1/me.games.latest` the last upload. `GamesService.stats()` actually
sorts game `date`, so it is the latest played time. Copy now says **latest game**,
including help and Devices. Optimistic inserts preserve that timestamp until the
shared authoritative revalidation returns; importing an old replay today does not
invent a new played time. A regression covers that case. No API was added.
`streamStudioLearn.ts` has no old navigation label, so its copy was retained.

## Verified

- Full web suite: **6,316 passed, 1 skipped**, across 661 suites. Final narrow
  regression run after the played-time correction: **84 passed** across 8 suites,
  including real SWR mutation/remount, all realtime consumers, navigation progress,
  bootstrap, install cooldown, accessible steps and help content.
- Final typecheck and changed-file strict ESLint pass. Exact CI production build
  and every existing budget pass; no budget was raised. Final sizes are recorded
  in the PR description and ignored `apps/web/chrome-final-budgets.log`.
- Actual production Chromium regression passed twice with fresh servers: the app
  registers its real service worker, caches only `/offline.html`, shows the fallback
  with networking disabled, and **Try again** performs another navigation.
- Actual component Chromium checks cover desktop 1440, touch iPad 1024 and phones
  320/390: tooltip/Escape, pinned width and persistence, touch labels, More keyboard
  traversal/theme/support links, nested install/report scroll locks and focus return
  after initial focus settles, responsive activity and an early install-event
  fixture consumed once. No browser errors. CSS/fonts and components are real;
  authentication, API and report content are fixtures. No live login/native install.
- Seven reviewed screenshots live in `docs/handoff/screenshots/chrome-*.png`.
  The offline screenshot previews the exact static HTML source; the separate
  production service-worker test verifies actual network-offline behavior.

## Root shared-helper review before final integration

Modal/useFocusTrap schedules initial focus with `setTimeout(0)`. Escape in the first
frame before a nested Install dialog receives focus can close the parent More
dialog. Normal nested keyboard/focus paths after initial focus settles pass.
Protected root-owned useFocusTrap/Modal sources were not edited. Repro: open More,
choose Install app on iOS, issue Escape immediately when the child becomes visible
without waiting for focus. Review synchronous initial focus/topmost-dialog scoping
while preserving existing focus/filter regressions. This draft stays held for that
review, dependency integration, retargeting to main and final remote CI.

No AI features/API calls, new infrastructure, account mutation, canonical version
bump, release/tag/install or signing operation. No release is claimed.
