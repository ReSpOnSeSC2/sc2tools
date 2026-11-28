# ADR 0112: Pros on Ladder ships behind two gates

Status: Accepted, November 28, 2026. Adds `apps/api/src/services/proBoard.js`,
`proBoardShape.js`, `pulseClient.js`, `jobs/proBoardRefreshJob.js`,
`routes/proBoard.js` and the `/pros-on-ladder` page.

## Context

- SC2Pulse's `/sc2/api/teams` (queue, team type and league are required;
  `recent` lists the teams that just played) shows which Grandmasters played
  in the last hour and marks known pros. `/sc2/api/character-matches` with
  `proPlayerId` gives a pro's recent games, twenty a page.
- Players choose whether the site names them in public (ADR 0065), and public
  pages never identify another player (ADR 0075). SC2Pulse shows these pro
  accounts publicly, but naming them on this site is the owner's decision, and
  SC2Pulse's maintainer has not agreed to this use (ADR 0111 has the same
  open question).
- The ladder VOD finder (ADR 0111) already limits how fast the server calls
  SC2Pulse.

## Decision

1. Two server gates, both off. `SC2TOOLS_PROS_ON_LADDER_ENABLED=1` opens the
   board; `SC2TOOLS_PROS_ON_LADDER_NAMES=1` additionally shows pro names and
   only works while the board is open. With the board off, `GET
   /v1/pros-on-ladder` answers `{ "available": false }`, the page says the
   board is not available yet, and nothing reaches SC2Pulse.
2. With names off a row holds race, league, a rating rounded to 100 and how
   long ago the game was; pros are ordinary rows among the rest, and the
   server does not look any pro up, so no name, team, channel or game is read
   or held. With names on, known pros are listed first with their exact rating
   (public on SC2Pulse), team, last three 1v1 games (map, the other side's
   race, win or loss, length, age) and a link to the live channel; everyone
   else stays an anonymous row. The other player of a game is never named.
3. No visitor causes a provider call. A timer (every five minutes, off while
   the gate is off) runs one bounded refresh: one `teams` call (Grandmaster,
   1v1, recent), then at most six pro histories, each only when that pro has
   played since the last look. The route reads what the last refresh stored; a
   board older than 30 minutes is not shown (503, the page offers a retry).
4. The board and the ladder VOD finder take their SC2Pulse turns from one
   shared client (`pulseClient.js`): calls at least 1.1 seconds apart, a generic
   client name, and a caller that would wait too long is refused instead of
   queued. The finder's pacing code moved there unchanged.
5. The live link comes from the live-streams list (ADR 0108) read at refresh
   time, matching the channel named in the pro's SC2Pulse links, then the
   nickname, so a visitor never reaches Twitch or Kick either. A pro who is not
   in that list has no link.
6. The page is rebuilt every five minutes and asks `GET
   /v1/pros-on-ladder/status` (no upstream call), so a closed board shows its
   notice at once and the loading state has the shape of the board the server
   will show. It is not listed in the tools catalog until the gate opens.

## Consequences

- Opening the board is one setting after SC2Pulse's maintainer agrees; showing
  names is a second setting the owner takes separately.
- Upstream cost is about twelve calls an hour plus a history for each pro who
  played, however many people visit.
- A pro whose SC2Pulse nickname differs from their channel and has no channel
  link there shows no live link.
