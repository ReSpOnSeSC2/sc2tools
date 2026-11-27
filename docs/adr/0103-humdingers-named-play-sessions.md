# ADR 0103: Humdingers play sessions are kept with the account

Status: Accepted, November 27, 2026. Amends ADR 0102
(`docs/adr/0102-humdingers-account-saves-and-play-stats.md`): play reports no
longer stay anonymous. The anonymous daily totals remain.

## Context

- ADR 0102 kept Humdingers play stats as daily totals with no user IDs. The
  admin page showed how much the game was played, not by whom.
- The owner asked to see the players by name, with each player's play time
  and individual sessions.
- Every player is already signed in (ADR 0102), and the host page already
  reports a load, then active seconds every five minutes and on exit.

## Decision

1. Play sessions.
   - The host page's `PlayTracker` makes a random id per visit
     (`crypto.randomUUID()`, with a fallback) and sends it as `session` with
     every report to `POST /v1/me/humdingers/plays`. The API accepts 8 to 64
     characters of `A-Z a-z 0-9 _ -` and answers 400 to anything else.
   - The API upserts one row per `{userId, session}` in
     `humdingers_play_sessions`: `startedAt` (first report), `lastAt`, `loads`,
     `activeSeconds`, `maxChapter` and `saved` (true once any report had a
     save). A unique index on `{userId, session}` makes the upsert safe.
   - Reports without an id, from pages opened before this change, share one
     session per account and UTC day (`day-YYYY-MM-DD`).
   - Rows expire 90 days after they start (TTL on `expiresAt`), which covers
     the longest admin range. The collection is `user_scoped`: it is exported
     with the account (`humdingersPlaySessions`), counted in the deletion
     preview and erased with the account. Backup restore leaves it out, like
     the saves.
2. The daily totals and the 35-day player hashes from ADR 0102 stay as they
   were. The admin summary and the "By day" table still come from them, so
   they keep the history from before sessions were recorded.
3. `GET /v1/admin/humdingers/stats` also returns `players` (up to 200, newest
   activity first) and `playersTruncated`. Each player has the account's
   profile display name, BattleTag and email, the range's session count,
   active seconds, last report and furthest chapter, the newest 50 sessions,
   and a summary of the saves the account holds now (slots, the game's own
   play time, chapter and last upload). Accounts whose saves changed in the
   range are listed even without sessions, which covers play from before
   sessions were recorded.
4. `/admin/humdingers` shows a Players card above the daily table. Each name
   links to the account's admin page, and a player's session count opens that
   player's sessions.
5. The privacy policy (last updated November 27, 2026) says that sessions
   are kept with the account for 90 days and that administrators can see who
   played, with their sessions and a summary of their saves. The home-page
   card says that saves and play time are kept with the account.

## Consequences

- Sessions start on the deploy day. Before that the Players card can only
  list accounts whose saves changed in the range.
- Session counts and play time per player cover only reports sent after the
  deploy, so for older ranges they add up to less than the anonymous totals.
- A session that crosses midnight UTC belongs to the day it started, while
  the daily totals split its active seconds by report day.
- Old reports keep arriving from pages opened before the deploy until those
  tabs close. They land in the per-day session.
