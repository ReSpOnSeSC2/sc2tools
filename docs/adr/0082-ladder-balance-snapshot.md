# ADR 0082 · Ladder balance snapshots

**Status** · Accepted for the offline preview. Live collection and publication require G2.

The preview accepts normalized, disjoint count buckets for one season. It pools regions, maps and end-minute buckets within each matchup and league tier before computing a 95% Wilson interval. End minute records when a game finished. The headline uses same-tier games. Cross-tier counts stay separate within each tier, and their assignment across tiers requires confirmation from the maintainer.

## Run the offline preview

From the repository root, run:

```sh
node apps/api/scripts/preview-ladder-balance.js apps/api/__tests__/fixtures/pulseBalance.synthetic.json
```

Supply a positive integer `season`, a UTC `asOf` day, and a `tiers` array. Each tier has a lowercase `league`, a `division` from 1 to 3 (or `null` for Grandmaster), and `rows` of `matchup`, `crossTier`, `wins` and `games`. Use one orientation per matchup (`PvT`, `PvZ`, `TvZ`). Wins refer to the first race. Rows may represent different disjoint source buckets. Any source dimensions are omitted from the output. A cohort with zero games has a null rate and interval.

## After G2

Once the maintainer agrees in writing and confirms the source semantics, verify the adapter against a trimmed real fixture. The adapter selects one orientation and supplies disjoint counts. A dedicated collector would make 19 serial requests per nightly snapshot, pace requests at two-second intervals and identify SC2 Tools with a contact URL. Store latest complete tier snapshots and coarse daily rollups separately. An incomplete refresh keeps the last complete published bundle. Serve a cacheable bundle and a static `/balance` page with sample sizes, as-of date, methods and a link crediting SC2Pulse.

The [maintainer request](../handoff/growth/B1-maintainer-request.md) is ready for the owner to send.
