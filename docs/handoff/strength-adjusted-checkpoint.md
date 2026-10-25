# Strength-adjusted win rates checkpoint

Worktree: `.worktrees/wave3-my-reviews`; branch: `codex/wave3-strength-adjusted`, based on merged benchmark main `1309693b`. The prior Mechanics branch is preserved at `475d621d` while PR709 completes its final gates.

## API and deterministic calibration

- Rating difference means **opponent replay MMR minus player replay MMR**. Expected player wins decrease as that difference grows. Elo fallback scale is 400: `p = 1 / (1 + 10^(difference / 400))`.
- A two-minute bounded, slim-only aggregation groups decided ranked 1v1 games with both replay-provenance integer ratings in 500..9999. Resumed, team, custom and unknown/AI race rows do not contribute. Out-of-range differences are excluded from fitting, never assigned to an edge bin.
- Forty-eight 25-MMR intervals cover the closed -600..+600 range; only original bins with at least 200 observations fit the curve. Weighted nonincreasing PAV pools adjacent violations. Fitting assumptions: half-win/half-loss regularization avoids exact certainty from finite corpus samples; mirrored constraints enforce rating-swap symmetry. Those constraints never increase reported original sample or supported-bin counts.
- Linear interpolation joins supported anchors; continuous Elo-shaped tails extend beyond them. Plateau inversion uses its midpoint. Performance rating is average rated-opponent MMR minus the inverse opponent-minus-player difference at the observed rated win fraction. A 0% or 100% sample has no finite performance point.
- `mmr_expectation` contains one aggregate document, atomically replaced only after an owner-safe lock check. No identities, replay payloads, detail-store reads, production migrations or upstream requests. Cached reads fail softly to deterministic Elo and never trigger recomputation.
- Scheduler reuses `jobLock` and job ledger. It waits 15 minutes after boot, checks hourly, and scans only when its last same-rule aggregate is at least 24 hours old. Freshness is checked again under the lock; the lease is extended immediately before publication. No production job was run.
- Existing maps, matchups, map-by-matchup, builds, opponent strategies and build-by-strategy groups add paired-rating counts, expected wins, rated wins above expected, performance rating and Wilson ranges in their existing aggregation passes. Raw totals remain unchanged; `excludedNoMmr` counts eligible decided 1v1 games without paired historical ratings, while `excludedIneligible` distinguishes other rows.
- Existing matchup-timeseries response adds each pair's latest 50 decided ladder games through bounded `$topN` in the same scan, with ten-game rolling performance windows and explicit missing-rating coverage. Original timeseries points retain their existing shape and values. Global deduplicated history uses the same calibration and already retains the required historical provenance fields.

Validation so far: 168 local API tests across 10 suites and one snapshot pass, full API typecheck and strict new-module lint pass. These include actual stored Victory/Defeat results, Mongo expression/pure-math parity, strict provenance, coverage exclusions, interpolation/tails, atomic publication, freshness/lock/singleflight and last-50 bounds. Existing long-file lint warnings are unchanged.

UI, Help, responsive evidence, final production build and PR gates remain in progress. No release version, signed installer, tag or AI feature was changed.
