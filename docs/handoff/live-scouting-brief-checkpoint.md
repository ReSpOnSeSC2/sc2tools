# Live scouting brief

`codex/wave3-live-scouting-brief` reuses the merged widget-manager checkout in `.worktrees/wave3-owner-neighbors`. Its original source branch/cache remain preserved. This reconciles the missing exact Wave3 `live-scouting-brief` item; the existing dossier namesake and private native scouting card did not implement these web placements.

Implemented owner card, Today loading/start brief and in-game bar, `/app/live` large screen, fail-soft wake lock, bounded opening frequencies from the existing sample, recent-game ID projection, exact-toon note/dossier actions, and an explicit stream-safe Dock projector/presenter. The actual Dock placement is next, after integrating the frozen Dock foundation. No query, collection, provider request or infrastructure was added. No AI feature or external account action occurred.

Initial proofs:24 web tests pass across model, card, SSE, Today and wake-lock consumers; the38 existing API scouting tests pass, followed by26 tests with the new frequency/current-toon/replay-ID assertions. Web/API types and scoped web lint pass. Final integrated Dock consumers, API lint, production budgets, real browser captures and independent review remain before a PR.
