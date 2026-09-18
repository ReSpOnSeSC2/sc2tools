# Trends visualization review

This pass covers the Trends overview, every active Trends chart, all seven Explore performance analyses, and the skill fingerprint. It continues the recent-form redesign of win-rate and map charts. It does not redesign replay playback or individual-game telemetry.

The central question is what a reader should be able to conclude from each view. A line implies change over time; separate groups need a common comparison scale; activity needs a volume measure. Actual records and sample sizes should be available without hovering.

| View | Problem or assessment | Result |
| --- | --- | --- |
| Games played | Technical title, dense bars, absent days compressed, unknown results omitted from stacks. | Retained stacked counts, restored empty calendar periods, included other outcomes, and combined adjacent periods into at most 32 readable bars with explicit grouping. Counts are conserved. |
| Overview summaries | A three-game period could win a best/worst ranking. Aggregate daily records cannot establish an exact current streak. | Replaced those claims with recorded results and active-period counts. No-data win rate displays a dash. |
| Overall win rate | Daily percentages emphasized tiny samples. | Retained the earlier 30/60/100-game target approach with actual sample counts, whole-period windows, and an overall baseline. |
| MMR progression | A line is appropriate, but decorative shading obscured the observed range, tiny rating changes could fill the entire axis, and missing dates were compressed. | Kept the rating line and account/race separation. Removed decorative fill, retained only the observed min/max range, expanded very narrow scales, made sparse points visible, and used calendar spacing. Global average semantics are preserved. |
| Daily MMR records | Direct best/worst daily changes already provide concrete values with counts. | Retained. Unlike best daily win rate, these report actual measured rating changes. |
| Net MMR by matchup | Total gain mixes effectiveness with how often a matchup is played. | Kept diverging bars centered at zero. Added per-measured-game comparison, symmetric scales, visible sample counts, and measurement details. Existing opponent drilldowns remain. |
| Opponent MMR | Two vertical scales and a line between rating categories imply a continuous performance curve; tiny samples look strong. | Replaced with labeled comparison rows on a shared 0–100% scale, records and sample cues, an overall reference, and the existing game drilldowns. |
| Session patterns | Smooth session-position curves imply a progression within the same sessions. “Tilt” and “cool-headed” verdicts claimed psychology from observed results. | Replaced with separate comparisons after wins/losses and by session position. Later positions are expandable. Counts and the changing population of longer sessions are explicit. |
| Win rate by matchup over time | Repeated the daily-rate problem; recent-versus-overall deltas were easily misread. | Uses 20-game targets independently within each played race pair, an honest shared calendar axis, actual counts, and building-sample states. Long daily requests now coarsen before truncating newer results. |
| Time played by matchup | Average length is sensitive to unusually long games. | Leads with median duration, compares median and average on one labeled minute scale, retains total time and result splits, and marks small samples. |
| Activity by time of day | Color combined volume and outcomes, and a 1–0 block could look like a good time to play. | Defaults to volume. A separate win-rate mode withholds rate coloring below 20 games. Four-hour blocks retain counts; tap and keyboard selection expose the actual record. |
| Win rate by game length | Dual axes and a connected line across unequal duration bins overstated continuity and rare long games. | Uses independent comparison rows, visible records, a common rate scale, and an overall reference. It describes when games ended, without suggesting that extending a game causes wins. |
| Activity calendar | Win-rate hue obscured consistency. Historic filters could show the current calendar, and headline counts did not necessarily match visible days. | Uses volume-only color, larger selectable days, a persistent record readout, and counts for the displayed window. Historical date bounds and date-only timezone handling are corrected. |
| Explorer: rating difference, leads, breaks, rematches | Connected categories and count/rate overlays required interpretation of unrelated axes. | Uses common comparison rows, full labels, exact records, decided-result sample cues, and accessible game links. |
| Explorer: period and group comparison | Direct cards are useful; visual comparisons still need sample and denominator context. | Retained summary cards and breakdowns, with consistent comparison rows. Equal-player rates remain server-supplied rather than being recomputed from raw totals. |
| Explorer: build execution | Median with a middle-50% band is a useful timing distribution. Calendar gaps and player weighting needed clarification. | Retained that representation, added true calendar spacing, a latest-period sample readout, and explicit weighted timing labels. Missing measurements remain missing. |
| Skill fingerprint | Its labeled trait tracks, underlying records, pace distribution, and insufficient-data states already explain the evidence. | Retained. No new decorative chart or inferred performance score was introduced. |

## Interpretation and remaining limits

- Sample thresholds are reading aids, not guarantees about a player's true win probability. Actual rates remain visible with their records in category comparisons.
- The recent-form endpoints return calendar aggregates. Windows retain whole periods and may exceed the game target; no individual game order is invented.
- Matchups, opponents, player populations, and sessions can differ between groups. These views describe recorded data, not causal effects or prescriptions.
- Existing endpoint denominators are preserved. Explorer rates use decided results; several legacy endpoints use all records. Other outcomes are shown rather than silently counted as losses.
- Long date ranges may use weekly or monthly records. The effective interval is labeled and long matchup/map requests retain recent history.

## Verification

Regression coverage checks weighted rates, record conservation, unknown outcomes, empty/small samples, historical dates, DST, true time spacing, MMR domain behavior, global scope, and existing drilldowns. Browser QA renders the actual components with synthetic data at 360, 390, 768, and 1280 pixels in both themes. Sample-data preview artifacts are under `outputs/win-rate-qa/`.

Final validation: 164 web tests and 95 API tests passed; both application typechecks passed. Browser checks found no page overflow or runtime errors at the four widths. Mobile interaction checks passed for MMR measure switching, time-grid mode and keyboard selection, calendar day selection, and expanding later session results.
