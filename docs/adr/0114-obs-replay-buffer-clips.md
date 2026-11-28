# ADR 0114: Clips without Twitch use OBS's replay buffer

Status: Accepted, November 28, 2026. Adds `obs_replay_buffer.py`,
`clip_files.py`, `game_clips.py` and `title_clips.py` to the agent, the
`POST /v1/agent/streaming/clip` route and `services/streamSavedClip.js` to the
API, and a `clip-saved` moment kind in the Dock's clip log.

## Context

- Twitch has a clip call; Kick has none. YouTube's Data API v3 reference
  (read on 2026-11-28) lists no clips resource and no method that clips a live
  stream. Streamers on those platforms, or
  recording offline, still want the end of a game saved.
- obs-websocket has `GetReplayBufferStatus`, `SaveReplayBuffer` and
  `GetLastReplayBufferReplay`. The buffer holds only the last seconds the
  streamer set in OBS, so it catches endings, not mid-game moments.
- A replay's facts (result, matchup, opponent, map) arrive when it syncs, which
  can be after the buffer has moved on.
- The Dock's Clips panel already lists clip moments per Stream Dock token.

## Decision

1. One switch, off by default, in the title settings under a new "After each
   game" heading. Like the OBS chapter switch it needs the account paired and
   follows the account: a change of account turns it off.
2. The trigger is the game's end with a decided result (`match_ended`, not a
   replay, not an observed game), once per game. Nothing is asked of OBS during
   play. It does not wait for fight data or chat spikes.
3. A new `ReplayBufferSaver` extends the shared `ObsConnection` (no second OBS
   client). It never starts the buffer: a stopped buffer is a hint under the
   switch, shown when the switch is saved and again if a game ends without it.
4. The file is saved at once and then waits for the synced replay of that game
   to name it. If no replay names it within ten minutes it is filed with the
   date and time only. Filing moves a video file OBS just reported into a
   `Highlights` folder inside its own folder, never over another file; a failed move leaves
   the file where OBS wrote it and says so.
5. Each filed clip is reported to `POST /v1/agent/streaming/clip` (a name only,
   one line, 160 characters at most) and recorded as a `clip-saved` moment on
   each live Dock of the account, which the existing clip log lists with a
   "Clip" label and filter. The video never leaves the PC.

## Consequences

- Settings, a route and a moment kind are the only new surfaces; the Dock's
  first-load budget is untouched apart from a few bytes of a kind name.
- The clip is the last seconds before the game ended, by design.
- A streamer who never starts the buffer gets a hint, not clips.
