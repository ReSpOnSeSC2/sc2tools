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

Approved frozen generic editor/private-request dependency `1b56cbf6` is integrated at `8299edd3`, preserving its lazy editor import and owner fences. This includes the real root-StrictMode correction: capability invalidation is synchronous, while physical abort is deferred one microtask only when the same scope has not reactivated. The final actual PR743 squash will be reconciled before this feature's PR push.

The full web suite at the preserved preceding feature head `265888a7` passes **7,661 assertions and 849 files**, with one skipped test/file. After integrating the final shared dependency, **127 affected assertions across 17 files** and full web types pass; strict owned-source lint also passes. This includes the landing/session/mapper/optional-island cases plus lazy editor, owner request and shared private/public SWR/review consumers, including actual root-StrictMode duplicate subscribers with and without a request deadline. Coverage includes no boot on page view, intent warm-up, both perspectives, integrity/AI/unsupported failure without upload, retry, canceled late parse, held/rejected/rendering chunk recovery, compatibility cancellation, unknown payload rejection and complete log preservation. Independent read-only source review found no remaining blocker.

The final production build uses synthetic auth/API configuration and `all` only in that local test process. Every unchanged budget passes: landing **191.1/215**, Today **238.7/240**, opponent **448.1/500**, Dock **215.7/225**, widget **322.8/325**, and `/try` **234.4/240** kB gzip. The first attempt encountered a local Windows EPERM while creating generated `.next/types`; the same source completed successfully with filesystem permission on retry.

That build and the following browser evidence use feature source `986949ac`, before the shared cleanup-only StrictMode correction. The correction changes no Landing markup or CSS. Its 127 final affected tests/types pass; the reviewed images remain applicable, and the final-head remote production build remains required.

The real **production Next/Webpack** landing Playwright case passes on desktop-1280 and mobile-360: **2 tests, 15.0 seconds**. It parses the actual repository replay, confirms no engine assets on page view, opens/reopens both real build orders and sees no API-origin or upload-sized/write traffic. This proof uses Webpack's actual Worker URL with no adapter. Both app and API fixture servers exited; ports 3210/8080 were verified free and released.

The final production-CSS Chromium matrix passes **212 checks and 36 captures** at 320/390/768/1440, light/dark, reduced motion and touch-sized narrow contexts. It parses the real repository `warpgate_adept_tracking.SC2Replay` through the real worker/runtime and real editor. Explicit boundaries are local Next, signed-out Clerk, analytics and the bundler's Worker URL adapter. Browser-mode API requests: **0**; external requests: **0**. Only the two explicit `off`/`admins` compatibility cases call a synthetic loopback legacy API. Pre-scroll title/close hit tests, keyboard focus return and reopening, both actual build orders, 44px player/chooser controls, unsupported recovery, FAQ navigation and overflow are checked.

Final captures use production CSS `085eec6ea1a84fdf`, `54f1d62a562fcc18`, `9e93c7f0ce562f59`, and `c8183fd076b4bf97`. The 320px light card/editor, 320px dark chooser/unsupported, 1440px dark opponent editor and 1440px light card were opened and visually inspected. No remaining overlap, clipping or blank-capture issue was found. All 36 owned images are included as evidence. Remote exact-head gates remain required before merge.

No engine source changed. The expected engine remains `25b300818c31d41b`; coordinate any required prebuild with the other worktrees. No old `f96` prebuild is allowed. No rollout/environment, provider, migration, installer, version or release action was performed.

## Reproduction

From `apps/web`, run the focused landing/FAQ Vitest files, `tsc --noEmit`, strict scoped lint, then a local production build with the existing Instant flag set to `all` **only in that test process** and synthetic Clerk/API configuration. Keep API origins loopback. Run the new landing case in `tests/e2e/try-instant.spec.ts` on desktop-1280 and mobile-360, then `node tests/manual/landing-demo.cjs` against final production CSS with the local Playwright browser path configured. Every browser context blocks external traffic. Manual evidence uses `docs/handoff/screenshots/landing-demo-*.png`.
