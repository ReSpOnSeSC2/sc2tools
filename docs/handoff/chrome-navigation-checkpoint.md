# Wave2 navigation, status and installed-app checkpoint

Scope: complete chrome-nav-polish-2, chrome-nav-polish-3, chrome-nav-pwa-1.
Isolated branch codex/wave2-chrome-navigation, dependency-only base73a51316
(What's New671 + shipped main746b05cb + notification focus fix). No owner-checkout,
root focus/filter/Opponents source or frozen-pr edits.

Work started: shared page-lifetime PWA install capture/platform detection and
one-shot prompt store; landing banner now shares it, preserving cooldown/copy.
Service-worker offline page/network-only navigation fallback excludes OBS routes,
keeps consent-based worker updates and never caches account/API/page responses.
Shared scroll lock replaces direct writes in marketing drawer/install sheets.
Pure150s heartbeat presence helper extracted without adding useLiveGame to chrome.
Implemented further: shared in-app Install rows with lazy Modal instructions and
success toast; pinned rail/bootstrap/group captions/description tooltips; Modal More
sheet with theme radios and support links; avatar links and compact mobile names;
SWR-backed AgentSyncPill, shared optimistic/debounced realtime handlers and density
app activity variant. Typecheck passes. Help, broad label updates, regression suites,
actual browser checks and production budgets remain unverified/incomplete.

No AI features/API calls, infrastructure additions, account mutation, release,
tag/install/sign or canonical version bump. Verification is not complete yet.

Regression progress: 121 navigation/PWA/site-activity tests pass, plus13 actual
SWR/shared-realtime tests (including no extra useLiveGame connection, optimistic
inserted-only count, authoritative revalidation/remount and30s relative clock).
A fallback-data race was fixed by using the visible /v1/me value if the SWR cache
has not yet been populated, while still mutating only its authenticated bound key.
Typecheck and strict changed-file lint pass. Full suite and exact-CI build running.
Help/howto and labels updated; index regenerated62articles. More/PWA/offline actual
browser verification and final release-grade evidence remain pending.

Full web suite passed6301 tests,1 skipped across658 suites. Exact-CI production
build/all unchanged budgets pass (home205.4/215 kB, /app234.6/240, opponents175.9/180,
settings177.7/260). Actual production Chromium service-worker regression passes:
only/offline.html cached, offline navigation serves its standalone page.

Actual component Chromium checks pass desktop1440, touch iPad1024, phones320/390:
pin/tooltip/Escape/push width/preference, labelled touch default, More keyboard walk,
Light/Dark/support links, nested install/report lock and focus return, responsive
activity and one-shot early native-install fixture. No browser errors; no actual
account/native/desktop installation action. Screenshots reviewed; final refresh pending.

Shared-helper follow-up for root before final integration: Modal/useFocusTrap
currently schedules initial focus with setTimeout(0). An Escape in the first frame
before a nested Install dialog receives focus can close the parent More dialog.
The normal path after initial focus settles passes. The protected root-owned
useFocusTrap/Modal source was not edited. Repro: open More, choose Install app on
iOS, issue Escape immediately when the child becomes visible without waiting for
focus. Root should consider synchronous initial focus/topmost dialog scoping;
retain all current focus/filter regressions. Do not treat this scoped draft as
permission to merge before that shared-helper review and final main integration.
