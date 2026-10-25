# Owner game neighbors API checkpoint

This is the API portion of `game-nav-and-replay-controls` in the final plan. The companion web navigation, controls, help, and browser checks are owned by the integrating branch. This branch starts from main `528d1675f64804df013fc0efa9fabe1dabc10aa8` and does not change `app.js`, the replay engine, public sharing policy, or production data.

## Contract

`GET /v1/games/:gameId/neighbors` requires the signed-in owner. It returns `{ prev, next, h2h? }`, where `prev` is the immediately older matching owner game and `next` is the immediately newer one. Each end is `null` when absent. Summaries contain only bounded `gameId`, `date`, `result`, `map`, `myRace`, `myBuild`, and `opponent` display/race/pulse identity fields. The response uses `Cache-Control: private, no-store`.

`scope` accepts `all` (the default), `opponent`, `matchup`, or `build`; invalid or repeated scopes return 400. Opponent and matchup scopes derive their cohort from the owned current row. Build scope uses the stored effective `myBuild` label, including confirmed check-ins, rather than the public detector label. A missing scope identity returns null ends rather than broadening to all games. Missing, foreign, and resumed-from-replay current rows return 404.

The route carries the replay library's standard filters, plus `result`, `matchup`, and literal `q` search (with `search` as its existing alternate). It reuses the owner matcher and mixed-BSON date/id neighbor branches, so equal timestamps and legacy Date/string/number/null cohorts retain deterministic `(date, _id)` ordering.

## Read bounds and privacy

Navigation performs one owned slim current lookup and two directional slim `findOne` reads. The directional reads explicitly use the existing `{ userId: 1, date: -1, _id: -1 }` index in either direction; no new index migration is required. Extra filters can require scanning additional owner index entries, but the service does not load a full game list or hydrate heavy game details. Real Mongo explain tests assert the current owner/game index and both directional owner/date/id index plans, no blocking sort, and at most two examined documents for immediate neighbors in a 200-game corpus.

Optional `h2h: { wins, losses }` comes only from one owner/pulse `opponents.findOne` with an inclusion projection over existing cached totals. It never aggregates or fetches the full opponent dossier. Missing, invalid, or unmeasured totals are omitted; an optional cache failure does not discard navigation. The cached totals remain all-time, independent of navigation filters.

Owned replay library list/detail items now conditionally expose `opponent.pulseId`; owned opponent history rows expose `opponent_pulse_id`. Empty, control-containing, or overlong identities are omitted rather than truncated into a link. Public archive and shared-analysis DTOs still omit these owner identities. The shared-analysis route retains its existing signed-in viewer gate.

## Verification

- Real local Mongo/API regression suites: 81 tests across game neighbors, replay library service, owned replay routes, public replay routes, paginated opponent history, and profile route filters. These cover owner isolation/auth, all scopes, effective check-in labels, standard filters, mixed BSON dates and ties, malformed identities, optional H2H failure, query counts/projections, actual query plans, and public privacy.
- Owned full-profile filter and memory-bound regressions: seven tests in two suites. The new identity remains a slim scalar and does not hydrate additional details.
- Full API typecheck passes.
- New helper, route, and regression file pass strict ESLint with zero warnings. Touched existing files retain their measured baseline: games service four function-length warnings, opponents service fifteen, games router three; replay library and its test have zero. No new lint errors or warnings.
- No web or replay-engine source changed, so the integrating branch owns its combined production build, budgets, and phone/navigation checks.

No AI feature, AI API call, production mutation, or production data access was added.
