# LV3: ladder VODs

**Built, gate off (G2).** `/ladder-vods` finds recent ladder games with a Twitch VOD: pick matchup, rating band, length band and map, get ten a page with a link that opens the VOD at the game. `GET /v1/ladder-vods` is public and rate limited; with `SC2TOOLS_LADDER_VODS_ENABLED` unset it answers `{ available: false }`, the page says the finder is not available yet, and nothing reaches SC2Pulse or Twitch (ADR 0111).

**Decisions.**
- Fixed choices only; the server maps them to SC2Pulse `race`, `raceVersus`, `ratingMin/Max`, `durationMin/Max`, `mapId`, plus an opaque `after` cursor. The Map menu is the live 1v1 pool among the maps SC2Pulse's feed showed (seed 55370 to 55378, new ones learned), sent with each answer.
- One SC2Pulse call per search, at most one a second, cached 5 minutes, stale for an hour; generic client name.
- A result: channel, both races, rating rounded to 100, map, length, age. The other player is dropped on the server (ADR 0075). SC2Pulse names the video, not the channel, so the channel comes from Twitch `helix/videos` with the app token, kept per video.
- 20 searches a minute per visitor; later pages queue behind first pages. Gate-off page has no form (status route, 5-minute rebuild).
- Not in the tools list and not advertised until the gate opens; the page and sitemap entry exist.

**Owner decisions.** Send the request below, then set `SC2TOOLS_LADDER_VODS_ENABLED=1` on the API service; add the page to the tools list at that point.

**Draft request to the SC2Pulse maintainer (for the owner to send).**
> Hello, I run SC2 Tools (sc2tools.com), a free StarCraft II site. With your agreement I would like to add a public page that lists recent ladder games that have a Twitch VOD, using `/sc2/api/matches` with `vod`. A search is one request for ten games; requests leave at least a second apart, identify the site, and are cached for five minutes, so visitors never reach your server. Each result shows the streamer's Twitch channel, both races, the streamer's rating rounded to 100, the map, the length and how long ago it was played; the other player is never named. SC2Pulse is credited on the page. Is this use acceptable, and do you want a different client name, pace or credit line?

**Owner checks.** After the gate is on: search Terran vs Zerg, 5,000 to 5,999, and open one VOD at the game; check the channel name matches the VOD.

**Tests.** API jest 62 (two files), web vitest 35 (two files), 10 of 10 mutations killed. Not verified: the Playwright spec (written, not run), real SC2Pulse and Twitch calls. **Follow-up:** add the page to the tools catalog when the gate opens. **Blocked on** the SC2Pulse maintainer's agreement (G2).
