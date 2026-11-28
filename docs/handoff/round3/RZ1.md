# RZ1: Randomizer draw on your own screen, and lighter cards in game

**Shipped (PR stacked on #997, SB3).** Under a saved Randomizer pick the desktop loading card shows the draw as a still, in the strip and, after **Play it**, in the **Locked in** bar: a custom build's first steps, then **First unit: X** (1 Gate) or **Opening pair: Gate 1 X, Gate 2 Y** (2 Gate). No animation, sound or timer. Agent 0.26.0 (unchanged), ADR 0107.

**Measured first (offscreen Qt, 10 s scaled to a minute, Win32 faked and counted).** End card "Checking your replay": 10,800 paints to 0 (busy bar removed). Overlay focus poll with no panel open: 384 wake-ups to 0. Companion Randomizer page: 306 paints to 36. Widget unit reveal: 16 renders after both Gateways lock to 0. A shown loading card with its draw: 0 paints after settling, 60 wake-ups (the once-a-second topmost re-assert, kept because SC2 can raise itself over the card).

**Decisions.**
- The agent repeats the widget's seeded draw (FNV-1a, mulberry32, two values skipped) instead of saving units, and the overlay's config step before it (`overlayRandomizerConfig.js`: current build names, the matchup's race, builds no longer offered dropped), reading `GET /v1/build-intents/options` for a Protoss matchup. JavaScript's `\s` and `trim()` sets are copied exactly.
- One fixture, `apps/web/lib/randomizer/__tests__/unitDrawParity.json` (17 cases), runs on the web through the API's own config step and the widget's `gameSpin`, and in the agent through its copies. The API change is JSDoc only: that function's options parameter is typed by the fields it reads.
- Steps only for custom builds (reference build order, else the older list, up to 4); catalog builds store none. The draw is hidden while the Randomizer gate is off, in the bar too.
- 800-line splits: `ui/build_checkin_postgame.py`, `ui/checkin_theme.py`, `tests/test_build_checkin_ui_postgame.py`.

**Verification.** Agent: 37 curated files (touched, importers, layout, desktop-theme, fit, changelog contract) 721 passed, 27 skipped (installer contract: its subprocess finds no PowerShell here). Web: tsc and eslint (changed files) clean, ui-lint clean, vitest 55 files 487 passed before the review fixes; parity, native parity and help 61 after. API tsc clean. `next build` passes; local `perf:budget` reads `/overlay/[token]` 241.0/240, `/dock/[token]` 225.7/225 and `/guides/[matchup]/[build]` 175.8/175, the usual local excess (shared JS 110 kB here, 108 kB in CI). SB3's CI read 239.7, 224.8 and 174.6; this slice grows only the overlay page chunk, 56.2 to 56.3 kB, so CI should read about 239.8. Help pages viewed signed out at 360 and 1280, light and dark (before a one-phrase wording fix in the check-in article): no sideways overflow. Mutations 10/10 killed. One review, 7 findings: 6 fixed with tests (served pool, gate off in the bar, accessible name, JS spaces, row-cache resets, late-draw growth), 1 look finding fixed by re-rendering the cards with consistent models.

**Not verified.** Frame rate or lag in StarCraft II; the topmost re-assert over a fullscreen game and overlay click-through after the poll change on real Windows; the live reads with a paired token (fake transports only); the CI budget reading (estimated above); the full agent and web suites (the orchestrator runs them).

**Owner check.** One game with the desktop card on and one with the widget's unit draw in OBS: does the game still lag?

**Follow-ups.** `/overlay/[token]` has about 0.2 kB of budget left in CI. The Companion Randomizer page's remaining 36 paints a minute come from a double status write on each refresh (older code). Ledger: none.
