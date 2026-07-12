# ADR 0020: Band Ladder Meta Radar by opponent league or opponent MMR

**Status**: Accepted
**Date**: 2026-07-12
**Owner**: Jonathan
**Related**: ADR 0019, Ladder Meta Radar

## Context

The Ladder Meta Radar answers which openers win against a particular kind
of opponent. Its original report grouped games by `opponent.leagueId` and
matchup. Players also reason about ladder strength in MMR ranges, but an
MMR filter must retain the same point of view: "versus Diamond" and "versus
a 4000–4500 opponent" should both describe the opponent, not silently
switch one axis to the reporting player's rating.

League and MMR have different representations and availability. League is
an enum already present on most ladder rows. Opponent MMR is a numeric value
populated only for recent games by the bounded SC2Pulse enrichment described
in ADR 0019. The MMR view will therefore be sparse at launch and must become
useful naturally as new enriched games accumulate, without a historical
backfill.

The existing `ladder_meta` key, `{ leagueBand, matchup }`, cannot represent
two kinds of band. Recomputing one axis and cleaning stale rows also must not
delete rows written for the other axis.

## Decision

Store both opponent-band axes in `ladder_meta` using the common identity:

```text
{ bandType: "league" | "mmr", band: number, matchup: string }
```

League rows use the existing opponent league id as `band`. They keep the
legacy `leagueBand` and `league` fields in the stored and served shape for
backward compatibility.

MMR rows use 500-point half-open intervals. Values below `MMR_FLOOR` or at
or above `MMR_CEILING` are excluded. The public keys and labels are:

| Key | Meaning | Label |
| ---: | --- | --- |
| `1000` | `[MMR_FLOOR, 2000)` | `<2000` |
| `2000` through `6000` | `[key, key + 500)` | `2000–2500` through `6000–6500` |
| `6500` | `[6500, MMR_CEILING)` | `6500+` |

The `1000` key is a documented sentinel for the collapsed low cap and reuses
`MMR_FLOOR`; it is not a new floor. Buckets are computed with the shared
`bucketFor(mmr, 500)` helper and then clamped to the two open-ended caps.
This ensures a rating on a 500-point boundary belongs to exactly one band.

One recompute pass builds both axes with the same timestamp. Previous-opener
snapshots are keyed by `(bandType, band, matchup)`, and stale cleanup runs
only after both sets have been written. The cleanup therefore removes rows
missing from the complete pass without erasing the other axis. The existing
per-band and per-opener sample floors apply independently to every league or
MMR bucket.

The service migrates the collection index idempotently during recompute: it
removes the obsolete unique `{ leagueBand, matchup }` index when present and
ensures a unique `{ bandType, band, matchup }` index. Re-running the migration
or recompute is safe.

The public route accepts `axis=league|mmr`, numeric `band`, and `matchup`.
The legacy `leagueId` contract remains an alias for the league axis. The web
page makes the chosen axis, band, and matchup canonical URL state so every
view remains server-rendered, shareable, and crawlable.

## Consequences

### Positive

- League and MMR filters answer the same opponent-relative question.
- The aggregation, privacy floors, opener ranking, and week-over-week
  semantics stay identical across axes.
- Existing API consumers and stored league fields continue to work.
- No user or per-user identifier is stored in or served from the aggregate.

### Neutral

- MMR pages may return `not_enough_data` until enough forward-enriched games
  enter a bucket. The UI explains this and suggests League or another band.
- An MMR label displays interval boundaries (for example `4000–4500`) while
  the underlying interval remains half-open.

### Negative

- Recompute now scans the relevant slim rows for two aggregations.
- Current MMR obtained near game time can drift across a bucket boundary;
  the 500-point width reduces, but cannot eliminate, that approximation.

## Alternatives considered

### Band by the reporting player's MMR

Rejected. It changes the subject of the filter between axes and makes
comparisons such as "versus Diamond" and "versus 4000–4500" incoherent.

### Replace league banding with MMR

Rejected. League is familiar, already populated, and remains the stable
default while forward-only MMR data accumulates.

### Backfill historical opponent MMR

Rejected for the reasons in ADR 0019: SC2Pulse supplies current rating, not
the rating at each historical game's time.

### Store the two axes in separate collections

Rejected. Their row and privacy semantics are identical, and a discriminator
keeps lookup and recompute behavior simpler without duplicating infrastructure.

## Migration and rollback

The first successful recompute creates the new compound index and replaces
league rows under the new key. No games are rewritten. Rollback can restore
the league-only service and route, recreate the legacy unique index, and
ignore MMR rows. Disabling opponent-MMR enrichment as documented in ADR 0019
stops new MMR values without affecting the league report.

## References

- `apps/api/src/services/ladderMeta.js`
- `apps/api/src/routes/ladderMeta.js`
- `apps/api/src/util/mmrBracketing.js`
- `apps/web/lib/meta.ts`
- `apps/web/app/meta/page.tsx`
- `docs/adr/0019-forward-only-opponent-mmr-enrichment.md`
