# Replay fixtures

Real `.SC2Replay` files used by the engine and agent test suites. Tests
must never rewrite these files.

| File | Source | Game |
|---|---|---|
| `warpgate_adept_tracking.SC2Replay` | Project maintainer's own ladder game | PvZ, Tourmaline LE, 1v1 ladder, 7:50, build 96883 |
| `ladder_zvt_winter_madness.SC2Replay` | sc2reader `test_replays/5.0.15/96314_0.SC2Replay` | ZvT, Winter Madness LE, 1v1 ladder, 10:51, build 96314 |
| `ladder_tvt_tourmaline.SC2Replay` | sc2reader `test_replays/5.0.15/96516_0.SC2Replay` | TvT, Tourmaline LE, 1v1 ladder, 7:24, build 96516 |
| `ladder_tvz_ever_dream_18min.SC2Replay` | sc2reader `test_replays/5.0.0.80949/2020-07-28 - (T)Ocrucius VS (Z)Rairden.SC2Replay` | TvZ, Ever Dream LE, 1v1 ladder, 18:31, build 80949 |
| `ladder_2v2_crimson_research_lab.SC2Replay` | sc2reader `test_replays/5.0.15/95405_0.SC2Replay` | 2v2 ladder, Crimson Research Lab LE, 9:13, build 95405 |

The four `ladder_*` files are copied unmodified from the
[sc2reader](https://github.com/ggtracker/sc2reader) repository at commit
`e10fc9344417d0aa9649e4ed8d6423e38f6af4c9`. sc2reader is distributed under
the MIT License (Copyright (c) 2011-2013 Graylin Kim), which permits this
redistribution with the notice retained.

Together they cover the Protoss, Terran and Zerg perspectives, a mirror
match, a long game for parse-time budgets, and a team game that browser
`/try` rejects as `not_1v1`. The Instant Analysis parity test
(`apps/agent/tests/test_instant_analysis.py`) picks up every file in this
directory automatically and parses it from every human player's
perspective, so adding a replay here extends that coverage.
