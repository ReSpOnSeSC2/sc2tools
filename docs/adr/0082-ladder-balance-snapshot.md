# ADR 0082 · Ladder balance snapshots

**Status** · Accepted. The SC2Pulse maintainer approved retaining and publishing anonymous aggregate matchup data with API credit and a backlink. Access to those statistics stays free. [Maintainer’s reply](https://github.com/sc2-pulse/sc2-pulse/discussions/758#discussioncomment-19597152)

## Published counts

For each of the three non-mirror matchups, the headline pools same-tier games across tracked regions (Americas, Europe and Korea), maps and game durations before computing a 95% Wilson interval. The API includes unknown-duration games once in the total. SC2Pulse credits a cross-tier game to both players’ tiers, so each tier displays its cross-tier cohort separately. Race comes from tracked ladder team history and excludes Random. [SC2Pulse aggregation source](https://github.com/sc2-pulse/sc2-pulse/blob/06a7590799a6a43ea705f139a1ef98f0156e509b/src/main/java/com/nephest/battlenet/sc2/model/local/dao/MapStatsFilmFrameDAO.java#L40-L132)

Wins refer to the first race in the displayed matchup. The adapter converts upstream `ZvP` wins to `PvZ` wins by subtracting from games. The snapshot date records the UTC collection day. SC2Pulse omits the first eight days of each regional season, so the collector uses the most recent season that has reached that age in all three regions. [Upstream collection source](https://github.com/sc2-pulse/sc2-pulse/blob/06a7590799a6a43ea705f139a1ef98f0156e509b/src/main/java/com/nephest/battlenet/sc2/web/service/MapService.java#L145-L178)

## Collection and publication

Enable collection on the API service with `SC2TOOLS_PULSE_BALANCE_ENABLED=1`. The job runs at 03:00 UTC and starts an initial collection when the service has no complete snapshot. It takes a MongoDB lease and records one attempt per UTC day before contacting SC2Pulse. An interrupted attempt resumes on the next scheduled day.

The collector identifies SC2 Tools and requests the 19 tiers serially, with at least two seconds between requests. It stores the latest complete snapshot per season, including tier, map, region, duration band and cohort. The daily rollup pools maps and regions. A failed fetch or invalid response leaves the previous complete bundle available. `GET /v1/ladder/balance` serves that bundle with public cache headers. The static `/balance` page displays the season, snapshot date, counts, intervals and SC2Pulse credit.

## Run the offline preview

From the repository root, run:

```sh
node apps/api/scripts/preview-ladder-balance.js apps/api/__tests__/fixtures/pulseBalance.synthetic.json
```

Supply a positive integer `season`, a UTC `asOf` day, and a `tiers` array. Each tier has a lowercase `league`, a `division` from 1 to 3 (or `null` for Grandmaster), and `rows` of `matchup`, `crossTier`, `wins` and `games`. Use one orientation per matchup (`PvT`, `PvZ`, `TvZ`). Wins refer to the first race. Rows may represent different disjoint source buckets. Any source dimensions are omitted from the output. A cohort with zero games has a null rate and interval.
