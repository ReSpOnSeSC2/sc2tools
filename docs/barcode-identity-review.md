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
| No broader replay action fingerprint | Command timing, queued/repeated command shares, command target types, decoded ability mix, selection observations, camera cadence and action mix by phase |
| Shared opening labels could produce a perfect build match | Label-only matches are capped at 55% similarity and carry low measurement reliability; timed milestones are compared within the matchup |
| A high-volume replay could dominate aggregate control counts | Each replay contributes a normalized observation; observed within-profile variability reduces evidence quality |
| Rich evidence from one game could represent many legacy games | Every dimension reports its actual sample count; partially available dimensions receive less scoring and reliability weight |
| Deeper candidate histories could outrank much closer sparse fingerprints | Ranking uses fit and measurement quality; sample depth affects confidence and likelihood separately |
| Missing phases could be confused with observed inactivity | A phase is compared only when both replays fully observed it; recorded inactivity differs from an unobserved phase |
| Legacy and new timing semantics differed | Transition/double-tap channels are compared only within compatible signature versions |
| Large pools could overwhelm unknown-player probability and accumulate rounding error | Fixed total candidate prior, explicit unknown hypothesis, and rounding only after probability aggregation |
| Strong sample counts could label a weak fit as a lead | Assessment requires sufficient similarity and support; close competitors and truncated searches lower certainty |
| API accepted only v1 and storage could strip new fields | Shared bounded v1/v2 schema and sanitizer, semantic checks, and re-sync replacement regression coverage |

The evidence display now shows three families: build patterns, control groups,
and replay actions. Expanded comparisons include phase/interval similarity,
first-use times, rates, actual command names after group recalls, per-measurement
game counts, observed event counts, and consistency of group usage/action mix.

## What replay data can establish

SC2 replay events expose logical game commands and group numbers. They do not
record the opponent's physical key presses, key bindings, keyboard layout, or
OS input. Selection and camera events can also be produced by the game, so the
UI calls them observations rather than keystrokes or effective APM. Command
names after recalls provide behavioral evidence; the matcher does not invent
unit membership or assign an army/production role when that is unknown.

Control update and command-repetition semantics were checked against the
installed sc2reader source and its [upstream implementation](https://github.com/ggtracker/sc2reader/blob/upstream/sc2reader/events/game.py).

The scorer gives nominal weights of 55% to control-group habits, 25% to action
habits, and 20% to builds, renormalizing available families. These are heuristic
weights, not learned or calibrated probabilities. Similar play can reflect
shared builds, coaching, or common mechanics. A person can also change habits.

## Real replay validation

All application features come from parsed replay events; no example players or
generated evidence were introduced into the application. Isolated regression
tests additionally use constructed inputs to exercise malformed and edge cases.

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

Validation completed: 136 targeted API tests, 97 agent extraction/pipeline tests,
14 UI tests, API TypeScript, and focused UI TypeScript. Lint has no errors;
existing matcher function-length warnings remain. Full-project web TypeScript
is blocked by the unrelated inaccessible
`apps/web/components/analyzer/settings/SettingsBuilds.tsx` file in this workspace.

## Rollout and remaining limits

1. Deploy the API with v1/v2 validation, storage and matching support.
2. Deploy the updated web interface and distribute an agent build containing
   the v2 extractor. API support must precede v2 agent uploads.
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
by this matcher. Deployment, installer publication and production re-sync have
not been performed as part of this local code review.
