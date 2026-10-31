# Analysis corpus: change stamps on games (AC1, October 31 UTC)

The program remains active and incomplete. This is slice AC1 of roadmap item
`analysis-corpus-local-cache` (ledger ordinal 75): "Instant Daily Pulse, Season
Recap and Arcade: keep game history on this device and sync only changes". It
meets the item's first remaining requirement in source: every in-process games
writer that changes the served corpus stamps `updatedAt`, and a
`{userId, updatedAt}` index is built. Nothing reads the stamp yet; slice AC2 adds
the changed-since read. API paths are relative to `apps/api/src/`.

No route, response, flag, provider setting or infrastructure changes, and
nothing is user-visible. The item stays partial.

## What the stamp means

A write is semantic when it can change what `GET /v1/games/analysis-corpus`
returns: a field of `ANALYSIS_GAME_PROJECTION` (`services/games.js:33-52`), or the
row's membership, which is live, not excluded and not quarantined as a resumed
replay (`services/games.js:706-735`; `util/gameVisibility.js:4-9`).

`util/corpusUpdatedAt.js` adds top-level `updatedAt`, this process's clock when the
write is issued:

- **Change-aware.** A pipeline update, or a `$set`/`$unset` update converted to the
  equivalent pipeline with literal values, records the served fields and
  membership flags first and moves `updatedAt` only if they changed
  (`util/corpusUpdatedAt.js:9-41`). An unchanged row stays byte-identical, so an
  idempotent write still reports no modification, and a heal that rewrites the
  same value re-sends nothing. Shapes whose pipeline form would write differently
  are refused: numeric path segments, overlapping paths and an empty update
  (`util/corpusUpdatedAt.js:34-38`).
- **Always.** An update with another operator stamps on every write; today that
  is only the ingest upsert's `$setOnInsert` form, which rotates the row's
  revision on every reupload anyway. Inserted and replacement rows always carry
  the stamp (`util/corpusUpdatedAt.js:44`). The one unstamped insert is resumed
  quarantine's `$setOnInsert` (`services/games.js:598-603`), whose row is born
  quarantined and outside the corpus.

## What changed

- **Stamped writers.** Fifteen calls:
  - ingest and reupload, in both update forms (`services/games.js:487,499`), and
    resumed-replay quarantine of existing rows (`services/games.js:617`);
  - hide and unhide, pending delete and the tombstone
    (`services/gameControls.js:85,121,130`);
  - build-intent renames (`services/buildIntentAttribution.js:164,333`), which
    also cover the custom-build definition save that forwards them;
  - check-ins (`services/gameStatsBuildStateNeutral.js:90-91`), the macro surface
    (`services/gameStatsCountNeutral.js:137`), custom-build ingest tags
    (`services/gameStatsCustomBuildIngestTag.js:92`) and end-of-file
    reclassification (`services/gameStatsCustomBuildEof.js:147`);
  - opponent identity (`services/gameStatsOpponentGame.js:85-86`) and the pulse
    stamp (`services/gameStatsPulseNeutral.js:54-56`), which move the stamp only
    when the character id or the MMR changes.

  Snapshot restore stamps each restored games row before its retryable insert, so
  restored rows never keep the snapshot's old stamp
  (`services/userBackups.js:279`). The three files that docs cite by line
  (`services/games.js`, `services/gameControls.js`, `services/userBackups.js`) keep
  their line counts: each new import replaces the blank line after the writer
  imports.
- **Reviewed, not stamped.** Thirty-four calls cannot change the corpus: replay and
  playback storage markers, leases, reclassification staging, resumed-replay
  repair journals, moment receipts, the region-only patch and the ladder-map
  stamp. The inventory test names each one with its reason.
- **Removals.** Hard deletes leave no row to stamp. Account erasure, the history
  wipe and restore's first step delete through `GameStatsWrites.deleteMany`
  (`services/gameStatsWrites.js:170,182`), and erasure also deletes through its
  dynamic collection handle. AC2 must report them, with tombstones or a per-owner
  corpus version.
- **Index.** `games_user_updated_at` on `{userId: 1, updatedAt: 1, _id: 1}`, partial
  on rows that carry the stamp, so a first build scans the collection but indexes
  nothing until rows are stamped. It has its own background producer
  (`db/corpusIndexes.js:7-29`), started by the existing boot index workflow
  without holding boot (`db/connect.js:751-757`). It stays outside the guide index
  builds, whose readiness GuideStats waits on. The `_id` lets a reader page rows
  that one bulk write stamped alike.

## Why this shape

- **Issue time, not commit time.** Writes inside the owner's transaction can
  commit after their stamp, and processes' clocks differ slightly, so AC2's reader
  must keep an overlap window.
- **No churn.** A region backfill or a repeated heal would otherwise re-send every
  game of an opponent, and an idempotent rename would report a modification.
- **Out of band.** Migrations do not stamp.
  `db/migrations/2026-09-30-rename-8-pool-builds.js` rewrites `myBuild` and
  `opponent.strategy`, so a re-run would need a corpus refresh through AC2's
  corpus version.
- **Rolling deploys.** A process from before this change writes without stamps
  during a deploy's overlap, so AC2 must not trust a watermark from before the
  deploy finished.

## Tests

- `apps/api/__tests__/gamesUpdatedAtInventory.test.js` (new):
  - parses `apps/api/src` with the TypeScript compiler and classifies every write
    on a games handle as stamped, a hard delete or reviewed, against an exact
    inventory (`apps/api/__tests__/gamesUpdatedAtInventory.test.js:97-101`);
  - restore stamps before the retryable insert (`:103-107`);
  - the stamp's field list equals the served projection plus the membership
    flags, a `$set`/`$unset` update converts with literal values, unsupported
    shapes are refused, and the caller's update is never mutated (`:109-134`).
- `apps/api/__tests__/gamesUpdatedAt.mongo.test.js` (new) runs on real Mongo:
  - ingest, reupload in both forms, hide, unhide, pending delete, the tombstone,
    quarantine and restore stamp
    (`apps/api/__tests__/gamesUpdatedAt.mongo.test.js:39-71`);
  - region, identity without a character id and league writes do not, and a
    character id or MMR change does (`:73-85`);
  - a repeated identity write reports no modification, and a `$`-leading value is
    stored literally (`:87-98`);
  - a write that changes no corpus field leaves a never-stamped row unstamped,
    and the macro surface stamps on change and not on a repeat (`:100-112`);
  - the partial index exists and a changed-since read can use it (`:114-121`).
- `apps/api/__tests__/corpusStampIndex.test.js` (new): the index producer starts
  without a client deadline, reports ready or failed, and is not one of the guide
  builds (`apps/api/__tests__/corpusStampIndex.test.js:10-34`).
- Updated: twelve exact-command suites now expect the stamped form through
  `apps/api/__tests__/helpers/corpusStamp.js`, and the game-controls suite's
  tombstone key list includes `updatedAt`.

## Verification

Local checks ran at `7c0fc2a6`, based on `main` `55378835`. The receipt is
`docs/handoff/validation/analysis-corpus-updated-at/local-verification.json`.

- **API.** Whole-API types pass. Configured lint reports 765 warnings and 0
  errors. The changed files add no configured or strict message, and the new
  files pass strict lint.
- **Suites.** Ninety-seven API suites pass 1603 of 1603 cases in band, on
  cached MongoDB 7.0.14 with downloads disabled: every suite that names a stamped
  writer, the restore path or a background index. No MongoDB process was left
  over.
- **Mutation.** 10 of 10 deliberate regressions are killed: five dropped stamps
  (reupload, hide, tombstone, quarantine, restore), a stamp that ignores change,
  a corpus list missing a field, converted values that are not literal, a
  non-partial index and an unstamped pulse MMR write.

## Review

One independent, read-only review found no high or medium issue. Its low
findings are fixed or recorded here:

- The index left the guide builds for its own producer, and its key gained
  `_id`.
- Unsupported update shapes are refused, and an empty `$unset` stage is skipped.
- Real-Mongo cases cover a never-stamped row and the macro surface.
- The counts here are corrected: thirty-four reviewed calls and twelve updated
  exact-command suites.
- The ingest re-stamp on a Full Resync is recorded under Limitations.

## Limitations

- Nothing reads the stamp yet: no changed-since route, client cache or
  user-visible change. The item stays partial, with requirements 2 to 5 open.
- Stamps are taken when a write is issued, not when it commits.
- The ingest upsert's operator form stamps every reupload, so the delta after a
  Full Resync carries the whole history. Its pipeline form already exists for
  two cases and could make ingest change-aware later.
- Hard deletes and out-of-band migrations are not stamped.
- Single-process tests: no deploy-overlap, latency or savings claim.

## Remaining for the item

- **AC2, API:** `changed_since` with a cursor, tombstones for removed and excluded
  games, and `corpusVersion`; `dataRev` is not a durable change feed.
- **AC3, web:** bounded IndexedDB account and version storage, an atomic
  watermark and delta merge, and snapshot fallback.
- **AC4, web:** clearing on sign-out, account switch and Delete history.
- **AC5, web:** the one-time history gate, the count and refresh footer, Backups
  & data local bytes and Clear controls, and Help.
