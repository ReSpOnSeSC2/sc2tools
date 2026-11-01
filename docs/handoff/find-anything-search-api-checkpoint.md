# Find anything: search API for recent games and Community (November 1 UTC)

Roadmap item `find-anything` (ledger ordinal 72) still needs private quick
search for recent games, personal maps and dossier recents, and public
discovery. The [ADR 0069 amendment](../adr/0069-global-search.md) dated
2026-11-01 records each decision. This slice is its API part, plus the web
report sanitiser that mirrors the API's request-log rules. It ships before
the palette changes that use it. Paths are under `apps/api` unless noted.

## What changes

| Area | Now |
| --- | --- |
| Recent games read (`src/routes/replays.js`, `src/services/replayLibrary.js`) | `GET /v1/replays` accepts `window=recent` and `enrich=none`, and only those exact strings opt in. `window=recent` calls `ReplayLibraryService.listRecent`: an aggregate over the owner's newest 1,000 games, hinted to `{userId, date, _id}`, then the usual filters and search, with `maxTimeMS` 1000, no disk use and no cursor. A cursor or `sort=date_asc` answers 400. A failure answers 503 `replay_search_deadline` or `replay_search_unavailable` and never the database message. `enrich=none` returns `streams: []` with no VOD, channel or SC2Pulse lookup. Without either parameter the route is unchanged. |
| Community quick search (`src/routes/communityQuickSearch.js`, `src/services/communityQuickSearch.js`) | `GET /v1/community/builds?view=quick&q=<2-80 code points>[&limit=1-8]` answers `{version: 1, items, hasMore}`. Items are slim rows `{slug, title, matchup, authorName, votes}`, matched as an escaped, case-insensitive word start of the title or author name in any script, most votes first, with no count, `maxTimeMS` 300 and `Cache-Control: no-store`. Any other key, a bad `q` or a bad `limit` answers 400. The limit is 120 a minute per IP, and the limiter skips every other request. Failures answer and log fixed codes. Without `view=quick` the request reaches the unchanged directory route. |
| Request logs and reports (`src/middleware/searchQueryPrivacy.js`, `requestLogging.js`; web `lib/feedback/sanitise.ts`) | `search` on `/v1/replays` and `q` on `/v1/community/builds`, counted by the key Express's qs parser reads (so `search[]`, `search[0]` and `[search]` all count), are logged as `[redacted]`. The route and every other parameter are kept. Stored problem reports pass through the same API rule, and the web sanitiser applies it before sending. |
| Sentry (`src/middleware/privateSearchTelemetry.js`) | A request URL carrying either search gets no incoming span, runs in the private-search scope with tracing suppressed, and has its error events dropped. Events are matched by URL or by Sentry's separate query string in each shape it takes. |
| Database and error logs (`src/db/connect.js`, `src/middleware/errorHandler.js`) | Reads with `search` carry the comment `sc2tools-replay-search-v1`, and Community quick reads carry `sc2tools-community-search-v1`. A failed read with either comment logs a code only, as private search already does. The error handler logs only an error's type and code for a request whose URL carries typed search. |

## What stays open for the item

The palette changes come next, each in its own pull request:

- **Private:** recent games through this read, personal maps from the existing `GET /v1/maps`, version-2 Recent with opponent dossiers, and browser Sentry redaction.
- **Public:** the noindex `/search` page, "See all guide results", and Community builds for signed-out viewers.

The palette sends neither new parameter until those pull requests merge, so this slice changes no visible behaviour.

The amendment also records the exposure this slice cannot remove. The hosting provider's and its edge's request logs, and database slow-operation logs, can still hold a replay search URL or filter. The Replays page's own search box already has the same exposure.

Platform logs aside, the following existing searches still log their text and are outside this item: `/v1/games/:id/neighbors?q=`, `/v1/export.csv?search=`, `/v1/public/replays/:handle?search=` and the admin `?q=` searches.

## Verification

- Whole-API types pass. The configured and strict lint delta against main `763a9009` adds no message. `buildReplaysRouter` falls from 69 to 65 lines.
- Related API suites pass with one in-band worker on the cached mongod 7.0.14:
  - privacy predicates, log and report tables, and the Sentry drops, spans and scope;
  - error and database-failure logs;
  - the replays route modes;
  - the Mongo-backed window, with explain showing at most 1,000 documents and 1,000 keys examined;
  - Community quick search through the real app;
  - the existing replay library, Community filter and private-search Sentry suites.
- The web sanitiser suite passes with the shared rows.
- Results of the full suite, mutations and review are recorded with the pull request.

## Rollout and rollback

No new infrastructure, environment variable, flag, provider setting, index or agent release is needed. Deploy this API before the palette pull requests that send `window=recent`, `enrich=none` or `view=quick`. An older API ignores those parameters, and the palette's decoders then fail closed.

Rollback is a code revert. Revert the palette pull requests first.
