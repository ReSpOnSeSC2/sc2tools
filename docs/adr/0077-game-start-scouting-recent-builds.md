# ADR 0077: Game-start scouting lists each player's last five games, on the device only

Status: Accepted, November 10, 2026. Implemented in the API and the desktop
agent with this change (agent 0.25.0, not yet published). No database, flag
or infrastructure change.

## Context

- The owner asked that the scouting section shown at the start of a game
  "say the build orders each player did in their previous 5 matches", or be
  removed.
- Two private desktop views show scouting at game start. The Companion's
  floating **Scouting** report compared one earlier game against the
  opponent at a time, chosen from a picker. The loading-screen strip on the
  build check-in card showed the record, an opening forecast and a note.
- The report reads the live envelope's `streamerHistory` through
  `GET /v1/me/live/snapshot`. The strip reads the device brief
  (`GET /v1/agent/live/scouting`, `scouting:brief`, 8,192 bytes at most). The
  same envelope is also emitted to every overlay token, which is what an OBS
  Browser Source connects with.
- The app knows a build only from a game the account owner played. SC2Pulse
  lists matches without builds, and other users' games need their consent and
  at least five contributors (ADR 0065).
- The website deploys on every merge to `main`. An agent release is cut later
  from a tag, by the owner.

## Decision

1. **Two lists, newest first, five games at most each**
   (`services/scouting/recentBuilds.js`). "You" is the owner's games in this
   matchup, whoever the opponent was. "Opponent" is the owner's games against
   this player in every matchup, with linked accounts included; each row
   carries the race the player used. A row has the owner's result, the map,
   the date, the build and the game id that opens its build order.
2. **Never a guess.** The opponent's list is matched by toon handle or
   character id only. A display name alone matches nothing, so a barcode never
   borrows another account's games. No earlier game is an empty list, and both
   views say "First meeting". A read that fails leaves the lists out instead:
   the agent then draws the single-game report, and a known opponent is never
   called a first meeting. Nothing comes from other users or from SC2Pulse.
3. **The lists stay on the device.** They ride in `streamerHistory.recentBuilds`
   for the Companion's snapshot. `overlayEnvelope` removes them from both
   overlay emits (the live fan-out and the reconnect replay), so an OBS source
   receives what it received before. The spoken report is unchanged.
4. **The device brief carries a short form:** the result and the build of each
   game, names cut at 80 characters. Over the byte cap the lists are dropped
   before anything else, so they can never cost a player the strip an older
   agent already drew.
5. **Compatible both ways.** The change only adds a field. An older agent
   ignores it. The new agent tells a missing field (an older server: it draws
   the single-game report as before) from two empty lists (a real answer).
6. **A pinned report with nothing to say stays closed.** The new Companion
   setting "Keep scouting closed on a first meeting" starts on. It only gates
   the pinned report's own opening; the Scouting button still opens it, with
   the owner's five games and "First meeting" for the opponent.
7. **The agent version on `main` may run ahead of the published release.**
   `__version__` is 0.25.0 from this change on, so later agent work lands under
   one version. `FALLBACK_LATEST_AGENT_VERSION`, which the website shows as the
   version to install before release metadata loads, stays on the published
   0.24.11. `version-check` now accepts the package version or the release
   before it in `apps/agent/CHANGELOG.md`; it still fails a fallback that is
   ahead of the package or further behind.

## Consequences

- One more indexed read of at most five rows per list on the first envelope
  of a game; later ticks reuse the cached enrichment.
- In the report each player's card follows its own list, so the two build
  orders can come from different games.
- A release needs one website edit that CI no longer forces at the same
  moment: raise `FALLBACK_LATEST_AGENT_VERSION` once the agent is published.
  Until then the site names 0.24.11 for the instant before release metadata
  loads, and whenever the release feed cannot be reached.
- A future overlay widget that wants these lists on stream has to opt in by
  changing `overlayEnvelope`; it cannot receive them by accident.

## Not decided here

- Which of the two views the owner meant. Both list the games.
- How often a ladder opponent is a repeat was not measured. When it is rare,
  the opponent's list is usually empty and the report is mostly the owner's
  own five games.
