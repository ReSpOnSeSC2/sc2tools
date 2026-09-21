# Build composition analysis

The build dossier shows **Army composition** immediately after performance on desktop and mobile. It opens with fixed game-time checkpoints and offers phase analysis alongside them. Classified builds use `/v1/builds/:name/phases`; custom builds use `/v1/custom-builds/:slug/compositions`. Query filters and perspective are preserved. The UI also handles older responses that contain only signature medians without inventing overall averages.

## Clock checkpoints and comparisons

`checkpoints` contains 240, 360, 480, 600 and 720 second views, each with `timeSec`, `reachedGames`, `endedGames` and `unitSummary` (`metric: "snapshot_alive"`). Only games reaching the target time qualify. Use the latest valid side sample at or before the target, at most 30 seconds earlier. Never borrow a future sample. Reached games without a recent valid sample are missing, while games ending earlier are separately counted. This makes clock views comparable without hiding declining coverage in longer games.

`comparisonGames` exposes at most 100 real cohort choices with game ID, date, map, result, races, opponent name and duration. Nullable metadata remains unavailable. The interface shows the sampled date span, perspective, matchup mix, active filters and truncation. The selector and underlying statistics retain the dossier's account and filter scope.

The optional `compareGameId` query requests `unitSummary.comparison` in each view. It resolves only within the selected cohort. Status is `observed`, `missing`, `not_reached` or `not_in_cohort`. Comparison rows contain selected `count`, other-game `median`, `p25`, `p75` and `delta` from that median. The baseline excludes the selected replay, includes observed zero counts and excludes missing observations. No peer games means null baseline statistics, never a fabricated zero baseline. Differences are neutral descriptions, not execution scores.

Comparison queries have separate account/filter/perspective/game cache and coalescing keys. The UI discards comparisons for a different selected game, shows loading/error/retry states, and revalidates comparisons when the overview changes. Refreshing cached results retain their own cohort context.

## Metric contract

Each `perPhase` row contains an additive `unitSummary`:

```ts
{
  metric: "peak_alive",
  source: "unit_timeline",
  observedGames: number,
  missingGames: number,
  emptyArmyGames: number,
  units: Array<{
    token: string,
    mean: number,
    median: number,
    p25: number,
    p75: number,
    min: number,
    max: number,
    gamesPresent: number,
    sampleGameIds: string[],
    whenPresent: { median: number, p25: number, p75: number },
    examples: {
      typical?: { gameId: string, count: number, timeSec: number },
      high?: { gameId: string, count: number, timeSec: number },
      absent?: { gameId: string, count: number, timeSec: number }
    }
  }>
}
```

For each game and unit, use the highest recorded alive count **inside that game's classified phase**. Phase boundaries are half-open `[start, end)`; the game's final phase includes its end. Do not borrow a sample from a later phase.

An explicit empty side map is an observed zero army. An absent side, malformed/incomplete count map, absent timeline, or phase without usable samples is missing data. For every unit, observed games without that unit contribute zero; missing games do not contribute. All summary counts share the same `observedGames` denominator. For example, peaks of 8, 0, and 4 plus one missing game produce a mean of 4, median of 4, and presence of 2/3—not a mean of 6 or 3.

Percentiles use linear interpolation. The middle 50% is the interquartile range, not a confidence interval. The API preserves fractional statistics; the interface displays up to one decimal place and always one decimal for the mean. Presence is `gamesPresent / observedGames`.

The eligible roster includes permanent army and support units, excluding workers, supply units, structures, eggs/cocoons, and temporary summons. Aliases are combined within each sample before the peak is selected. Input scans and output unit lists are bounded. Each unit carries at most 25 sample replay IDs, drawn from games where it appeared. The UI explicitly labels partial samples and resolves older replay metadata independently of the dossier's recent-game list.

`whenPresent` describes only games where that unit appeared. Representative examples scan the entire measured cohort: typical is closest to the conditional median, high is the maximum, and absent is a measured zero. Links use the actual recorded sample time, including the unit-specific peak time in phase mode. `/app/game/:id?t=seconds` initializes both timeline and map playback, clamps to available duration, remains paused, and never starts a capture. A representative example for one unit need not represent the overall army. Each phase also carries median start/end window times, labeled as medians rather than universal phase boundaries.

## Interpretation and source limits

- Different unit types can peak at different times. Do not sum their peaks into an army total or turn them into a simultaneous composition pie chart.
- These are sampled alive counts, not cumulative units produced. Short-lived units can fall between samples.
- Existing build logs omit some unit morph completions and lack the identifiers needed for reliable deduplication. A production metric needs a separate complete tracker-derived production stream; it must not be inferred from alive deltas or build-log row counts.
- Common unit groups use the same phase observations, grouped by the unordered set of up to three dominant unit types. Their legacy counts are conditional medians among games containing that unit, clearly distinguished from the whole-cohort summary.
- First-seen tech times use the earliest valid timestamp. Upgrade milestones use completion time when available. Their timing ranges include only games where the milestone was recorded by the phase midpoint.
- Phase win/loss associations do not establish the effect of a composition on the outcome.

The replay extractor now retains timestamped unit forms rather than applying each unit's final morph retroactively. It excludes cocoon intervals and explicit hallucinations and resolves completion events against historical type information. **Previously stored timelines require reprocessing to gain this correction.** No historical data migration or production reprocessing is performed by this change. Unflagged hallucinations and the existing sample resolution remain limitations.

## Presentation and validation

Mobile keeps the unit, mean, and presence visible. Frequency is the default sort. Each row expands to show median, quartiles, full range, when-present statistics, measured replay examples and sample games. Desktop adds the interquartile range as a visible column. Selected-game comparisons stack on small screens. Unit groups, methodology, progression and tech milestones use disclosure controls. Phase tabs support arrow keys, Home, and End; controls use visible focus states and touch-sized targets. Sample navigation moves keyboard focus to the results.

Validation covers statistical denominators, absent versus missing units, strict boundaries, stale/future samples, malformed counts, aliases, perspective, grouping, replay morphology, integration paths, cache isolation, filters, selection races, sample navigation, empty states, deep-link initialization and keyboard controls. Browser QA exercises 320, 390, 768, and 1440 pixel widths in light and dark themes. The current local visual preview uses actual exported replay analysis; isolated regression tests cover multi-game baselines and missing-data scenarios with test fixtures.

Custom transition charts are suppressed when dossier filters are active because the existing transitions endpoint only accepts perspective. Showing its unfiltered cohort beside filtered unit statistics would misrepresent the selected games.
