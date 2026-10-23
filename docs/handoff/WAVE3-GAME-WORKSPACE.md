# Game workspace and shared clock

Implemented on `codex/wave3-game-workspace`, integrated with main441582d0. Scope: Wave3 `game-page-macro-workspace` and `one-game-clock`. Final remote CI and root merge remain required before calling this shipped; later roadmap items are not complete.

The owner page reuses the extracted macro body and bounded recompute hook, adds Bank and remembered chart metrics, section anchors, replay-library macro links, and lazy Macro/Builds sections. A shared clock connects supply blocks, autopsy causes, macro/chart/leak times and build rows to the mounted stage. Playback publishes at most twice per second; seeks/pause debounce timestamp URL updates without remounting the player. Banked resources are omitted without measured samples. Upgrade chips represent completed build events. Legacy public/review/modal defaults remain available.

## Validation

- 719 assertions across73 game, replay, macro, public-analysis, review and Help suites pass. A final chart/clipboard run passes192 assertions across13 suites after static SVG memoization/full metric-label wrapping. Counts overlap.
- Full web typecheck and strict ESLint on every changed/new TS source/test pass.
- Exact-CI production build passes all unchanged budgets: landing213.3/215kB, app235/240, game311.7/440, opponent487.3/500, guide171.6/175. No budget was raised.
- 73 browser checks pass at390/768/1440px, including30 repeated playing-to-build seeks, timestamp URL updates only while paused, retained player mount, nav/header clearance, focus ring, bank/upgrade visibility, saved metric choices, clipboard-denial fallback, offline Recompute,503 Retry, dark mode and no body overflow or JS errors. Actual components and production CSS run with explicit synthetic authentication/API/Next-navigation boundaries; these are not live-account checks.
- Inspected screenshots are in screenshots/game-workspace-*.png. Header fonts/static imagery use the local preview server; no real replay/account data was used.

## Review decisions

A real animation-frame race could overwrite an external seek with the prior playing position. ReplayStage now pauses/seeks in a layout effect, and MapReplayer applies its controlled time before the next frame. The repeated browser checks exercise real canvas playback, while component tests cover sequence repetition, stable stage identity, clock throttling, resource projection and upgrade completion.

The chart's series/layout and static SVG layers are memoized; playback moves its cursor and readout without rebuilding the paths. Existing nearest-prior sample semantics stay unchanged. The modal retains its own replay and controls; the owner workspace renders one full replay, with a link from the modal to the complete page.

No new API, secret, environment variable, migration, infrastructure, AI feature or AI API call. Recompute reuses the existing replay-analysis endpoint and never starts recording. Owner setup notes and Help anchors document that distinction.
