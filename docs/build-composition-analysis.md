# Build composition analysis

The build dossier shows a phase-based **Units fielded** summary on desktop and mobile. Classified builds use `/v1/builds/:name/phases`; custom builds use `/v1/custom-builds/:slug/compositions`. Query filters and perspective are preserved. The UI also handles older responses that contain only signature medians without inventing overall averages.

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
    sampleGameIds: string[]
  }>
}
```

For each game and unit, use the highest recorded alive count **inside that game's classified phase**. Phase boundaries are half-open `[start, end)`; the game's final phase includes its end. Do not borrow a sample from a later phase.

An explicit empty side map is an observed zero army. An absent side, absent timeline, or phase without usable samples is missing data. For every unit, observed games without that unit contribute zero; missing games do not contribute. All summary counts share the same `observedGames` denominator. For example, peaks of 8, 0, and 4 plus one missing game produce a mean of 4, median of 4, and presence of 2/3—not a mean of 6 or 3.

Percentiles use linear interpolation. The middle 50% is the interquartile range, not a confidence interval. The API preserves fractional statistics; the interface displays up to one decimal place and always one decimal for the mean. Presence is `gamesPresent / observedGames`.

The eligible roster includes permanent army and support units, excluding workers, supply units, structures, eggs/cocoons, and temporary summons. Aliases are combined within each sample before the peak is selected. Input scans and output unit lists are bounded. Each unit carries at most 25 sample replay IDs, drawn from games where it appeared. The UI explicitly labels partial samples and resolves older replay metadata independently of the dossier's recent-game list.

## Interpretation and source limits

- Different unit types can peak at different times. Do not sum their peaks into an army total or turn them into a simultaneous composition pie chart.
- These are sampled alive counts, not cumulative units produced. Short-lived units can fall between samples.
- Existing build logs omit some unit morph completions and lack the identifiers needed for reliable deduplication. A production metric needs a separate complete tracker-derived production stream; it must not be inferred from alive deltas or build-log row counts.
- Common unit groups use the same phase observations, grouped by the unordered set of up to three dominant unit types. Their legacy counts are conditional medians among games containing that unit, clearly distinguished from the whole-cohort summary.
- First-seen tech times use the earliest valid timestamp. Upgrade milestones use completion time when available. Their timing ranges include only games where the milestone was recorded by the phase midpoint.
- Phase win/loss associations do not establish the effect of a composition on the outcome.

The replay extractor now retains timestamped unit forms rather than applying each unit's final morph retroactively. It excludes cocoon intervals and explicit hallucinations and resolves completion events against historical type information. **Previously stored timelines require reprocessing to gain this correction.** No historical data migration or production reprocessing is performed by this change. Unflagged hallucinations and the existing sample resolution remain limitations.

## Presentation and validation

Mobile keeps the unit, mean, and presence visible. Each row expands to show median, quartiles, full range, and sample games. Desktop adds the interquartile range as a visible column. Unit groups, methodology, and tech milestones use disclosure controls. Phase tabs support arrow keys, Home, and End; controls use visible focus states and touch-sized targets.

Validation covers statistical denominators, absent versus missing units, strict boundaries, aliases, perspective, grouping, replay morphology, integration paths, filters, sample navigation, empty states, and keyboard controls. Browser QA fixtures exercise 320, 390, 768, and 1440 pixel widths in light and dark themes. The local preview uses explicitly labeled illustrative data; it is not a live account snapshot.

Custom transition charts are suppressed when dossier filters are active because the existing transitions endpoint only accepts perspective. Showing its unfiltered cohort beside filtered unit statistics would misrepresent the selected games.
