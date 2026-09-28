# ADR 0023: Guides capture timing samples at ingest and publish only above data floors

**Status**: Accepted
**Date**: 2026-09-28
**Owner**: Jonathan
**Related**: ADR 0018 (schema versioning), ADR 0020 (Ladder Meta opponent banding), `docs/guides.md`

## Context

SC2 Tools Guides are public build-order pages. Every number on them must
come from real ladder games synced by SC2 Tools users. The pages need win
rates by opponent league or MMR band, map, opponent strategy and game
length, plus community timings (p25, median and p75) and army compositions.

Three constraints shape the design:

1. **Heavy fields are hard to reach.** Win rates can come from the slim
   `games` rows, but timings and army counts only exist in the heavy
   `buildLog` and `macroBreakdown` fields. Those live in `game_details`, or
   gzipped in R2. Reading them for the whole corpus every night would be
   slow, costly and memory-heavy on a single 512 MB Render instance.
2. **Pages are public and must not identify anyone.** No user id, game id,
   player name, toon handle or pulse id may appear. A single prolific
   account must not be able to move a published number.
3. **`myBuild` can hold a user's private custom-build name.** It can come
   from the agent's local rules or from server-side re-tagging, so it is
   not always a classifier label.

## Decision

1. **Capture a tiny sample at ingest.** While `POST /v1/games` still holds
   the heavy fields in memory, write one `guide_samples` row per eligible
   game: milestone times, the army at 6, 8 and 10 minutes, and the band,
   era, map and result.
   - Rows are keyed by peppered HMACs of the user id and game id, so
     re-uploads are idempotent and GDPR deletion can recompute the hash.
   - Capture is synchronous extraction plus a bounded fire-and-forget
     write, so it never slows or fails an ingest.
   - The nightly job never reads `game_details` or R2.
2. **Aggregate inside MongoDB, one pipeline per matchup.**
   - Each pipeline starts on a new partial index,
     `{myBuild, opponent.race}`. Every other `games` index starts with
     `userId`.
   - Distinct users are counted in the pipeline, so user ids never reach
     Node.
   - `$setWindowFields` keeps at most 50 games per user per build per era.
3. **Publish only above floors.**
   - A displayed number needs at least 5 distinct users and 30 games.
   - A page needs at least 5 users and 100 games in the current patch.
   - Below the page floor the API returns `published: false` with no
     numbers, and the web renders a noindex page.
   - Lists are ranked by the Wilson lower bound.
4. **Allow-list catalog names.** Only openers in
   `config/guideCatalog.json` (exported from the web's build-definition
   catalog) count as builds or opponent strategies.
5. **Keep URLs stable.** Slugs are derived deterministically. A committed
   lock file pins them in both apps, and an alias table issues 301s for
   retired slugs.

## Consequences

- **History starts at deploy.** Timings exist only for games uploaded after
  capture shipped, or seeded by the admin-triggered, throttled backfill.
  Win rates, which come from slim rows, cover the full history immediately.
- **The new games index has a cost:** one extra key per game, about 40–70
  bytes. It is built in the background at boot, so a large collection can't
  delay startup.
- **Samples keep the classifier label.** Ingest captures the sample after
  the user's saved custom builds have tagged the game, so a game tagged at
  upload (or re-uploaded after tagging) never keeps a sample. A game that a
  bulk reclassification re-tags later keeps its classifier-labelled sample
  until the next backfill removes it. The win-rate aggregate excludes such
  games immediately.
- **Opponent-strategy labels are published.** They are classifier output,
  not identities.
- **Recorded times, not start times.** Timings use the build log's recorded
  times: start for buildings, completion for upgrades and morphs. The page
  labels which is which instead of subtracting research durations.
