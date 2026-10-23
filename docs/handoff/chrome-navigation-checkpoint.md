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
