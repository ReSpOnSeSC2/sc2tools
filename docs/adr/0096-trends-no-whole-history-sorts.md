# ADR 0096: Trends pipelines never sort a whole history in memory

Status: Accepted, November 23, 2026. Follows ADR 0095
(`docs/adr/0095-atlas-flex-database.md`).

## Context

- **Atlas Flex caps an in-memory sort at 32 MB and cannot spill to disk.**
  The dedicated M10 allowed 100 MB and spilled beyond that. After the move to
  Flex, the verified-MMR charts on the Trends tab (Net MMR by matchup and its
  opponent table) failed for the largest history with
  `QueryExceededMemoryLimitNoDiskUseAllowed`.
- **Measured on a local copy of the production games under the same cap.**
  The largest history (13,782 games) needed 31.5 MiB of sort memory for the
  matchup chart and 47.4 MiB for the opponent table. Most of each game's cost
  is the in-memory document itself, not its stored size, so trimming fields
  only bought 2 to 3 times more room. MMR progression needed 13.1 MiB. Of the
  23 Trends charts, only these were near or past the cap, plus session
  momentum (see Consequences).
- **The pairing window caused it.** Net MMR pairs every game with the next
  game on the same account, ladder race and queue. The `$setWindowFields`
  stage partitioned by a computed key, so MongoDB sorted the player's whole
  history in memory before pairing it.

## Decision

1. The pairing window partitions by the stored `myToonHandle` field and sorts
   by `date` and `gameId`, newest first, straight after the history `$match`.
   The new games index `net_mmr_window`
   (`{ userId: 1, myToonHandle: 1, date: -1, gameId: -1 }`) then supplies the
   order, and the window needs no in-memory sort.
2. For each ladder race (P, T, Z, R), the window takes `$min` of
   `[date, gameId, myMmr, myMmrSource]` over the games after the current one
   (`documents: ["unbounded", -1]`), counting only ranked 1v1 games of that
   race with a known account. A window that starts at the partition's first
   game needs no buffering. Every game that can be measured takes its own
   race's value, which is exactly its next game in the old account, ladder
   race and queue partition. No other game ever reads its next game, because
   its drop reason is decided first.
3. Order-dependent group outputs use `$top` and `$bottom`, or `$max` of a
   tuple that starts with the order fields, instead of a `$sort` stage
   followed by `$first` or `$last`. This covers progression's open and close
   MMR, and the opponent table's newest name and race (one `$max` of
   `[date, gameId, name, race]`, which keeps less in memory; ADR 0097).
4. Session momentum orders the filtered history by `date` and then `gameId`.
   That is the `sessions.mongoOrder()` order whenever every game id is a
   non-empty string, which validation requires. The games index
   `momentum_order` (`{ userId: 1, date: 1, gameId: 1 }`) supplies it.
   - Momentum previously used four sorts on the composite order key (an
     explicit one, then one per window). It now uses two adjacent windows
     straight after the `$match`. MongoDB skips the sort of a window that
     directly follows another with the same order, but not the sort of a
     third. Any stage between them also brings the sort back.
   - The first window takes the previous game's date and a running count of
     decided games. The second carries forward the decided count before the
     session's first game, and finds the latest earlier decided game by
     `$max` of its count.
   - A game's session position is its count minus that base. The previous
     result counts only when that game's count is past the base.
   - Counts mean the same under any order, so admin Global Trends keeps
     swapping in its own order (`mongoOrder()`) for these windows.
5. Rule for new Trends pipelines: an order over a whole history must come
   from an index (stored sort fields, nothing between the `$match` and the
   sort or window) or from `$top`/`$bottom`. The regression test
   `apps/api/__tests__/trendsSortMemory.mongo.test.js` runs the charts under
   a 512 KiB sort cap, which each chart's old pipeline fails.

## Consequences

- Verified MMR, progression and momentum need about 0.1 to 0.2 MiB of sort
  memory whatever the history size. Momentum needed 70 MiB on the largest
  history before.
- Across 640 calls on the production copy, every output is byte-identical to
  the old pipelines: 8 players, up to 19 filter sets each, and momentum at
  15, 90 and 480-minute session gaps.
- Two more indexes on `games` (`net_mmr_window`, `momentum_order`), created
  at startup by `ensureIndexes`. With them, MongoDB can also sort a player's
  games by date and game id on index keys before fetching them.
- Admin Global Trends reuses these pipelines on its history collection. Its
  snapshot stores the windows' sort fields and indexes them, so its windows
  do not sort either (ADR 0097).
- A row whose game id is missing, empty or not a string (only possible by
  bypassing validation) sorts differently than in `mongoOrder()`. That
  matters only for a tie at the same millisecond within one filtered
  history.
