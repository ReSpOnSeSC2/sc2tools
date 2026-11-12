# ADR 0076: Every analytics event reports a normalized page

Status: Accepted, November 9, 2026. Implemented in the web app with this
change. No API, database, flag or infrastructure change. One Google Analytics
setting is left to the owner (see "Not decided here").

## Context

- Google Analytics loads only for visitors who accept it. `pageview()` already
  sent a normalized `page_location` (`apps/web/lib/analytics/pageLocation.ts`):
  `/app/game/<id>` reports as `/app/game/:gameId`, `/app/opponents/<id>` as
  `/app/opponents/:pulseId`, and only attribution parameters survive in the
  query. A game id can contain the opponent's name; an opponent id is an
  SC2Pulse id.
- Two reviews suspected that everything else still carried the raw address.
  It was measured on November 9, 2026 with a throwaway local page running the
  production container of gtag.js under the app's own `config`, every hit
  recorded and blocked (results in `docs/handoff/growth/X1.md`):
  - gtag.js fills in the browser's real address on every event that does not
    state one. That is every custom event the app sent, and every event
    gtag.js raises on its own: time on page, outbound clicks, file downloads,
    form use.
  - A location stated on one event does not stick. The next event reads the
    browser's address again.
  - The browser's referrer is repeated on every event. It is the previous
    page's full address whenever that page was on this site: a link opened in
    a new tab, a reload, any full page load.
  - gtag.js stays loaded after a client-side move onto a surface that is never
    reported (admin screens, overlay and dock pages, shared replay archives).
    The page view was skipped there, but the automatic events kept flowing,
    raw.

## Decision

1. **gtag's page state is the normalized page.** `syncAnalyticsPage` sets
   `page_location` and `page_referrer` with `gtag('set', …)`. `pageview()` does
   it before each page view, and `AppShell` does it on every navigation, so the
   events gtag.js raises on its own inherit it.
2. **The state is set before `config`.** gtag.js reads the address the moment it
   is configured; an event raised right then carried the raw one. The init
   script in `GoogleAnalytics.tsx` states the page first, and takes it from the
   router: while a client-side navigation renders, the browser's address is
   still the page being left.
3. **Custom events state their own page.** `gaEvent` attaches the normalized
   location from the browser's address at the moment of the call. A component
   can fire an event while a navigation is settling, before the new state is in
   place. A caller cannot override it.
4. **The referrer follows the same rules** (`analyticsReferrer`). A previous
   page on this site is normalized like a location, an untracked one becomes
   the site root, and another site's referrer passes through unchanged.
5. **Untracked surfaces send nothing.** Google's opt-out flag
   (`window['ga-disable-<id>']`) is the one switch that also stops automatic
   events. `syncAnalyticsOptOut` raises it unless the visitor opted in and the
   page may be measured. It is the flag's only writer: `setConsent`, the
   listener for a choice made in another tab, every wrapper call and every
   navigation go through it. Measured: no hit while the flag is up, and nothing
   held back for later.
6. **Titles come from the route policy.** The page state sets `page_title`
   to the literal template for each per-record route and `SC2 Tools` elsewhere.
   Custom events state the same title so a caller or a navigation in progress
   cannot supply a browser title. The app keeps browser titles for display.
   In the X5 offline Chromium probe, automatic events inherited the override.
   Omitting the next page's title kept the previous one, `undefined` fell back
   to the browser title, and `null` or an empty string sent a blank title.
   The explicit site label resets the state before the next page's metadata
   is available. See [X5](../handoff/growth/X5.md) for the measured results.

## Consequences

- Reports that group by page keep working and get more complete: custom and
  automatic events now land on the same page rows as page views.
- Time spent on admin screens, overlay and dock pages and shared replay
  archives is no longer measured at all.
- The special case in `lib/analytics/shareEvents.ts` is gone. Every event gets
  the same treatment in one place.
- A new per-record route must be added to `DYNAMIC_ROUTES` in
  `pageLocation.ts`, as before. A path that is not listed passes through as it
  is.

## Not decided here

- **Two of Google's "enhanced measurement" options read the browser's address
  themselves**, so nothing the page sets can change what they send. Measured
  with the production container: "Form interactions" sends `form_destination`,
  which is the raw page address for any form without an `action`; "Site
  search" sends `search_term` from a `q`, `s`, `search`, `query` or `keyword`
  parameter on page load, and the opponent list keeps its search in `?q=`.
  Both stay on, and keep sending those two values, until someone switches them
  off in Google Analytics (Admin, Data streams, the web stream, Enhanced
  measurement). That is a provider setting and the owner's to change.
