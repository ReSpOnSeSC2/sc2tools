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

Focused verification passed 101 tests across8 suites; initial typecheck and strict
changed-file lint pass. Production build, full suite and browser checks pending. Real Clerk cannot load against CI's dummy key;
component/browser fixture checks will state that limit rather than claim live auth.
No AI features/API calls, new infrastructure, account mutations, release/tag/install,
canonical version bump or signing claim.
