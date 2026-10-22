# 0025: Build check-ins override the effective build label

Date: 2026-10-22

Status: Accepted.

## Context

A game counts toward a build's win/loss record only when the classifier labels
it with that build. Custom builds need every rule to pass; catalog builds take
the first matching branch of the replay engine's decision trees. A player who
went for a build and was knocked off it (a scouted proxy, lost workers, an early
all-in) ends up under another label, often an "Unclassified" catch-all, so the
build's record only ever contains the games where the plan survived. Players
asked to say what they were going for, at the loading screen or after the game,
and have that count.

`myBuild` (plus `_customBuildSlug` for custom builds) is read by roughly forty
per-user and cross-user aggregations. Four writers set it: the upload upsert,
the post-ingest custom-build tagger, the background reclassify commit, and the
quarantine path for resumed replays.

## Decision

A confirmed check-in is stored on the game row as `buildIntent` and **becomes
the effective label**: `myBuild` and `_customBuildSlug` carry the declared build
while `buildIntent.applied` is true, and `buildIntent.detected` keeps what the
classifier said. Readers of the user's own statistics need no change and count
the declaration everywhere.

Writers never see the override. The ingest tagger and reclassify staging work
on a detector view (`detected`) for overridden rows and route their decisions
into `buildIntent.detected` with single-document aggregation-pipeline updates.
Check-in writes are pipelines too, so a concurrent classification or a second
confirmation cannot capture the declared label as the detected one. They never
rotate the tagger's revision fence.

Cross-user surfaces (guide statistics and samples, ladder meta, admin global
reports, coaching assignment progress, community card totals, public replay
items, model training labels) read the detector view. Build-shape views
(phases, compositions, transitions, median timings) only use games whose
effective label agrees with the detector, so a build's shape is not diluted by
games that never followed it. W-L views report how many games count only
because of a check-in.

The opponent's build is a second, optional axis with the same model: a
confirmed correction becomes the effective `opponent.strategy` (plus
`_customOpponentStrategySlug` for an opponent-perspective custom build) while
`buildIntent.opponent.detected` keeps the classifier's label. The same writers
are guarded on both axes in one composed update, the user's own opponent
statistics (opponent history, build vs strategy, best answer) use the
correction, and cross-user surfaces keep the detected opponent label. It has no
pending queue: the replay's label stands until the player corrects it.

A build that is not in the library yet is created from the check-in with the
existing custom-build editor ("Save as new build" from the replay), opened with
the game's matchup locked and refusing to overwrite an existing build's slug;
saving it checks the game in with the new build. The desktop card opens that
editor on the website through a deep link.

Only confirmed check-ins count. Randomizer rolls and suggestions are pending
until the player confirms. Games shorter than 45 seconds never take an
override. Pre-game declarations live in an ephemeral `build_intent_live`
collection keyed by the agent's live `gameKey` and are bound to the uploaded
game at ingest by time window and normalised opponent name, first binding wins.
The match's own record is the newest one that saw its loading screen; records
from an earlier loading screen against the same opponent (an abandoned match)
only bind when nothing newer does, and the agent carries a pick over when it
re-keys a match it briefly lost track of.

## Consequences

Per-user W-L reflects intent rather than execution, as requested, with the
detector label one click away on every game and build. Global statistics keep
their meaning. Renaming a custom build renames its overridden rows; deleting it
freezes them under the old name so an undelete restores the card.

The schema change is additive (games v8). Rolling back the code leaves declared
labels in `myBuild`; the v8 backward migration and the attribution helpers
restore the detector label exactly when run.

## Validation

API tests cover every writer against overridden rows (re-upload, tagger with and
without custom builds, reclassify with clear-unmatched, rename, delete), reader
behaviour for agreeing and disagreeing rows, binding edge cases, suggestions and
the HTTP and socket contracts. Agent tests cover the controller policies and
the poller re-emit; web tests cover the overlay hold and the check-in UI.
