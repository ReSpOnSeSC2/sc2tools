# Find anything: quick-search fixes (October 31 UTC)

Roadmap item `find-anything` (ledger ordinal 72) still asks to "Reconcile
visible guide-search entry points, remaining original Settings/consumer
augments and all published/unpublished discovery requirements before closing
the whole item"; personal Maps quick search is deferred. A read-only audit of
the plan's spec and five augments (`docs/handoff/plan/final-plan.json`, item
`find-anything`) against the source found Settings' grouped tabs, index,
section rail and anchors done (PRs 780, 793, 794, 796). This slice fixes the
quick-search and consumer gaps that need no new decision. Paths are under
`apps/web`.

## What changes

| Gap | Now |
| --- | --- |
| Recent was erased whenever a page listed fewer destinations: the marketing header, or the app chrome before `/v1/me` answered for an admin or coach (`lib/commandSearchRecent.ts`) | A page hides the keys it does not list and keeps them stored; a visit recorded there keeps the viewer's other keys. |
| The marketing header registered its links under keys built from their URLs, so "builds" meant the Build library there and Build stats in the app; signed in, Today, Opponents and the other sections were missing, and g then t or o did nothing | Visitors get the header's public links under the app's keys (`components/chrome/headerNav.ts`). Signed in, the header registers the app's own destinations, with the app chrome's gates and descriptions, plus Help (`components/chrome/headerCommandNavigation.ts`); AppShell already loads appNav on every route, so this adds no navigation data to the marketing pages. Coaching stays out there, because the header makes no role probe. A Recent entry stored by the old header as "builds" (Build library) now shows as Build stats until eight newer visits push it out. |
| The app chrome and the header registered a new configuration on every render, and each registration rewrote Recent | Both registrations change only when their inputs do. The app chrome's gates now live in one helper, `admittedNavEntries` (`components/chrome/appNav.ts`). |
| Signed-out phones on app-chrome pages (`/community`, `/reviews`, shared links) had no search entry | An icon button opens search; signed-in phones keep the More sheet's Search row. |
| Deferred personal maps showed as a failure, with "Retry your library search", on every query | A deferred group reads "Not in quick search yet. Open the full library to browse it." and offers no Retry; retryable reasons are unchanged. |
| "Overlay and dock never mount it" had no test | AppShell's tests assert quick search is absent on overlay, dock and status routes and present on app routes. |
| The matchup page's Find a guide field prefills its matchup, and map rows have none, so a map was never found there (`lib/commandSearch.ts`) | A matchup word scopes guide rows; a map row skips it and still needs the rest of the query, so "PvZ alcyone" finds Alcyone LE and "pvz" alone finds no map. |
| Unpublished guide matches were unlinked and labelled but not greyed, and the matchup was plain text | Unpublished rows' labels are muted, and each row's matchup is a small badge. |
| A deferred map group still means the library was not fully searched | An empty result says "No public matches." rather than "No matching results"; only a failure adds "Some library results are unavailable." and Retry. |
| Stale Stream Studio copy | The crash course's Stream Dock step names the Stream Dock section of Chat & alerts; Ghost's troubleshooting, the Practice Ghost Build and OBS scene switching help articles and the starter-pack dialog name Ghost Build coach instead of the removed Look pane; and the chat troubleshooting link opens `/settings?tab=chat#platforms` instead of the Overlay tab. |

## Still open for the item

- **Private quick search.** Recent games through `/v1/replays?search=` would
  put a private query in a URL, so it needs sanitising in feedback and logs,
  and an opt-out of that route's VOD and SC2Pulse lookups. Opponent dossiers in
  Recent need an ADR 0069 amendment. Personal maps stay deferred: they need a
  new games index, or a measured plan on the existing `{userId, map, date}`
  index.
- **Public discovery.** The noindex `/search?q=` page and the site's
  `SearchAction`, and Community builds in public search, which needs an ADR
  0069 amendment because typed queries never reach a request today.
- **Settings on phones.** Devices is reachable on phones only from the Account
  quick link, a choice recorded in
  `docs/handoff/settings-registry-checkpoint.md`.

## Verification

- Related tests pass with one worker: the chrome, AppShell, quick-search and
  Stream Studio suites. New cases cover a narrower page keeping Recent, the
  header's keys and on-demand app list, the visitor phone button, deferred maps
  without Retry, the token-route guard, map search from a matchup-scoped query,
  and greyed rows with matchup badges.
- A production build passes. `npm run perf:budget` is over on this Windows
  build for both main (175.3 of 175) and this branch (175.4) on
  `/guides/[matchup]/[build]`; CI, which measured main at 174.2, is the gate.
- One independent review's verified findings are fixed: the signed-in header
  list is built at once instead of on demand, a deferred map group no longer
  turns an empty result into "No matching results", the remaining Look
  references are corrected, and the app chrome's registration has a stability
  test.
- Lint reports nothing on the changed files. No real-browser check.
