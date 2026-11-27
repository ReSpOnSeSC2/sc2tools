# ADR 0106: Stream Guardian

Status: Accepted, November 27, 2026. Extends the agent's streaming service
(`apps/agent/sc2tools_agent/streaming/`) and the Stream Dock.

## Context

- A streamer cannot see a muted microphone, dropped frames or a scene left on
  BRB from inside the game, and a warning drawn on stream or played as sound
  would reach the viewers.
- The agent already holds an obs-websocket connection and reads only whether an
  output is active. OBS also answers `GetInputMute`, `GetStreamStatus` and
  `GetCurrentProgramScene`.
- The Stream Dock is a web page inside OBS. It reaches the agent's data only
  through the server and the overlay socket rooms.

## Decision

1. Four rules, each with its own switch that starts off, in a private setting
   (`stream_guardian` in the streaming config). The streamer picks the OBS
   input that is the microphone; the app never guesses it.
2. The agent decides, the server only relays. One agent thread reads OBS on its
   own `ObsConnection`, evaluates the rules (`guardian_rules.py`, pure state
   machines over readings) and posts the list of active rules. No provider call.
3. A warning is a tray notice and a Dock banner. The notice asks Windows for no
   sound (`NIIF_NOSOUND`); overlays never receive it.
4. One warning per incident: a rule is notified when it enters the active set
   and again only after it left. Frame loss needs two bad readings and two good
   ones, so a single hiccup neither warns nor clears.
5. Cost: no OBS request at all while every switch is off; two status reads
   every 15 seconds while OBS is not live; one to four reads every 5 seconds
   while live or in a game. The rules that need a live stream do not run when it
   is not live. The one exception is the game-with-OBS-not-live rule, which by
   definition needs the not-live reading, so it also asks the plugin outputs,
   only while a game is running.
6. The server (`POST /v1/agent/streaming/guardian`) keeps the newest list per
   user in memory only, emits `overlay:guardian` to the user's room and replays
   it to a Dock that connects later. The agent repeats an unchanged list every
   minute and the server forgets a list after three minutes, so a closed agent
   cannot leave a banner behind. Nothing is stored in the database.
7. Break scenes are recognised by name (BRB, break, starting soon, intermission,
   AFK, away) instead of a fifth setting. A stream that names them otherwise
   simply never gets that warning.

## Consequences

- Unreachable OBS is "unknown" and never warns, so a streamer who does not use
  OBS sees nothing even with the switches on.
- The Dock banner needs a paired agent; the tray notice does not.
- A new overlay socket event name; widgets ignore it because they never listen.
