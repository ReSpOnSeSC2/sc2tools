# Header action links checkpoint

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

Rollback is a revert of this web-only consumer pack. No data migration or agent
release is involved. This is not completion of the remaining chrome/landing
CTA or wordmark work.
