# Find anything: public discovery (November 1 UTC)

This is the public half of item 72's remaining work, following the
[ADR 0069 amendment](../adr/0069-global-search.md) dated 2026-11-01. It needs
the Community quick-search API from `find-anything-search-api-checkpoint.md`
deployed first. Paths are under `apps/web`.

## What changes

| Area | Now |
| --- | --- |
| Results page (`app/search/page.tsx`, `lib/publicSearchQuery.ts`) | `/search?q=` renders per request, with a fixed title, `robots: noindex, follow`, a strict-origin referrer and no sitemap entry. It runs the palette's guide catalog and scorer on the server, over the cached anonymous `/v1/guides/sitemap` and `/v1/guides` reads guide pages already make. It lists only published guides, at most 30 per group, under Openers, How to beat and Maps; a 31st match adds a "More matches" note. Unknown publication shows Retry, never an empty or a fully published set. When the index is unavailable, a note says that map guides could not be checked. Empty, repeated, too-long (over 80 code points) and invalid searches read no guides. The query is echoed only in the form field. |
| Scorer (`lib/commandSearch.ts`) | `searchCommands` takes optional `{perGroup, total}` limits, clamped to 50 and 150; the palette keeps 8 and 60. `COMMAND_GUIDE_GROUPS` is shared, and a `community-builds` group id is added; the scorer never fills it. |
| Find a guide (`components/guides/GuideSearch.tsx`) | The form has `action="/search"`, `method="get"` and `name="q"`, so without JavaScript or a search provider it opens the results page; otherwise it still opens the guides-scoped palette. Search is no longer disabled without a provider. Without JavaScript the page searches every matchup, since the form sends only `q`; typing a matchup (for example PvZ) narrows it. |
| See all guide results (`components/chrome/CommandPalette.tsx`, `CommandSearchRuntime.tsx`, `lib/commandSearchActivation.ts`) | Once a published guide row matches, a **More** group offers "See all guide results". It links to the fixed `/search` path with one bounded `q`, and is offered only in the Guides scope or to a viewer whose authentication has loaded signed out, so a signed-in private query never reaches a URL. The activation policy admits it only when the href re-derives exactly. |
| Community builds (`lib/communityCommandSearch.ts`, `lib/useCommunityCommandSearch.ts`) | For a signed-out viewer in the all-pages palette, an explicit edit that leaves 2-80 valid code points sends, after 200 ms, one anonymous `GET /v1/community/builds?view=quick&limit=8&q=`. The request has no credentials, Authorization, referrer or redirect, a five-second deadline and a 32 KiB streamed ceiling. A strict version-1 decoder checks exact keys, unique slugs, non-rising votes, and hasMore only with eight rows. A query the palette opened with never sends. Rows link to `/community/builds/<validated slug>` and are admitted only for a viewer with no owner. The palette shows searching, empty, more (with **Open Community builds**) and failure states, with "Retry community builds". |
| Structured data (`app/page.tsx`) | No SearchAction; the comment records why. |
| Help | Describes the results page, the no-JavaScript form and Community builds for signed-out viewers. |

## Verification

- Whole-web types pass. The lint delta against the dossier branch adds no message, and the UI lint ratchet passes.
- The following pass with one worker:
  - the new results-page, public-query, Community wire and hook, and Find a guide suites;
  - the palette, scorer, parity, integration, page-title, app-level and Help suites.
- The e2e guide specs type only into the guides-scoped palette, so no Community request is made there.
- The bundle budget is unchanged in design: everything new sits under the lazy runtime import or the new `/search` route. The route is held to the default budget, and no listed budget changes. CI measures it.

## Rollout

Deploy after the API's `view=quick`. Before then, the 32 KiB ceiling and the strict decoder fail closed to "unavailable". No infrastructure, environment variable, flag, provider or agent change is needed. Rollback is a code revert.
