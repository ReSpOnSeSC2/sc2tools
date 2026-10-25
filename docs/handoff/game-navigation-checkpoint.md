# Game navigation and replay controls

Implements `game-nav-and-replay-controls` in the final plan. The preserved web work lives on `codex/wave3-game-navigation`; the neighbor API is a separate commit `3a7e064dbb2dbe82d94df661e8dfe00fd50aa241` pending integration. This checkpoint does not establish a shipped status until the integrated PR passes CI and merges.

## Behavior

Owner games provide Older/Newer links, remembered all/opponent/matchup/effective-build scope, Alt+arrow navigation, next-game prefetch and optional cached all-time H2H. Safe local source links retain list filters/hash and named build context. History restoration is used only when the browser exposes the actual matching prior entry; other browsers use the durable link. Required replay, game, build and Ladder Pulse lists share opponent links and source-aware game links. Game tabs receive descriptive titles.

Replay focus enables play/pause, 10-second and fine seeks, single-loop paused steps, speed changes from 0.25× through 16×, percentage/start/end seeks, event jumps, fullscreen, music and the shortcut sheet. Text fields, native controls and dialogs retain their keys. Settings Escape still closes settings. The sheet stays inside a fullscreen player through an optional Modal portal container. Seeks have a polite announcement. Validated local preferences include rails, sides, workers, autoscroll, volume and mobile panel state, with blocked/malformed storage tolerated.

Today loads Ladder Pulse in a separate chunk with its existing pending frame, keeping navigation additions inside the unchanged first-load budget. Race chips reuse the existing four SVG assets rather than importing the full game icon catalog.

## Verification at resume

- Previous checkpoint: 86 focused consumer assertions and 52 real browser checks passed before the final browser script gained title/fullscreen/Alt-navigation assertions. Those totals are historical, overlap, and are not a claim about the integrated head.
- Current focused navigation, replay controls and Today consumer run: 18 assertions passed in three suites.
- Current list/game/replay/build/Modal/Help consumer run: 225 assertions passed in 26 suites. Strict ESLint passes every changed/new TypeScript file.
- Production build and all unchanged budgets pass: landing 213.5/215kB, Today 223.5/240, game 317.5/440, opponent 492.3/500. The first sandbox attempt hit Windows EPERM creating Next output; the escalated retry completed successfully.
- Extended browser fixture: 54 checks pass at 320/390/768/1440, including title, filtered history restoration, scope persistence, fullscreen sheet containment, Alt-navigation, native button/slider guards, settings Escape and replay preference restoration. It serves actual committed UI fonts and production CSS with explicit synthetic API/auth/Next boundaries and blocks non-local requests. Header and replay screenshots are saved in `screenshots/game-navigation*.png`; inspected phone/desktop views show readable wrapped controls and no body overflow.

No new infrastructure, AI features/API calls, environment variables or production migrations. No bundle budget is raised. See `owner-game-neighbors-checkpoint.md` for API ownership, bounded reads, query plans and public DTO omission safeguards.
