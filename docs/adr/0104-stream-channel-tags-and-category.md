# ADR 0104: Channel tags and the StarCraft II category follow the game start

Status: Accepted, November 27, 2026. Extends the automatic stream title
(`apps/agent/sc2tools_agent/streaming/`).

## Context

- The agent already claims each live game start to refresh the title. Twitch
  (`PATCH helix/channels`) and Kick (`PATCH /public/v1/channels`) take tags and
  a category under the permission the title update already holds.
- The live game feed has no "custom game" flag, and the streamer's own tags on
  the channel are not known to the agent.
- Twitch accepts letters and digits only, 25 characters, ten tags. Kick
  documents ten tags and no character rule.

## Decision

1. Two switches, off by default, saved with the title settings and bound to the
   paired account: channel tags and the category guard. They claim game starts
   without owning the title, so post-sync title refreshes are unchanged.
2. The server does the reading and writing (`streamingChannel.js`), because it
   holds the grants. It reads the channel, merges, and writes at most once.
   Tags the streamer set by hand are kept: only tags the agent wrote for the
   previous game are replaced, and ours fill the places that remain.
3. One tag rule for both providers (letters and digits, 25 characters, ten
   tags), checked in the agent and again on the server. A tag that fails is
   dropped, never trimmed. Kick shows its tags only while live, so an offline
   Kick channel is skipped rather than overwritten.
4. The category is set only at a game start, only when it is not StarCraft II,
   and once per game: the receipt is saved before the call, so a restart never
   switches it back. Twitch uses its fixed StarCraft II id; Kick looks the id up
   by name once per server run.
5. A custom game is a live map outside the current ladder pool (editions
   ignored). The live feed often reports no map at game start; then the game is
   never marked custom and `ViewerGames` is simply not sent. An unknown pool
   never marks a game custom either. A Series is any running
   Series on the account's overlay tokens.
6. Tags and category run after the title and each call is its own attempt. A
   failure becomes a line in the Streams page and never reaches the title.

## Consequences

- A map renamed by a patch before the pool refreshes can read as custom for a
  few days; the cost is one extra `ViewerGames` tag.
- The agent version moves to 0.26.0 with the new settings fields.
