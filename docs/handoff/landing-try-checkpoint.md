# Wave 2 landing/auth and browser analysis checkpoint

Scope: full landing-try-polish-4 and landing-try-polish-5 specs/howto, no augments.
Isolated codex/wave2-landing-try from What's New #671 plus shipped main746b05cb,
dependency-only merge890ec57f. Owner checkout and root-owned shared focus/filter
sources are untouched. Runtime/installer, streamer674 and download/donate678 frozen.

Implemented: phone form-first AuthShell with one responsive marketing disclosure,
local try-game save context with safe redirects, explicit all-audience Latest card,
CSS-matched literal Clerk palette, signed-in landing CTAs, gated Mac/browser hint,
independent opener expanders/bars, shared loss date, date control before file choice
with event isolation and busy disabling. SaveGamesCta and parsing behavior retained.

Important data detail: current What's New data has website/agent/stream-studio/
guides audiences and no all entry. The sign-in Latest card correctly renders
nothing until an explicit all-audience entry exists; tests cover future entries.

Focused verification passed 101 tests across8 suites; final typecheck and strict
changed-file lint pass. Full web suite passed6297 tests,1 skipped across657 suites.
Exact-CI production build and all unchanged budgets pass (home212.3/215 kB,
/app234.6/240, opponents175.9/180, guides169.9/175, /try228.7/240).

Actual Chromium with production CSS/fonts passed9 flow groups at360,390,1440:
real local IndexedDB counts3/0 and unavailable-storage copy; email field fixture
inside first844px; one responsive marketing node; theme palette change; actual
landing CTAs; date radio click/keyboard opens no file picker; busy controls disabled;
independent opener expansion preserves focus; no horizontal overflow/browser errors.
Reviewed screenshots include auth dark/light, signed-in landing and intake/openers.
The real production /sign-in public smoke also passes390x844 shell order/layout.

Included the notification owner's real scope-merge focus-race repair3a03620a as
e898ef81 after the full run; all15 bell integration tests plus its deterministic
focus regression and2 AuthShell tests pass. No arbitrary timing assertion change. Real Clerk cannot load against CI's dummy key;
component/browser fixture checks will state that limit rather than claim live auth.
No AI features/API calls, new infrastructure, account mutations, release/tag/install,
canonical version bump or signing claim.
