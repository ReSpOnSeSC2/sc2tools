# ADR 0019: Enrich opponent MMR forward-only from SC2Pulse

**Status**: Accepted
**Date**: 2026-07-11
**Owner**: Jonathan
**Related**: Ladder Meta Radar opponent-band reporting

## Context

The Ladder Meta Radar reports how openers perform against an opponent
band. Replays reliably carry enough information for the existing league
axis, but they do not reliably carry the opponent's MMR. Without another
source, an MMR-banded view would remain empty even as new ladder games
arrive.

SC2Pulse can resolve a character's current 1v1 ladder teams. The existing
`PulseMmrService.getRaceBreakdown` returns the highest-rated team for each
race as `Protoss`, `Terran`, `Zerg`, or `Random`. That value is current at
lookup time; SC2Pulse does not provide the opponent's rating at the replay's
game time. Applying it across the historical corpus would therefore assign
today's rating to games played months or years ago and create false
precision.

The job also has to be safe on a replicated API deployment and restrained
against SC2Pulse. A transient miss must not create an unbounded retry loop,
and one worker tick must not turn into a corpus-wide scan.

## Decision

Add a forward-only API worker that considers only ladder games with all of
the following properties:

- `opponent.mmr` is missing;
- `opponent.pulseCharacterId` is present;
- `opponent.mmrLookupAttempted` has not already been set;
- the row is a ladder game (`isLadderGame === true`, or it carries an
  opponent league for compatibility with older uploads);
- the opponent played Protoss, Terran, or Zerg; and
- `createdAt` is within a bounded recency window.

The default window is exactly 14 days. Operators may tune it with
`SC2TOOLS_OPP_MMR_ENRICH_WINDOW_DAYS`, but the implementation clamps it to
a hard maximum of 30 days. Games older than the effective `createdAt`
boundary are intentionally left null; there is no historical MMR backfill.

For each selected game, the worker calls
`PulseMmrService.getRaceBreakdown([pulseCharacterId])` and selects only the
entry for the race actually played. Both the replay value and Pulse's
title-case race value are normalized case-insensitively. It does not borrow
a player's highest rating from a different race. Random, AI,
malformed, and no-matching-race results do not receive an MMR if they reach
the processing path.

A finite, in-range result is rounded to an integer and written as
`opponent.mmr`. Whether the lookup succeeds, misses, or has no matching
race, the same atomic game update sets `opponent.mmrLookupAttempted: true`.
That marker keeps a permanent Pulse miss from being selected every 15
minutes. Rows with a preexisting `opponent.mmr` are excluded, so stored MMR
values are never overwritten.

The operational defaults are:

| Environment variable | Default | Effect |
| --- | ---: | --- |
| `SC2TOOLS_OPP_MMR_ENRICH_DISABLED` | unset | Set to `1` to disable the worker. |
| `SC2TOOLS_OPP_MMR_ENRICH_INTERVAL_SEC` | `900` | Run every 15 minutes. |
| `SC2TOOLS_OPP_MMR_ENRICH_WINDOW_DAYS` | `14` | Limit selection by `createdAt` (hard maximum 30). |
| `SC2TOOLS_OPP_MMR_ENRICH_GAMES_PER_TICK` | `25` | Cap attempted games per cycle. |

Each cycle takes the shared Mongo `jobLocks` advisory lock with an expiry,
so only one replica enriches games at a time. A process-local single-flight
guard prevents overlapping ticks in one instance. The 25-game cap and the
existing one-hour `PulseMmrService` cache further bound SC2Pulse traffic.
Logs report structured counts and identifiers only; they do not include
opponent names or battle tags.

## Why current MMR is acceptable here

The stored value is an approximation of game-time opponent MMR, not a
historical fact. Limiting enrichment to recent games keeps the lookup close
to when the game was played, while the Ladder Meta Radar's 500-point bands
tolerate modest rating drift. This is preferable to either leaving every
new MMR band empty or labeling a whole-corpus current-rating backfill as
historical data.

The downstream MMR view is expected to be sparse at launch. It will fill
and self-heal as new games are ingested and enriched; no code path assumes
that every band already has enough samples.

## Consequences

### Positive

- New ladder games gradually supply race-correct opponent MMR for aggregate
  reporting without changing the agent or replay engine.
- The recency window, marker, tick cap, cache, single-flight guard, and
  deployment-wide lock keep the job bounded and idempotent.
- Existing stored MMR values are untouched, and no per-user or opponent PII
  is added to aggregate reporting or logs.

### Neutral

- An enriched value means "current SC2Pulse MMR near game time," not exact
  replay-time MMR. Product copy and operations documentation must preserve
  that distinction.
- Sparse MMR bands and not-enough-data responses are normal until enough
  post-deployment games accumulate.

### Negative

- A transient miss is marked attempted and is not retried. This trades some
  coverage for predictable SC2Pulse load and prevents endless retries.
- Players whose rating changes sharply within the recency window can land in
  a neighboring 500-point band.
- Games outside the window remain unenriched permanently unless a separate,
  explicitly approved data policy replaces this decision.

## Alternatives considered

### Backfill the historical games corpus

Rejected. SC2Pulse exposes current MMR rather than the MMR at each game's
timestamp. A backfill would be expensive and would attach misleading values
to old games.

### Use the player's highest current race rating

Rejected. A player may have materially different ratings by race. The meta
axis describes the opponent in the actual game, so enrichment must match the
race played.

### Retry Pulse misses indefinitely

Rejected. It creates recurring external load for unresolvable characters
and makes replica behavior harder to bound. The attempted marker makes each
game a one-shot lookup.

### Infer MMR from league

Rejected. That would make the new axis a relabeling of the existing league
axis rather than an independently observed rating band.

## Rollback

Set `SC2TOOLS_OPP_MMR_ENRICH_DISABLED=1` and redeploy. This stops new lookup
and update cycles without deleting or rewriting any MMR already stored.
Reverting the worker code has the same data-safe behavior: the marker and
MMR fields are optional, and preexisting values remain untouched. Removing
enriched values would require a separate, explicit migration and is not part
of rollback.

## References

- `apps/api/src/jobs/opponentMmrEnrichmentJob.js`
- `apps/api/src/jobs/pulseBackfillJob.js`
- `apps/api/src/services/pulseMmr.js`
- `apps/api/src/validation/gameRecord.js`
- `apps/api/.env.example`
- `docs/cloud/SETUP_CLOUD.md`
