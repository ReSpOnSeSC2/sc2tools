# Home-page browser replay demo

Branch: `codex/wave5-landing-demo-browser` in `.worktrees/wave3-private-scouting`. Initial source is preserved at `af1fce42`; the prior Twitch branch/head remains preserved. Local caches and engine assets are retained.

## Contract and current implementation

- Existing build flag `all` selects an intent-loaded one-file, 1v1, all-time session with policy refresh disabled. Page view does not create/download the worker. There is no API upload, API fallback, account write or local report persistence.
- The shared worker/session supplies bounded parsing, player selection, cancellation and shared errors. A pure mapper retains both complete build logs and recorded metadata. Successful parsing opens the chosen side in the existing demo editor; after closing, accessible player buttons reopen either side without parsing again.
- This replaces the previous floating switcher, which real Chromium exposed as obscuring the mobile editor title/close area. The generic editor is not edited by this feature. The separate `codex/fix-editor-owner-request-scope` lazy editor import/boundary must be retained on integration; #742 is the independent Dossier pack.
- The optional browser chunk has a finite deadline and local import/render Retry. Unsupported capabilities offer Chrome/Edge or desktop recovery. Closed/superseded operations cannot reopen a late result. Session files/results clear after the preview is projected, while the bounded warm engine can be reused.
- `off` and `admins` retain the existing rate-limited server route/health/CLI for the plan's one-release compatibility window. The old upload disclosure remains explicit. That request now has close/unmount cancellation and a whole-operation deadline. Retirement is a later explicit change after an actual release, not silently claimed by this implementation.
- `/try#home-replay-demo` answers the required FAQ. ADR0059 and `docs/instant-analysis.md` rollout step 3 describe the architecture and compatibility/rollback contract.

## Current proof

Focused actual-session, mapper, optional-island, compatibility and FAQ tests pass **24 assertions across 5 files**. Types and strict changed-source lint pass. Tests cover no boot on page view, intent warm-up, both perspectives, integrity/AI/unsupported failure without upload, retry, canceled late parse, held/rejected/rendering chunk recovery, compatibility cancellation, unknown payload rejection and complete log preservation.

Preliminary real Chromium matrix passes **212 checks and 36 captures** at 320/390/768/1440, light/dark, reduced motion and touch-sized narrow contexts. It parses the real repository `warpgate_adept_tracking.SC2Replay` through the real worker/runtime and real editor. Explicit boundaries are local Next, signed-out Clerk, analytics and the bundler's Worker URL adapter. Browser-mode API requests: **0**; external requests: **0**. Only the two explicit `off`/`admins` compatibility cases call a synthetic loopback legacy API. Pre-scroll title/close hit tests, keyboard focus return and reopening, both actual build orders, 44px player/chooser controls, unsupported recovery, FAQ navigation and overflow are checked.

These captures currently use the preceding production CSS and remain preliminary/unstaged. Representative corrected 320px light editor, 1440px dark opponent editor and 320px dark unsupported captures were opened and inspected; the obscured header is fixed. Final source integration, production build/budgets, required real Next landing Playwright proof, final CSS recapture and remote exact-head gates remain outstanding.

No engine source changed. The expected engine remains `25b300818c31d41b`; coordinate any required prebuild with the other worktrees. No old `f96` prebuild is allowed. No rollout/environment, provider, migration, installer, version or release action was performed.

## Reproduction

From `apps/web`, run the focused landing/FAQ Vitest files, `tsc --noEmit`, strict scoped lint, then a local production build with the existing Instant flag set to `all` **only in that test process** and synthetic Clerk/API configuration. Keep API origins loopback. Run the new landing case in `tests/e2e/try-instant.spec.ts` on desktop-1280 and mobile-360, then `node tests/manual/landing-demo.cjs` against final production CSS with the local Playwright browser path configured. Every browser context blocks external traffic. Manual evidence uses `docs/handoff/screenshots/landing-demo-*.png`.
