# ADR 0097: Admin Global Trends windows read their order from snapshot indexes

Status: Accepted, November 23, 2026. Follows ADR 0095
(`docs/adr/0095-atlas-flex-database.md`) and ADR 0096
(`docs/adr/0096-trends-no-whole-history-sorts.md`).

## Context

- **Atlas Flex caps an in-memory sort at 32 MB and cannot spill to disk.**
  Admin Global Trends reads one snapshot of every player's deduplicated
  history (`admin_global_trends_history`) through the same pipelines as the
  personal Trends cards. Its Momentum, Net MMR by matchup and opponent
  drilldown cards failed for the whole platform with
  `QueryExceededMemoryLimitNoDiskUseAllowed`.
- **Their windows sorted the whole snapshot.** Measured on a local copy of
  the production games (63,466 snapshot rows, 88 players, the largest with
  12,279 rows), each of momentum's sorts needed about 533 MB (its order key,
  `sessions.mongoOrder()`, takes about 8.4 KB per row in sort memory), and
  net MMR's pairing window about 141 MB.
- **The personal cards' fix (ADR 0096) did not reach the snapshot.** A window
  takes its order from an index only if it follows the `$match` directly and
  partitions and sorts by stored fields. The snapshot had no such index, the
  adapter restored the source `_id` between the `$match` and the window, and
  momentum partitioned by a computed key (player, ladder race, queue) sorted
  by the computed `mongoOrder()`.

## Decision

1. Each snapshot row stores momentum's session series
   (`_globalSessionSeries`: player, ladder race, ladder flag, player count)
   and its `mongoOrder()` key (`_globalSessionOrder`, only for a scalar Date,
   the only rows momentum reads), computed when the snapshot is built.
2. The history collection gains two indexes. `global_trends_net_mmr` is the
   games index `net_mmr_window` with the snapshot in place of the user
   (`{ _globalSnapshotId, myToonHandle, date: -1, gameId: -1 }`).
   `global_trends_sessions` is
   `{ _globalSnapshotId, _globalSessionSeries, _globalSessionOrder }`.
3. For these cards the adapter keeps only `$match` stages before the leading
   windows, restores `_id` after them (no window reads it), and hints the
   card's index. Momentum's two windows partition by the stored series and
   sort by the stored key. The first reads its order from the index, and
   MongoDB skips the second's sort because it directly follows the first
   with the same order (ADR 0096).
4. Momentum keeps `mongoOrder()` here, so its order and results are exactly
   those of the previous admin pipeline. The personal card orders by `date`
   and `gameId` (ADR 0096); the two orders differ only for ties without a
   valid game id, which exist only in legacy rows.
5. Net MMR's next-game fields are not precomputed when the snapshot is
   built: their partition and sort fields are already stored, so the window
   itself can follow the snapshot `$match`. That avoids a second write to
   every row of every build.
6. The opponent drilldown takes each opponent's newest game, name and race
   with one `$max` of `[date, gameId, myToonHandle, ladder race, name, race]`
   instead of two `$bottom` accumulators sorted by the first four. The
   account and ladder race break the ties only this history can have (one
   replay kept for two accounts, ADR 0096), and kept rows never tie on all
   four, so the result is the same. `$group` keeps one value per opponent
   instead of a sort entry per accumulator: across the platform about
   32 MiB instead of 58 MiB, against `$group`'s 100 MB limit.

## Consequences

- Checked on a synthetic fixture of the same shape (no production data is
  copied), under Flex's limits. Sort memory for the whole platform:

  | Card | Before | After |
  |---|---|---|
  | Momentum | 540 MiB | 0.06 MiB |
  | Net MMR by matchup | 41 MiB | 0.06 MiB |
  | Opponent drilldown | 46 MiB | 0.2 MiB (3.4 MiB for a 500-row page at offset 2,000) |

  Every card answers in under 2 seconds locally.
- 185 calls (8 cohorts by 7 filter sets for each card, plus session gaps,
  time zones, matchup grouping, opponent sorts and pages) return
  byte-identical results to the previous pipelines run with disk use
  allowed.
- Storage grows by about 370 bytes per snapshot row (about 23 MB per
  generation of 63,466 rows before compression) plus the two indexes (about
  12 MB per generation). A refresh briefly keeps two generations. Building
  a snapshot takes about a second longer (3.6 seconds locally).
- Rule for admin Global Trends: a window over a whole snapshot follows the
  snapshot `$match` with only `$match` stages between them, partitions and
  sorts by stored fields, and its read hints the index that holds them.
  `apps/api/__tests__/adminGlobalTrendsFlexCards.mongo.test.js` checks the
  plans (hinted IXSCAN, no SORT, windows straight after the cursor) and runs
  the cards under a 256 KiB cap that the previous pipelines fail.
- Verified on MongoDB 7.0.14, as CI runs. Flex runs MongoDB 8.0; both the
  index-ordered window and the skipped sort of an adjacent window are
  assumed to behave the same there, as the personal cards also assume.
- Limits that remain:
  - The opponent drilldown's `$group` grows with the number of distinct
    opponents across the cohort, about 1.3 KB each, and a page sorts its
    first `offset + limit` opponents (about 1.4 KB each). An unfiltered
    whole-platform page past roughly 20,000 opponents would pass 32 MB. A
    drilldown narrowed to one race, as the chart opens it, needs a fraction.
  - The build now reads every row's ladder race. A non-string
    `myLadderRace` (validation requires a string) fails the build and so
    every card, where before it failed momentum, net MMR and progression.
  - An array in an indexed field (`date`, `gameId`, `myToonHandle`, which
    validation rejects) makes `global_trends_net_mmr` multikey for good, and
    net MMR then sorts in memory again. Momentum's index holds only computed
    values.
