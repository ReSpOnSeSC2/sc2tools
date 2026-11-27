# ADR 0108: Live streams come from one server-cached list

Status: Accepted, November 27, 2026. Adds `apps/api/src/services/liveStreams.js`,
`liveStreamProviders.js`, `routes/liveStreams.js` and the `/live` page.

## Context

- The site wants a public list of live StarCraft II channels. Twitch
  (`helix/streams?game_id=`) and Kick (`/public/v2/livestreams`) both list live
  channels by game with an app token the API can already obtain.
- Calling a provider from each visitor's browser would spend the app's rate
  limit per visit and expose nothing the server cannot fetch once.
- A raid finder (LV2) and a pros board (LV4) need the same list on the server.

## Decision

1. One `LiveStreamsService.list()` is the only reader. It caches the merged
   list for 60 seconds, shares one provider fetch between concurrent callers,
   keeps a failed platform's last good list for 10 minutes as `stale`, and
   reports a platform without credentials as `off`. Other server code calls
   `list()`; nothing else calls the providers.
   An expired list is served at once while the refresh runs behind the caller,
   and each platform gets 8 seconds in a refresh (provider calls time out at 12
   seconds and the page gives up at 10), so one hanging platform never turns a
   usable list into an error. The StarCraft II category ids live in one module,
   `sc2Categories.js`, shared with the channel setup.
2. `GET /v1/live-streams` is public, rate limited and answers 503 only when
   every configured platform failed and no earlier list remains. Responses are
   cacheable for 30 seconds.
3. The page loads the list with plain `fetch`, validates the shape, accepts
   links only to the platform's own channel host, and shows no embedded player.
4. Platform and language filters and the two orders run in the browser on the
   one list; the server has no per-filter query.

## Consequences

- Cost per visit is one cached read. At most two provider calls a minute plus
  the occasional token fetch, however many people open the page.
- A revoked app token costs one failed fetch; a 401 drops the token and retries
  once.
- SC2Pulse pro identity stays out of this list; it belongs behind its own gate.
