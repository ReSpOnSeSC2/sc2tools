# ADR 0113: Humdingers run tapes and admin replays

Status: Accepted, November 28, 2026. Amends ADR 0103
(`docs/adr/0103-humdingers-named-play-sessions.md`): a play session can also
carry a run tape that admins replay. The title's demo is now for admins only.

## Context

- The owner asked to "save every user that plays gameplay run somehow so in the
  admin section I can watch and see how users are playing the game", to keep
  the full demo playthrough for SC2 Tools admins, and to give regular players a
  hint guide from the main menu.
- The game is deterministic: fixed 60 Hz ticks, seeded random streams (the boot
  seed is its only entropy), input latched once per tick, storage behind one
  module, the wall clock read only for save times, one 384x216 screen. Its build
  can now record a tape of a visit when its host asks: the boot seed, the storage
  values it read that it could not predict, the clock readings, and per tick the
  buttons that changed. Booting the same build with that tape reproduces the
  visit exactly; a checksum every five seconds of play tells a replay the moment
  it stops matching (the game's `docs/api/tape.md`).
- Screen recording was rejected: large uploads, battery and data on phones, and
  a recorder on the canvas. A tape is a few kilobytes per minute before gzip.
- The game file stays an unchanged copy of the build (ADR 0101). The host page
  and the game talk through `window.HUMDINGERS_HOST`, which the game reads from
  its parent window (same origin) when it boots.

## Decision

1. Before the frame mounts, the host page sets
   `window.HUMDINGERS_HOST = { v: 1, admin, record }`. `admin` is `/v1/me`'s
   `isAdmin`, fetched inside the existing 4-second wait; the game shows the
   title's "Watch a demo" only when it is true. `record` is true for signed-in
   players whose browser has `CompressionStream`. The game on its own (the
   owner's claude.ai page, local development) keeps the demo and records
   nothing.
2. Every 30 seconds and when the page hides, the host takes the new part of the
   tape from the frame (`G.tape.take()`), gzips it to base64 and posts it to
   `POST /v1/me/humdingers/tapes/:session` with the visit's play session id
   (ADR 0103) and the game's running summary (fights won and lost, game overs,
   hints read, the current goal). At page exit the newest part goes as plain
   JSON with `keepalive`, inside the 64 kB budget. A failed upload waits for the
   next pull; a 4xx answer drops the chunk so it cannot block the rest.
3. `humdingers_tape_chunks` keeps one row per chunk, unique on
   `{userId, session, seq}` so a retry never counts twice: at most 200,000
   characters a chunk, 2,000 chunks and 8,000,000 characters a session, expiring
   90 days after upload. The session's row in `humdingers_play_sessions` keeps
   the totals and the latest summary under `tape` (a tape that arrives first
   creates the row). The collection is `user_scoped`: exported with the account
   (`humdingersTapes`), counted in the deletion preview, erased with the
   account, and left out of backup restore like the saves and sessions.
4. In the Players card a session with a tape gets **Watch**.
   `/admin/humdingers/watch/<userId>/<session>` reads
   `GET /v1/admin/humdingers/tapes/:userId/:session`, sets
   `window.HUMDINGERS_HOST = { v: 1, replay: { chunks } }` and loads the game in
   a frame that takes no input. It offers play and pause, speeds 1x to 16x,
   seeking (forward in place; backward starts the tape again and
   fast-forwards), sound, a timeline marked with fights, wins, losses, game
   overs, saves, level-ups, hints and goals, grey stretches with no input for a
   minute or more, the list of what happened, the buttons held, and the goal the
   player spent longest on. The replay's storage stays in memory: the admin's
   own Humdingers saves are never read or written.
5. A replay is exact only on the build that recorded it. Each published build is
   also copied to `apps/web/public/play/builds/<build id>.html` (the 12 hex
   characters of the game's script hash, the id the game puts on every chunk);
   the publish keeps the last three copies and deletes older ones. The watch
   page uses the kept copy when it exists, else the current build with a notice
   that it matches only until the player reaches something that changed.
   Middleware keeps `/play/builds/` behind sign-in and sends a top-level visit
   to the host page, like the main file; `.gitattributes` keeps the copies'
   bytes exact.
6. Players get Hints instead of the demo: an entry on the game's title and the
   same three steps in its menu's Help tab (the story's own walkie hint, more
   help, then the exact goal and the places starred on the town map). The site
   stores nothing about hints; a hint read is a mark on the tape's timeline.
7. The privacy policy (last updated November 28, 2026) describes the replays:
   the buttons pressed and the saves, settings and save times the game reads,
   nothing outside the game, seen by administrators, kept 90 days, exported and
   deleted with the account. The home-page card says a replay of each visit is
   kept with the account, and so does a line on the game page while it loads,
   with a link to the policy (the owner chose this, "notice B", on November 28). A What's New entry (`humdingers-replays-privacy`)
   links to the policy; it is not `major`, like ADR 0103's.

## Consequences

- A closed tab, a crash or a lost connection can leave a gap; the watch page
  says so, and the replay may stop matching after it. The page-exit upload is
  best effort.
- The demo gate is a product choice, not a security boundary: the demo is the
  game's own bot, and a player with developer tools can start it.
- Each kept build adds about 10 MB to the deployment (about 30 MB for three).
  Git stores each one once: the copy has the same bytes as the main file when it
  is published, so it adds nothing to the history.
- A tape whose build is no longer kept replays on the current build until it
  stops matching; its timeline and summary stay exact.
- While the game is open, each player sends one small request every 30 seconds.
