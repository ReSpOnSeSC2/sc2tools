# Game navigation and replay controls

Implements `game-nav-and-replay-controls` in the final plan on `codex/wave3-game-navigation`. Preserved web work was committed before main integration; the neighbor API source commit `3a7e064dbb2dbe82d94df661e8dfe00fd50aa241` is integrated as `b73c24ea`. Current source includes main through PR700 (`7464cecd`). Remote CI and merge remain required before calling this shipped.

## Behavior

Owner games provide Older/Newer links, remembered all/opponent/matchup/effective-build scope, Alt+arrow navigation, next-game prefetch and optional cached all-time H2H. Safe local source links retain list filters/hash and named build context. History restoration is used only when the browser exposes the actual matching prior entry; other browsers use the durable link. Required replay, game, build and Ladder Pulse lists share opponent links and source-aware game links. Game tabs receive descriptive titles.

Review fixes capture the actual global and supported modal filters in a separate bounded, allowlisted `fromFilters` snapshot; the actual source URL remains unchanged for history matching. Replay-local search/result/matchup/sort choices now live in the replay list URL and restore after a durable backlink or remount. Classified build dossiers retain their named effective-build cohort; custom-rule dossiers retain their name and supported filters without pretending the definition name is a stored build label. Navigation does not reevaluate custom rules or composition sample membership. The mobile games list keeps its opponent link outside the build-order disclosure button.

Replay focus enables play/pause, 10-second and fine seeks, single-loop paused steps, speed changes from 0.25× through 16×, percentage/start/end seeks, event jumps, fullscreen, music and the shortcut sheet. Text fields, native controls and dialogs retain their keys. Settings Escape still closes settings. The sheet stays inside a fullscreen player through an optional Modal portal container. Seeks have a polite announcement. Validated local preferences include rails, sides, workers, autoscroll, volume and mobile panel state, with blocked/malformed storage tolerated.

Today loads Ladder Pulse in a separate chunk with its existing pending frame, keeping navigation additions inside the unchanged first-load budget. Race chips reuse the existing four SVG assets rather than importing the full game icon catalog.

## Integrated verification

- After the review fixes: full web TypeScript and strict changed-source ESLint passed. The latest integrated run passes 229 assertions in 24 affected consumer/Help suites. A separate overlapping 116-assertion run uses real ReplayLibrary, AllGamesTable, BuildDossier and report modal consumers to cover actual cohorts, durable replay-control restoration, bounded snapshots, custom-definition labels and independent mobile opponent/disclosure activation.
- Owner-neighbor API regression runs pass 104 tests across nine real Mongo/API/public DTO/profile suites. Full API TypeScript and strict new-source lint pass. Existing service/router lint baselines are unchanged.
- Final production build and all unchanged budgets pass: landing 213.6/215kB, Today 223.6/240, game 318/440, opponent 498.3/500. The first sandbox attempt hit Windows EPERM creating Next output; escalated builds completed successfully. No budget was raised.
- Extended browser fixture: 54 checks pass at 320/390/768/1440, including title, filtered history restoration, scope persistence, fullscreen sheet containment, Alt-navigation, native button/slider guards, settings Escape and replay preference restoration. It serves actual committed UI fonts and production CSS with explicit synthetic API/auth/Next boundaries and blocks non-local requests. Header and replay screenshots are saved in `screenshots/game-navigation*.png`; inspected phone/desktop views show readable wrapped controls and no body overflow.

No new infrastructure, AI features/API calls, environment variables or production migrations. No bundle budget is raised. See `owner-game-neighbors-checkpoint.md` for API ownership, bounded reads, query plans and public DTO omission safeguards.
