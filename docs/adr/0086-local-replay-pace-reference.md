# ADR 0086 · Local replay pace reference

Status: accepted

`/try` computes the selected replay’s pace in the browser. It bundles a small
reviewed reference JSON file. The comparison stays in the browser under the
ADR 0022 privacy boundary. Report exports keep their existing fields.

The 5,300-MMR reference describes the replay collection of one Protoss player
whose replay-recorded rating rounds to 5,300 in each source game. Eligible
directions are PvP, PvT, PvZ, TvP and ZvP. TvP and ZvP describe the opponent’s
perspective in that collection. Those cards identify whose rating and pace
they show.
Eight-worker and twelve-worker starts are separate. The report checks the
recorded patch era and starting worker count before comparing.

For each curve, interpolate worker count and collection rates onto a 10-second
grid for the first 4:30. Rates are resources per minute. Integrate the sum of
mineral and gas rates with trapezoids. Reject gaps longer than 30 seconds or
insufficient coverage. Samples beyond the recorded game duration are excluded.
The reference contains pointwise medians over at least
30 games against at least five distinct opponents in each cohort, following the
scale of the ADR 0023 guide sample defaults. The displayed
gap compares first crossing times of the reference’s 4:00 values. A value not
reached by 4:30 has no estimated time. The report flags named all-ins and
canonical builds explicitly documented as all-ins by the replay detector.

## Build an approved reference

From `apps/web`, run:

```text
node scripts/build-pace-reference.mjs --source local-games.json --out reviewed-reference.json
```

Prepare the input locally as an array of ranked 1v1 replay perspectives. Each
row has `gameKey` (stable per replay), `opponentKey` (stable per opponent of the
reference player), `anchorMmr` (the Protoss reference player’s pre-game rating),
`durationSec`, directional `matchup`, `era` (`before` for the eight-worker patch,
`after` for twelve-worker starts), and `samples`. Use the perspective’s economy
samples with `time` in game seconds, `food_workers`, `minerals_collection_rate`
and `vespene_collection_rate`. Use one perspective per replay for PvP. Use the
same game key for both directions of an asymmetric matchup. Keep the source
file and identifiers private. The tool writes only cohort counts and curves.

After reviewing the aggregate and its permission to publish, replace
`lib/instant/pace-reference.json` with the generated output. The shipped registry
contains zero approved cohorts while this source is pending. Synthetic cases
exercise the comparison without serving synthetic values as a real reference.
