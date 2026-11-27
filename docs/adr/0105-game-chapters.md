# ADR 0105: Game chapters for the stream video

Status: Accepted, November 27, 2026. Extends the Stream Dock's clip log and the
YouTube streaming facade (`apps/api/src/services/youtubeStreaming.js`).

## Context

- The Dock's "End stream" is a web action on the API; the desktop agent is never
  told about it. The YouTube grants live on the server, and every YouTube write
  the agent makes already goes through the server's facade.
- The facade refuses to edit a completed broadcast, but the archive is exactly
  that once the stream has ended.
- A game's `date` is its replay end, so a game starts at `date - durationSec`.
- YouTube only builds chapters from a list that starts at 0:00, has at least
  three entries and keeps them ten seconds apart.

## Decision

1. The server writes the chapters at End stream (`streamChapters.js`), not the
   agent. A new facade method, `archiveDescriptions`, finds the broadcasts SC2
   Tools created (the create ledger, newest ten) that were on air during the
   stream, and edits only their description, preserving title, category, tags and
   languages as the title update does. Ownership still comes from the ledger.
2. Times count from each broadcast's own `actualStartTime`, so each video of a
   pair is exact and a late "Start new session" shifts nothing. The Dock's copy
   text counts from the marked stream start, like the clip moments.
3. The chapters live in a block between two marker lines. A second run replaces
   the block; text outside it is never touched.
4. A list that breaks a YouTube rule, or does not fit in 5,000 bytes, is not
   written, and the Dock shows the reason. A failed write is reported and never
   retried.
5. The streamer's switch is stored in the studio document and starts off. There
   is no separate server flag: the write needs the streamer's existing
   streaming consent and the switch.
6. Chapter text is game number, matchup, result and the opponent's rating
   rounded to 100: no names (ADR 0075).
7. The OBS marker is a separate agent switch on the same game-start claim as
   tags and category. It sends `CreateRecordChapter` only on OBS 30.2 or newer
   with a recording running; any refusal is silent, and it never delays the
   title.

## Consequences

- A streamer who never pressed "Start new session" and marked no go-live time
  gets a message instead of chapters.
- A broadcast created outside SC2 Tools is never edited.
