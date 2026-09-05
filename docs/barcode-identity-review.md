# Barcode identity matching review — September 5, 2026

The original matcher was suitable for weak scouting leads, but its evidence was
too coarse for dependable identity ranking. The screenshot's single target
replay cannot establish a stable personal fingerprint. Its 100% build matches
could come from identical classifier labels without matching timed replay
milestones. Estimated likelihood was explicitly uncalibrated.

The implementation now extracts and compares substantially richer real replay
evidence, keeps missing evidence explicit, and separates behavioral fit from
sample confidence. It produces private candidate leads, not verified identity.

## Findings and changes

| Original limitation | Implemented change |
| --- | --- |
| Only overall set/add/recall counts, preferred slots, a short transition list and double-tap rate | Per-slot first use, set/add/steal/clear observations, phase-specific activity, global and per-slot recall intervals |
| Generic control events could omit steal operations | Handles sc2reader 1.8 generic and 1.9 concrete control updates; automatic clears are distinguished from intentional group actions |
| No evidence about how a recalled group is used | Captures the first decoded command within two seconds after a recall, including ability name and queue/repetition information; intervening selection/group changes invalidate attribution |
| Group numbers did not identify the assigned units/buildings | V3 reconstructs all ten selection buffers, records per-slot unit types, same-unit group pairs, and the first 24 distinct opening assignments/recalls with timing |
| Camera movement did not identify bookmark slots | V3 retains raw replay bookmark saves for all eight slots, their setup order/timing, and observed return rhythm globally and per slot |
| A steal generated automatic recalls and selection updates | Complete automatic buffer transactions are recognized, applied once, and excluded from player input rhythm |
| No broader replay action fingerprint | Command timing, queued/repeated command shares, command target types, decoded ability mix, selection observations, camera cadence and action mix by phase |
| Shared opening labels could produce a perfect build match | Label-only matches are capped at 55% similarity and carry low measurement reliability; timed milestones are compared within the matchup |
| A high-volume replay could dominate aggregate control counts | Each replay contributes a normalized observation; observed within-profile variability reduces evidence quality |
| Rich evidence from one game could represent many legacy games | Every dimension reports its actual sample count; partially available dimensions receive less scoring and reliability weight |
| Deeper candidate histories could outrank much closer sparse fingerprints | Ranking uses fit and measurement quality; sample depth affects confidence and likelihood separately |
| Missing phases could be confused with observed inactivity | A phase is compared only when both replays fully observed it; recorded inactivity differs from an unobserved phase |
| Legacy and new timing semantics differed | Transition/double-tap channels are compared only within compatible signature versions |
| Large pools could overwhelm unknown-player probability and accumulate rounding error | Fixed total candidate prior, explicit unknown hypothesis, and rounding only after probability aggregation |
| Strong sample counts could label a weak fit as a lead | Assessment requires sufficient similarity and support; close competitors and truncated searches lower certainty |
| API accepted only v1 and storage could strip new fields | Shared bounded v1/v2/v3 schema and sanitizer, semantic checks, and re-sync replacement regression coverage |

The evidence display now shows three families: build patterns, control groups,
and replay actions. Expanded comparisons include phase/interval similarity,
first-use times, rates, actual command names after group recalls, per-measurement
game counts, observed event counts, and consistency of group usage/action mix.

## What replay data can establish

SC2 replay events expose logical game commands and group numbers. They do not
record the opponent's physical key presses, key bindings, keyboard layout, or
OS input. Selection and camera events can also be produced by the game, so the
UI calls them observations rather than keystrokes or effective APM. Command
names after recalls provide behavioral evidence. V3 reconstructs the units in
groups from selection deltas and time-specific unit types. Invalid masks or
unknown unit types stay unknown. Replay-local unit IDs verify simultaneous
membership in two groups but are never uploaded. Matching membership dimensions
requires at least 80% of assignments decoded; observed absence of shared units
requires complete, error-free decoding. Raw known facts can still be displayed
when coverage is too low for scoring.

A committed real replay, `warpgate_adept_tracking.SC2Replay`, demonstrates the
requested habit: the same starting Nexus is assigned to group 3 at **2.543s**
and group 0 at **3.078s**. This differs from two separate Nexuses assigned to
those numbers. The opening sequence also retains recalls, while aggregate
interval histograms measure recurring rhythm rather than recording every event.

The replay protocol records saves to eight logical camera bookmark slots (0–7),
but a subsequent camera update does not identify the key that caused it.
Returns are inferred only when the camera moves to a uniquely saved exact
position. Duplicate saved positions are ambiguous and excluded. Saving a
bookmark or repeating an unchanged position does not count as a return; zoom
updates without a target provide no position evidence. No map coordinates or
physical key bindings enter the uploaded camera signature. See Blizzard's
[camera event definitions](https://github.com/Blizzard/s2protocol/blob/master/s2protocol/versions/protocol97364.py).

Control update and command-repetition semantics were checked against the
installed sc2reader source and its [upstream implementation](https://github.com/ggtracker/sc2reader/blob/upstream/sc2reader/events/game.py).
The automatic steal transactions are also documented in
[sc2reader issue 183](https://github.com/ggtracker/sc2reader/issues/183).
During mixed-version re-sync, v2 games containing steals are excluded from
control/action comparisons involving v3 because their stored summaries cannot
separate automatic buffer transactions. Build evidence remains usable. V2-only
comparisons and v2 games without steals retain their previous support.

The scorer gives nominal weights of 55% to control-group habits, 25% to action
habits, and 20% to builds, renormalizing available families. These are heuristic
weights, not learned or calibrated probabilities. Similar play can reflect
shared builds, coaching, or common mechanics. A person can also change habits.

## Real replay validation

All application features come from parsed replay events; no example players or
generated evidence were introduced into the application. Isolated regression
tests additionally use constructed inputs to exercise malformed and edge cases.

The v2 development baseline was:

- Parsed all 734 local corpus replay files without a parse failure.
- Validated 1,480 extracted player-perspective signatures against the API schema,
  semantic checks, and unchanged storage round trips. Largest signature: 8,575
  JSON bytes. Real steal behavior occurred in 253 player perspectives.
- For retrieval, excluded six nonhuman/non-1v1 games, one resumed replay, and
  52 games shorter than two minutes, leaving 675 opponent observations.
- Excluded the dominant local account. Held out the newest replay per repeated
  account and race and removed those replay hashes from every reference profile.
- Evaluated 128 held-out queries against 271 reference account/race profiles,
  with race and matchup restrictions and the production ranking.
- Correct account ranked first: **118/128 (92.2%)**. Correct account in the top
  five: **126/128 (98.4%)**.

These are **same-account development retrieval results**. The corpus informed
the implementation, is not an untouched external benchmark, and contains no
verified alternate-account identity labels. These results must not be advertised
as a 92% barcode-reveal accuracy or converted into calibrated identity odds.
Every query had another account above the weak 35% display threshold, reinforcing
the need for relative ranking, sparse-data warnings and an unknown hypothesis.

Reproduce the extraction and audit using [the offline audit instructions](../tools/identity/README.md).
Local detailed results are in `output/identity-evaluation-full-20260905.json`;
the real corpus and player evidence remain local, outside tracked source.

The v3 follow-up audit used the same 734 real replay files:

- All **1,480** full production signatures passed lossless API validation/storage
  round trips, with zero extraction errors. Largest compact signature: **16,368
  bytes**. Source hashes confirmed the extractors stayed unchanged during the run.
- Decoded **53,008 / 53,128 assignments (99.77%)**, with membership available in
  1,380 perspectives. The 115 unresolved selection observations in 53 perspectives
  were quarantined; unknown buffers did not become invented units or absences.
- Excluded 53,347 automatic steal housekeeping events from player inputs.
  Camera evidence was available for all 1,476 human perspectives; four AI
  perspectives had no attributable user ID and supplied no camera evidence.
- The same-Nexus-on-0-and-3 opening was observed in 649 ReSpOnSe perspectives.
- The 675 eligible rows, query/reference split, and build signatures were unchanged
  from the v2 baseline. Production ranking placed the correct account first in
  **121 / 128 (94.5%)** queries and in the top five in **126 / 128 (98.4%)**.
  These remain development same-account retrieval results, not alternate-account
  identity accuracy or calibrated probabilities.

Local v3 reports: `output/barcode-v3-final-audit-report.json`,
`output/barcode-v3-roundtrip-report.json`, and `output/barcode-v3-evaluation.json`.
The real replays and player-level evidence remain outside tracked source.

V3 validation completed: **190 targeted API tests, 148 agent extraction/pipeline/
updater tests, and 19 UI tests**, plus API and focused UI TypeScript. Lint has no
errors; existing matcher function-length warnings remain. Full-project web
TypeScript is blocked by the unrelated inaccessible
`apps/web/components/analyzer/settings/SettingsBuilds.tsx` file in this workspace.

## Rollout and remaining limits

1. Deploy the API with v1/v2/v3 validation, storage and matching support.
2. Deploy the updated web interface and distribute an agent build containing
   the v3 extractor (agent 0.16.5). API support must precede v3 agent uploads.
3. Run one full agent **Re-sync** to replace old signatures for both the target
   barcode and known candidate opponents. Existing game rows are updated in
   place; server identity metadata is preserved. Release alone does not enrich
   already stored rows.
4. Check the expanded evidence counts. Several independent detailed replays on
   both sides are needed for stronger confidence. Older or missing local replay
   files cannot be reconstructed from stored summary rows.

The implementation retains the caller's own replay-history scope. It never
searches another user's private evidence or automatically links player identities.
Search remains bounded to 20 target games, 500 recent opponent documents, 12,000
candidate game rows, and 24 games per candidate; build timing prototypes use up
to eight games per side. Phase evidence covers the first ten real game minutes.
Truncated searches are explicitly flagged. An absent candidate cannot be named
by this matcher. Updating the server or agent does not enrich historical rows
until the source replays are reprocessed and uploaded through a full Re-sync.
