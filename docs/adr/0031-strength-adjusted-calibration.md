# ADR 0031 — Replay-only strength adjustment

**Status**: Accepted for the `strength-adjusted-winrates` roadmap item
**Date**: 2026-10-25
**Related**: ADR 0019 (forward-only current opponent MMR); `docs/handoff/plan/final-plan.json`

## Context

Raw win rate mixes results against different opposition levels. Current owner or SC2Pulse ratings cannot establish the historical rating difference of a replay. Sparse empirical bins and perfect records can also imply unsupported certainty if treated as exact probabilities or capped performance ratings.

## Decision

- Eligibility requires decided ranked 1v1 games, recognized races, paired explicit replay-provenance integer MMR in 500..9999, and no resumed/hidden/deletion markers. One owner's hidden contribution never changes another owner's copy.
- Difference means **opponent minus player** MMR. Expected player wins decrease as this difference grows. Until a supported aggregate exists, use the Elo logistic with scale 400.
- A daily slim-only aggregation produces at most 48 counters: 25-MMR intervals covering the closed -600..+600 range. Out-of-range observations are omitted, never clamped into an edge bin. Only original bins with at least 200 games enter weighted nonincreasing PAV.
- Fitting assumptions are explicit: add a half-win/half-loss prior per supported original bin and mirror constraints with complementary outcomes to enforce rating-swap symmetry. Mirrored constraints do not increase reported original sample/bin counts. Linear interpolation joins anchors; continuous Elo-shaped tails extend beyond supported anchors. A flat inverse interval uses its midpoint.
- Expected wins sum only the paired-rating subset. Wins above expected subtract that sum from wins in the same subset. Publish rated counts and missing/ineligible exclusions separately from unchanged raw totals. A 0%/100% rated record has no finite performance estimate.
- Reuse existing grouped requests, a bounded latest-50 matchup facet, current scheduler/job ledger and owner-safe locks. Publish one aggregate document atomically after the lease check. Reads cache the aggregate, fail softly to Elo and never initiate a corpus rebuild.

## Consequences

This is a retrospective model of results given the recorded opposition. It does not establish causality or predict individual games. Coverage and fitting assumptions remain visible in tooltips/Help. Raw Wilson intervals express sample uncertainty independently of strength adjustment. Sparse or unavailable calibration remains usable through a documented deterministic fallback.

There is no new infrastructure or production migration. The new aggregate can be ignored on rollback; the scheduled job has a kill switch. No production job was run to validate this change. Pure numerical tests, real local Mongo regressions, consumer tests and blocked-network browser fixtures cover the implementation.
