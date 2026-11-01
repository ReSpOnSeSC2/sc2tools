# ADR 0069: Keep global search lazy, local and explicit about guide availability

Status: Accepted B1 design; combined local acceptance and exact old-consumer equivalence pass; exact-head CI and production delivery remain pending. Amended 2026-11-01 for recent games, personal maps, dossier recents and public discovery (see the last section).
Date: 2026-10-27.

## Context and decision

Players need one visible way to find pages, Settings, Help and public guides. Implement the static/public part of find-anything as one normal-shell controller with a lazy runtime. Header/AppChrome Search buttons, Search first in mobile More, Ctrl/Cmd K and eligible / open the same palette. Status, token overlay and Dock branch before this controller. The closed shell retains only lightweight dispatch/state; catalogs, Help/build/widget data and anonymous metadata readers remain below the lazy import. Reuse already admitted chrome/role state; search adds no role probe.

Results are finite data, never arbitrary query-derived URLs or actions. Reuse navigation gates, Settings labels, generated Help metadata, glossary, public build definitions, widget descriptions and existing fixed actions. Rank locally with deterministic ties, at most 80 query code points, 12 tokens, eight results per group and 60 overall. Empty input may show at most eight validated static Recent destination IDs for the current viewer. Guard storage, clear on sign-out, and save no typed query, dossier name, token or arbitrary URL.

One shared dispatcher gives a connected visible local field priority for /. Keep Ctrl/Cmd K, ?, and admitted g+t/o/r/s outside editing/composition/repeat/other focus owners; g+r resolves to Reviews. Use the existing Modal/focus-scope/body-lock primitives. Keep the editable combobox, grouped listbox, disabled options, arrows/Enter and one-step Escape. More and lazy Report/Appearance/shortcut handoffs close the prior surface and retain a persistent launcher. Navigation cannot steal later destination/guard focus.

Settings registers a narrow current-owner callback into its existing requestDestination and dirty guard. Validate an available destination before advancing the action identity. Stay preserves draft, tab and full previous URL; Discard activates once. External routes from Settings use the same guard. Committed owner/route/frame identities retire old callbacks, including A-to-B-to-A, without mounting inactive forms.

## Public guide discovery

A visible Find a guide form on the hub and matchup page submits into the same palette scoped to Guides. Use authoritative opener/counter slugs and viewer-first matchup aliases, plus the existing public map-name/slug projection. Published candidates link; known unpublished candidates stay visible/unlinked as Not enough games yet; unknown availability stays disabled with explicit Retry. Do not turn a failed publication read into an empty or fully published set.

On first explicit open, read only existing anonymous /v1/guides/sitemap and /v1/guides endpoints through the existing public API base. Omit credentials/Authorization, deny redirects, verify final URLs and reject malformed/unsafe data. Typed input never changes either request. One shared subscriber-aware flight has a six-second total deadline and a streamed 1 MiB ceiling per body. Abort/error paths cancel/release actual readers; retired late responses cannot publish. Retain one successful six-hour in-memory snapshot; failures require explicit Retry rather than becoming success or launching a loop.

The sitemap's actual protocol is up to 5,000 documents plus nine matchup headings, hub and map index: accept all 5,011 canonical paths, reject 5,012 without truncation. The index exposes at most 200 published maps; reject 201. Only validated map name/slug leaves enter search. These bounds limit transport/catalog admission, not physical database scans or production cost.

The initial server-seed proposal is deliberately adjusted. Hub/matchup are React Server Components and all map metadata is not already browser data. First-open anonymous reads preserve the closed lazy boundary; do not add an eager publication lookup or serialize 200 maps solely for closed search. Server seeding is a later optimization, with no saving/speed claim.

## Evidence and release boundary

The checkpoint records 479 passing integrated tests/30 files, whole types, strict scoped lint and Help 97; a later actual-Next test-only follow-up also passed types/lint. The local real-component consumer passes eight documents and 46 AA/contrast captures with explicit framework/transport adapters. Raw incompletes, contrast arithmetic, imports/wire/storage and process closure are retained. This is bounded consumer proof, not deployed Next hydration, production authentication or product-wide AA certification.

Actual Next destination-heading assertions exposed an inherited local build environment error: NODE_ENV=test produced fallback:false for empty-static-param ISR guide routes. Its earlier all 83-budget pass remains historical; it is superseded for real Next guide-destination acceptance. Do not change guide source or patch generated manifests to conceal it. Fresh NODE_ENV=production build02 xwwEgf7EgdVusjSGKfVJi passes all 83 original route caps and unchanged asset guards, with blocking fallback null on all four guide patterns. All 1,893 consumer inputs, six package metadata files, five CSS files and two fonts match the old consumer capture byte for byte; that run retains its original build identity. All 12 actual Next public cases pass without retries/skips, including rendered counter/map destination headings. Final exact-head CI and delivery receipts remain pending. A successful URL change alone is insufficient.

Private opponent/custom-build/map quick search, replay/Community text search integration, broader map discovery, dossier recents, a dedicated results page and SEO SearchAction remain deferred. B2 requires actual query/index and owner/cache/publication decisions; no row cap proves a physical scan bound. No AI/LLM, new API route, service, index, migration, job, queue, socket, infrastructure, provider activation, optional-cache activation or agent release belongs to B1. Rollback is a code revert; no stored-data conversion is required.

See [the global-search checkpoint](../handoff/global-search-checkpoint.md) for current evidence, unsuccessful runs and final acceptance placeholders.
### Combined-source acceptance boundary

The urgent Auto-season correction is integrated without changing the39 B1 leaves. Fresh combined types/strict48lint/Help97 and779 tests/65 suites pass. Production build jZvEZw1cebKxMXLo_R51u passes the original83caps and asset/source guards;12 actual-Next cases pass. An additional two-document/eight-capture real Search→Sessions→report→Today consumer verifies Auto and ordinary preference persistence with zero violations and explicit incomplete dispositions. The former public-banner fixture classification failure is preserved; only its synthetic admission was corrected. These results do not relabel the older46-AA captures: their exact source/package/CSS/font equivalence, final B1 CI and delivery remain separate gates. See the checkpoint for current raw evidence and pending rows.

Final EQ04 keeps the original Kt consumer identity and verifies all eleven source/graph/style/runtime comparisons against combined jZv; no fresh46-AA run is invented. The same-Node root-layout delta versus urgent B0 is +3,799gzip bytes, separate from original83route caps. All local acceptance is complete; release CI and production acceptance remain pending.

## Amendment: recent games, personal maps, dossier recents and public discovery (2026-11-01)

This amendment replaces the deferrals in "Evidence and release boundary" for recent games, personal maps, dossier recents, the results page, SearchAction and Community search. It narrows two B1 rules, and only for the cases below: results never become query-derived URLs, and typed input never changes a request. Every other B1 and B2 rule stands. A private query never goes in a page URL, link, history entry, Recent, browser storage or analytics. Each part ships in its own pull request, and the API ships first.

**Recent games.** In the signed-in all-pages palette, a private query follows the B2 rule: 2-80 code points after outer trimming, and also at most 100 UTF-16 units, which is what the replay library keeps. Once it has gone 200 ms without an edit, the palette sends one authenticated GET /v1/replays?search=<query>&limit=5&sort=date_desc&enrich=none&window=recent. A newer edit, close, route change or owner change aborts it. Late answers never publish, Retry is explicit, and nothing is cached or stored.

- `enrich=none` skips the route's VOD, channel and SC2Pulse lookups and returns `streams: []`. Without it the route is unchanged.
- `window=recent` reads only the owner's latest 1,000 games, on the existing {userId, date, _id} index, under a one-second deadline. It then applies the library's usual filters and its escaped, case-insensitive contains search. It refuses a cursor or an oldest-first sort. When the deadline passes it answers 503 replay_search_deadline.
- Results therefore mean "matches among your latest 1,000 games", newest first, at most five.
- Rows link to /app/game/<validated game id>, built locally. The palette never links to /app/replays?q=.

This is the one request URL that carries a private query. On /v1/replays:

- The API redacts `search` from request logs and from stored problem reports.
- Those requests stay out of Sentry tracing, and their error events are dropped.
- A failed database read of that search is logged by code only.
- The web redacts `search` in failed-request capture and in browser Sentry breadcrumbs and spans.

Two recorders are outside the app: the hosting provider's and its edge's request logs, and database slow-operation logs. Both can still hold the URL or the filter, as they already do for the Replays page's own search box. Moving recent games into the POST body would remove that exposure. It would need a version-3 response and capacity evidence, and it is not part of this amendment.

**Personal maps.** The first valid private query of an opening reads the existing owner-scoped GET /v1/maps, unfiltered and without the query. It is the same request and the same in-memory entry Arcade uses, so it runs at most once per page session, with no revalidation and no automatic retry.

- The browser admits at most 2,000 map rows. A larger list answers "too large for quick search".
- Matching is a literal, anchored, case-insensitive prefix with Unicode simple case folding. Results are sorted most games first, at most eight, and link through privateCommandHref({kind: "map"}).
- POST /v1/search/quick keeps answering maps as deferred, so the server does no new work per query.
- GET /v1/maps aggregates the owner's whole history, as it does for Arcade, so this read has no physical scan bound.

**Opponent dossiers in Recent.** The Recent envelope becomes version 2 under the same key: {version: 2, viewer, entries}.

- Each entry is {kind: "page", id} or {kind: "opponent", pulseId}, with at most eight in all, newest first.
- Version 1 still decodes, and every write is version 2.
- A dossier is recorded when its own page opens, and only when its pulse ID has the toon-handle form: digits, "-S2-", digits, "-", digits, at most 64 characters. Any other ID, or a crafted link's text, records nothing. A stored dossier that has since been removed opens the dossier's own not-found state.
- No name, label, query, URL or time is stored. Rows read "Opponent dossier" with the pulse ID as detail, and open through the same guarded handoff as private results.
- A page whose navigation lists no Opponents hides dossier entries but keeps them stored.
- Sign-out removes the viewer's envelope of either version.
- Recent now lists entries in visit order, newest first, rather than alphabetically.

**Results page.** /search?q= is a public page rendered per request. It has robots noindex, follow, a strict-origin referrer policy, a fixed title and no sitemap entry.

- It runs the palette's guide catalog and scorer on the server, over the cached anonymous /v1/guides/sitemap and /v1/guides reads that guide pages already make.
- It lists only published guides, at most 30 per group.
- When publication is unknown it offers Retry, never an empty or fully published set. When the index is unavailable it notes that maps could not be checked.
- The query, 1-80 code points without control characters, reaches the web server only in the page's own URL. It never reaches the API, the title, Recent, storage or analytics page locations.
- The palette's one query-derived destination is "See all guide results": the fixed /search path with one bounded q, offered only in the Guides scope or to viewers known to be signed out, and built and re-validated locally.
- The Find a guide forms submit there without JavaScript.

**SearchAction is closed.** WEBSITE_JSON_LD keeps its name, url and description, which search engines still read for site names. Google stopped showing the sitelinks search box on 21 November 2024. A SearchAction would only advertise a query-URL template for a noindex page.

**Community builds for signed-out viewers.** Only when authentication has loaded with no user, an explicit edit in the all-pages palette that leaves 2-80 valid code points may send one request. After 200 ms without another edit, it sends one anonymous GET /v1/community/builds?view=quick&limit=8&q=<query> to the public API base.

- The request carries no credentials, Authorization or referrer. Redirects are denied and caching is off (no-store).
- The final URL and JSON type are verified. It has a five-second deadline, a 32 KiB streamed ceiling and a strict version-1 decoder.
- A newer edit, close, route change or sign-in aborts it. Nothing is cached, stored, added to Recent or sent to analytics.
- Rows link only to /community/builds/<validated slug>.
- Signed-in viewers never send it; their library search stays the private POST.

The API serves view=quick with an escaped, case-insensitive word-start match on title and author name.

- It returns at most eight slim rows, {slug, title, matchup, authorName, votes}, and hasMore, with no count.
- It runs under maxTimeMS 300, sends no-store, and is limited to 120 requests per minute per IP.
- Without view=quick, the route is unchanged.
- `q` on this route is redacted from request logs and reports, and kept out of Sentry like the replay search.
- No index serves it: the rows examined are bounded by the number of published builds and the deadline.

No AI or LLM call, new route, service, provider, flag, environment variable, index, migration, job or queue is added. Rollback is a code revert, web first. A reverted Recent reader treats a version-2 envelope as invalid and shows nothing, and its sign-out clearing would not remove one. Revert the dossier recorder first, and keep the version-2 decoder and its sign-out clearing for one release.
