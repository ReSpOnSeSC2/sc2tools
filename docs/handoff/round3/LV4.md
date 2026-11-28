# LV4: Pros on Ladder

**Built, both gates off (G2, ADR 0065).** `/pros-on-ladder` shows the Grandmasters who played a 1v1 ladder game in the last hour; with names on, known pros come first with their last games and a link when they are live (ADR 0112). `GET /v1/pros-on-ladder` is public; with `SC2TOOLS_PROS_ON_LADDER_ENABLED` unset it answers `{ available: false }`, the page says the board is not available yet, and nothing reaches SC2Pulse.

**Decisions.**
- Two flags, the feature and `SC2TOOLS_PROS_ON_LADDER_NAMES` (pro names, working only while the feature is on). Names off: rows carry race, league, a rating rounded to 100 and the age; pros are not looked up, named or told apart.
- One timer refresh every five minutes: one `/teams` call (Grandmaster 1v1, `recent`), then at most six `/character-matches?proPlayerId=` calls, each only for a pro who played since the last look. No visitor triggers a provider call; the live link is matched at refresh time from LV1's `LiveStreamsService.list()`.
- LV3's pacing moved into a shared `pulseClient.js`; the finder and the board take turns on one client (1.1 s apart, generic client name, refusal instead of a queue).
- A board older than 30 minutes is not served (503, retry on the page).
- Grandmaster only (the spec's fact: 41 teams in an hour); other leagues are a later choice.
- Not in the tools list and not advertised until the gate opens.

**Owner decisions.** SC2Pulse shows these pro accounts publicly, but ADR 0065 asks for consent before this site names a player, and SC2Pulse's maintainer has not agreed to this use. Decide: (1) send the request below with LV3's, then set `SC2TOOLS_PROS_ON_LADDER_ENABLED=1`; (2) separately, whether to name pros (`SC2TOOLS_PROS_ON_LADDER_NAMES=1`), for example only after the pros or their organisations were asked. Add the page to the tools list when the gate opens.

**Draft addition to the SC2Pulse request (for the owner to send with the LV3 text).**
> I would also like a public "Pros on Ladder" page. Every five minutes one request (`/sc2/api/teams` for recent Grandmaster teams) and up to six requests (`/sc2/api/character-matches?proPlayerId=`) for the known pros who played, spaced at least a second apart with the same client name, cached on our server so visitors never reach yours. The page shows each recent Grandmaster's race, league and rating rounded to 100 without a name, and, if you and the players agree, a known pro's nickname, team, last three games and Twitch channel. SC2Pulse is credited. Is this acceptable, and do you want a different pace, client name or credit line?

**Owner checks.** After the gates are on: open the page and confirm a known pro's rating, team and last game match their SC2Pulse profile; when that pro streams, confirm the Watch link opens their channel. With names off, confirm no nickname appears in the page or in `GET /v1/pros-on-ladder`.

**Not verified:** real SC2Pulse, Twitch and Kick calls from the running service; the response shapes were read from one live probe on 2026-11-28.
