# ADR 0110: The ladder VOD finder ships behind a gate

Status: Accepted, November 28, 2026. Adds `apps/api/src/services/ladderVods.js`,
`ladderVodSearch.js`, `twitchVideoChannels.js`, `routes/ladderVods.js` and the
`/ladder-vods` page.

## Context

- SC2Pulse's `/sc2/api/matches` lists ladder games that carry a Twitch VOD,
  filtered by race, rating, length and map, ten a page. Today the site finds
  VODs only for a player's own games.
- SC2Pulse's maintainer has agreed to aggregate balance data (ADR 0082), not to
  republishing individual matches. Until the agreement exists the finder must
  be complete but closed.
- Public pages never identify another player (ADR 0075).

## Decision

1. `SC2TOOLS_LADDER_VODS_ENABLED=1` opens the finder; it starts off. With it
   off `GET /v1/ladder-vods` answers `{ "available": false }`, the page says
   the finder is not available yet, and nothing reaches SC2Pulse or Twitch.
2. Visitors choose from fixed lists (six matchups, five rating bands, five
   length bands, the nine ladder maps by SC2Pulse id) plus an opaque page
   cursor. No free text reaches SC2Pulse, so the cache holds a small set of
   searches.
3. A search is one SC2Pulse call. Calls leave at least 1.1 seconds apart, use a
   generic client name, and a search that would wait more than about four
   seconds for its turn is refused with 503. The same search is served from the
   server's copy for five minutes; a failed refresh serves the last copy for an
   hour.
4. A result carries the streamer's Twitch VOD (opening at the game), the
   streamer's channel, both races, one rating rounded to 100, the map, the
   length and the time played. The streamer is the VOD owner (the higher rated
   one when both have a VOD). The other player's name, ids and VOD are dropped
   on the server.
5. SC2Pulse names the video, not the channel. The channel login comes from
   Twitch (`helix/videos`, one call per page, app token) and is kept per video;
   when Twitch cannot name it the result says "Watch the VOD on Twitch".
6. The page is static and reads the endpoint; the tool is not listed in the
   tools catalog until the gate is opened.

## Consequences

- Opening the finder is one environment setting, after the maintainer agrees.
- Upstream cost is bounded by the pace and the cache, not by visitors.
- A Pulse row has no per-game race, only a team's games per race; races are
  assigned from those counts and the matchup asked for, and the most played
  race stands in when no matchup is chosen.
