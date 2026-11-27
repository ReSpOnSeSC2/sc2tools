# ADR 0102: Humdingers account saves and play stats

Status: Accepted, November 26, 2026. Amends ADR 0101
(`docs/adr/0101-humdingers-static-game-page.md`): the game is no longer
public, and `/play/humdingers` is a host page instead of a rewrite. Amended by
ADR 0103 (`docs/adr/0103-humdingers-named-play-sessions.md`): each visit is
also kept as a play session with the account, and admins see who played.

## Context

- Humdingers kept its saves only in the browser: `localStorage` on
  sc2tools.com, keys `humdingers.save.<slot>`, JSON with `fmt:
  "humdingers-save"` and `meta.when`, `meta.playtime` and `meta.chapter`.
  A new device or cleared site data lost the game, and nothing showed whether
  anyone played.
- The owner asked for saves that follow the player's account and an admin view
  of plays and play time. They chose an SC2 Tools page that hosts the game, and
  sign-in to play.
- The game file stays an unchanged copy of the Humdingers build (ADR 0101). It
  has no SC2 Tools sign-in, and without Clerk's script a Clerk session token
  expires within about a minute.

## Decision

1. `/play/humdingers` is a Next page that runs the game full screen in a
   same-origin iframe that allows fullscreen. Middleware requires sign-in for
   it and for the file itself, through a `/play/(.*)` matcher entry. A
   top-level visit to the file (`sec-fetch-dest: document`) redirects to the
   host page. `AppShell` renders the page with `ClerkProvider` only: no header,
   footer, cookie banner or analytics over the game.
2. Saves. The host page shares `localStorage` with the game.
   - Before the frame mounts, it pulls the account's saves
     (`GET /v1/me/humdingers/saves`), writes the newer ones locally and uploads
     the local saves the account lacks.
   - While the game runs, it uploads each save the game writes, which it sees
     through `storage` events, and deletes removed slots.
   - The newest `meta.when` wins. The server makes that atomic with a
     conditional upsert on a unique `{userId, slot}` index. An older upload
     gets a 409 with the stored copy, which the host writes back only while it
     is still newer than the local save.
   - Saves are limited to 200,000 bytes and 12 slots, and only website
     sessions can use them; agent device tokens are refused.
   - `humdingers_saves` is classified `user_scoped`: it is exported with the
     account and erased with it.
3. Play stats.
   - The host reports a load, and active seconds (page visible, input in the
     last five minutes) every five minutes and on exit, with progress: the
     furthest chapter and whether a save exists. Reports go to
     `POST /v1/me/humdingers/plays`.
   - The API keeps one row per UTC day in `humdingers_play_days`, with no user
     IDs.
   - It counts unique players through an HMAC of the day and the userId with
     the server pepper, stored in `humdingers_play_players` with a 35-day TTL.
   - Admins read 7, 30 or 90-day totals at `/admin/humdingers`.
4. Neither the game build nor `public/sw.js` changes.

## Consequences

- Signed-out visitors reach sign-in before the game. The home-page card says a
  free account is needed.
- If the API is slow or down, the game starts after 4 seconds anyway, and the
  merge on a later visit catches up. Uploads at page exit are best effort: they
  use `keepalive` with a cached token, and browsers cap keepalive bodies at
  64 kB.
- "Daily players" over a range is the sum of each day's unique players
  (player-days), not the number of distinct people.
- The host depends on the game's save keys and envelope (`fmt`, `meta.when`);
  the game must keep them stable.
- The privacy policy describes the saves and the play counts.
