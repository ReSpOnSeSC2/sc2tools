# ADR 0001: Chrono Boost period uses cast cooldown, not buff duration

**Status**: Accepted
**Date**: 2026-04-28
**Context**: Stage 4 (macro engine calibration)

## Summary

The Protoss `chronos_expected` count was being computed against the
chrono buff *duration* (20 s) instead of the cast *cooldown* (~89 s),
producing expected counts roughly 4.5× too high for every Protoss
replay and tanking the macro score for any non-pro player. Fixed by
setting `CHRONO_PERIOD_SEC = 89` and tightening `grace_cycles` from 5
to 2 so the calibration matches MULE.

## Context

`analytics/macro_score.py` computes `chronos_expected` from total Nexus
alive-time:

    expected = sum(nexus_alive_seconds) // CHRONO_PERIOD_SEC

with `CHRONO_PERIOD_SEC` originally set to **20**. That value is the
SC2 chrono *buff duration* — how long the +50 % production speed lasts
on the target — not the time it takes a Nexus to accumulate enough
energy to cast another chrono.

The actual cast cooldown on a single Nexus is bounded by energy regen:

| Mechanic | Value | Source |
|---|---|---|
| Chrono Boost energy cost | 50 | Nexus ability (LotV+) |
| Nexus energy regen rate  | 0.5625 / game-second | Standard SC2 regen |
| Time to regen one cast   | 50 / 0.5625 ≈ **88.9 s** | div |
| Nexus starting energy    | 50 (1 cast immediately available) | LotV+ |
| Nexus max energy         | 200 (cap of 4 stored casts) | cap |

For a typical 10-minute 1-into-3-base PvT (Nexus 1: 600 s, Nexus 2: ~420 s,
Nexus 3: ~120 s; total alive ≈ 1140 s):

* **Pre-fix expected**: 1140 / 20 = **57** chronos. To dodge any
  penalty (with `grace_cycles = 5`) you needed 52 — pro-tier rapid-fire.
* **Realistic ceiling**: 1140 / 89 ≈ 13 + ~3 free-start chronos = **~16**.
  Hitting 12-15 is on-pace; the pre-fix engine called that a 25 %
  efficiency catastrophe.

## Decision

1. Set `CHRONO_PERIOD_SEC = 89`.
2. Set Protoss `grace_cycles = 2` (was 5). Rationale: with the
   corrected period, expected counts run ~10-20 for typical game
   lengths; 2 cycles is ~10-20 % slack, the same calibration band the
   MULE branch uses (grace 2 / expected ~10).
3. Pin both constants with explicit unit tests
   (`tests/test_chrono_targets.py`) so a future drive-by 20→? change
   is caught at CI time, not after a quarter of regression bug reports.

`actual` counting was already correct: the chrono fix at commits
`c728ab0` / `4107efd` folds chained `CommandManagerStateEvent`
re-executions into the count via the `last_bucket_per_pid` map. No
change there.

## Consequences

**Score migration.** Every Protoss replay's macro score will move
upward, in some cases substantially (penalties up to `CHRONO_MAX_PENALTY`
= 8 dropping to 0). No DB backfill is needed: the SPA's slim-breakdown
auto-recompute path POSTs to `/games/:id/macro-breakdown` whenever the
cached breakdown lacks `stats_events`, which is the post-Stage-8
default for every game in the library. So opening any Protoss replay
after the fix lands rewrites `meta_database.json` for that record with
the corrected score.

**List-view scores stay stale until clicked.** The leaderboard /
recent-games view reads `macro_score` from the slim record. Until a
Protoss game is opened (triggering recompute), its list-view score is
the old, suppressed value. The user opted into this in lieu of a bulk
recompute pass.

**Other races unaffected.** `INJECT_PERIOD_SEC = 29` (Queen 25 / 0.7875)
and `MULE_PERIOD_SEC = 64` (Orbital 50 / 0.7875) were already correct;
only the Protoss path was wrong.

## Alternatives considered

* **Lower the period less aggressively (e.g. 60 s)**. Rejected: 89 s
  is the physical cooldown; using a shorter value would re-introduce
  over-expectation, just less severely.
* **Keep grace at 5 to compensate**. Rejected: pairs the corrected
  period with a slack that's now ~30 % of expected, disproportionately
  forgiving compared to inject (13 %) and MULE (20 %). Easier to
  reason about with consistent calibration.
* **Bulk recompute every Protoss record on next start**. Rejected per
  user preference; auto-recompute on game-open is sufficient.

## References

* `SC2Replay-Analyzer/analytics/macro_score.py` — constants block, Protoss elif.
* `SC2Replay-Analyzer/tests/test_chrono_targets.py` — calibration pin tests.
* Original chrono-counting fix: commits `c728ab0`, `4107efd`.
