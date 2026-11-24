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
3. Order-dependent group outputs use `$top` and `$bottom` instead of a
   `$sort` stage followed by `$first` or `$last`. This covers the opponent
   table's newest name and race, and progression's open and close MMR.
4. Rule for new Trends pipelines: an order over a whole history must come
   from an index (stored sort fields, nothing between the `$match` and the
   sort or window) or from `$top`/`$bottom`. The regression test
   `apps/api/__tests__/trendsSortMemory.mongo.test.js` runs the charts under
   a 512 KiB sort cap, which each chart's old pipeline fails.

## Consequences

- Verified MMR and progression need about 0.1 to 0.2 MiB of sort memory
  whatever the history size. Across 400 calls on the production copy (8
  players, up to 19 filter sets each), every output is byte-identical to the
  old pipelines.
- One more index on `games`, created at startup by `ensureIndexes`. With it,
  MongoDB can also sort a player's games by date and game id on index keys
  before fetching them.
- Admin Global Trends reuses these pipelines on its history collection, which
  has no such index. Its window still sorts there, as it did before.
- Session momentum still sorts a whole history by a composite key that must
  match the JavaScript session order. It fails under the cap for the three
  largest histories and needs its own fix.
