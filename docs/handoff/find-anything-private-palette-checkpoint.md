# Find anything: recent games and personal maps in quick search (November 1 UTC)

The palette half of item 72's private quick search, following the
[ADR 0069 amendment](../adr/0069-global-search.md) dated 2026-11-01. It needs
the search API from `find-anything-search-api-checkpoint.md` deployed first.
Paths are under `apps/web`.

## What changes

| Area | Now |
| --- | --- |
| Recent games (`lib/recentGamesCommandSearch.ts`, `lib/useRecentGamesCommandSearch.ts`) | The signed-in all-pages palette searches the owner's latest 1,000 games with `GET /v1/replays?search=…&limit=5&sort=date_desc&enrich=none&window=recent`. It uses B2's literal query rule, sends nothing for a query the library would cut (over 100 UTF-16 units), and keeps the same 200 ms debounce, abort, owner epoch and five-second deadline. The GET carries no credentials, referrer or redirect, and reads at most 64 KiB. The decoder picks only `gameId`, `date`, `result`, `map`, `matchup` and the opponent's display name, and never copies `profile` or any other field. It requires `streams: []` and `nextCursor: null`, so an API that ignored `enrich=none` or `window=recent` fails closed. Rows link to `/app/game/<id>`, built locally, with the matchup as a badge and the map, result and date as detail. |
| Shared lifecycle (`lib/useOwnerCommandSearch.ts`, `lib/usePrivateCommandSearch.ts`) | B2's hook body is now `useOwnerCommandSearch(options, source)`. The private POST and recent games are two module-constant sources with independent phases, failures and Retry. `usePrivateCommandSearch` keeps its API and its 55 tests unchanged. |
| Personal maps (`lib/privateMapSearch.ts`, `lib/usePrivateMapSearch.ts`) | The first valid private query of an opening reads the owner's `GET /v1/maps`, after the debounce and unfiltered, through `useApi` and the same in-memory entry Arcade uses. It reads once per page session, with no focus or reconnect revalidation and no automatic retry, and Arcade's warm entry costs no request. The browser admits at most 2,000 rows and keeps only names and game counts. It matches a literal, anchored, case-insensitive prefix (`iu` simple case folding), most games first, at most eight. The server's deferred maps group gives way to these rows. A palette closed mid-read pauses SWR, so its abort never lands in Arcade's entry. |
| Palette (`components/chrome/CommandPalette.tsx`, `CommandSearchRuntime.tsx`) | **Your maps** shows the browser's matches or a fixed state: loading, too slow, failed, too large or partial. **Recent games** follows it. **Your library** adds **Open Replays** when recent games are shown. The status line counts every source. Retry re-runs only the sources that failed. An empty result says "No matching results" only once every source answered in full. Selection routes each row to its own source's draft and then through the provider's guarded handoff. |
| Targets (`lib/commandSearchActivation.ts`, `lib/commandSearchTarget.ts`, `lib/privateCommandSearch.ts`) | Private targets add `{kind: "game", gameId}` (1-200 units, no controls or lone surrogates, never `.` or `..`). Both constructors build `/app/game/<encoded id>` and agree in a parity test. The activation policy admits `library:games` → `/app/replays`. |
| Browser Sentry (`lib/sentryPrivacy.ts`, `lib/sentry.ts`) | With a DSN set, fetch and XHR breadcrumb URLs and request span URLs and names pass through the problem-report sanitiser before they leave the browser. That redacts replay and Community search text, credential path segments and sensitive query values, and drops span query fields. The scrubber loads by dynamic import only when Sentry does. If it cannot load, nothing is reported. |
| Help (`lib/help/articles/getting-started/keyboard-shortcuts.ts`) | Describes Your maps and Recent games. It explains that recent-games words travel in the request address, are removed from SC2 Tools' own logs and reports, and can still reach the hosting provider's request logs. |

## Still open for the item

- Opponent dossiers in Recent (version-2 envelope), in its own pull request.
- Public discovery: the noindex `/search` page, "See all guide results", and Community builds for signed-out viewers.

## Verification

- Whole-web types pass. The lint delta against main `763a9009` adds no message, and the UI lint ratchet passes.
- Related suites pass with one worker: the new recent-games, map, hook and Sentry-scrubber suites, B2's hook, wire and parity suites, the palette, provider and real lazy-consumer integration suites, and the Help suites.
- The integration suite now answers each URL separately. Each render gets its own SWR cache, and the suite asserts:
  - the POST still carries only the body query;
  - the games GET carries exactly `search`, `limit`, `sort`, `enrich` and `window`;
  - the map read has no query;
  - a game row and a map row each navigate once through the guarded handoff.

## Rollout and rollback

Deploy after the search API is live. Before then, the decoders fail closed: a missing `enrich` or `window` answer reads as unavailable, so recent games show "unavailable" rather than wrong rows. No infrastructure, environment variable, flag, provider or agent change is needed. Rollback is a code revert of this pull request, which leaves the API in place.
