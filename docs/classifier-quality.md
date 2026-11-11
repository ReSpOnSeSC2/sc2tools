# Classifier quality

The admin **Classifier** console (`/admin/classifier`) answers one question: when
players confirm the build they went for, where does the replay detector name
something else? It aggregates confirmed build check-ins; it never edits a rule.

## What is counted

A confirmed, applied check-in stores the build the player declared next to the
label the classifier detected for that game, on two axes:

- **Player's build**: the player's own build check-in.
- **Opponent's build**: a corrected opponent strategy.

The nightly job (`classifier-quality`, `apps/api/src/jobs/classifierQualityJob.js`)
reads check-ins confirmed in the last **90 days**, newest first, up to 100,000
per axis (a busier window is flagged), and writes one snapshot to the
`classifier_quality` collection. The last seven snapshots are kept. Deleted,
pending-deletion and unapplied check-ins are ignored.

- A **disagreement** is a check-in whose declared build differs from the
  detected label (same name and same custom slug count as agreement).
- Custom builds are counted as **Custom build**; their names and rules are the
  owner's private data and never appear.
- 8-worker (5.0.16) era names fold into their released label.
- **Engine** uses the uploader and its reported engine version for both browser
  and desktop replays. Older uploads can lack either field.

## Guardrails

- **k-floor:** a pair, label, engine cohort or trust line needs at least three
  distinct players. Engine filters and sample drill-downs use the same floor.
  Smaller pairs contribute only to the aggregate withheld count.
- **Identity:** snapshots hold counts only, no user or game ids. Samples show
  the day, map, length, engine and provenance. Build logs include only recognized
  game entities, and test fixtures omit player names and game IDs.
- **Bounded:** the scan uses two partial indexes on confirmed check-ins
  (`classifier_quality_build`, `classifier_quality_opponent`), built in the
  background; until both are ready the job skips and the drill-down returns 503.
  Samples are capped at 20 per pair and six minutes of build log.
- **Framing:** counts are disagreement volume from players who checked in. They
  are not an accuracy score: players check in selectively, and a rule nobody
  checks in with has no data.
- **No auto-tuning:** rules stay human-edited in Build Studio. Nothing reads the
  snapshot to change a rule.

## The console

- **Pairs:** detected → declared, sorted by disagreement volume, with players,
  provenance (pre-game plan, post-game check-in, website) and the per-engine
  split. Filter by axis, matchup and engine; the filters live in the URL.
- **Confusion:** each detected label with the builds players declared instead.
- **Labels:** per label, matches, misses (declared but not detected) and
  mislabels (detected but declared as something else).
- **By engine version:** current check-ins and disagreements per engine, with up
  to seven published snapshot counts to show change over time.
- **Samples:** up to 20 recent games for one pair, each with its build log up to
  6:00, next to the declared and detected rules. Open **Rule requirements** to
  see released criteria or an enabled Build Studio replacement.
- **Copy as test fixture** copies one sample's identity-free JSON (axis, matchup,
  races, labels, engine, game version, length and build-log lines) for a
  replay-engine test under `apps/replay-engine/tests`.
- **Recompute now** runs the same job immediately (it is audited as `job.run`).

## Fixing a rule

1. Sort by volume, open the pair's samples and compare the build logs with the
   declared rule's requirements.
2. Decide whether the rule or the players' expectation is wrong. Many check-ins
   that declare a build the replay never reached are plans that went sideways,
   not detector errors.
3. Add the copied fixture to a replay-engine test, change the rule (engine code
   or a Build Studio policy edit) and run the engine tests.
4. After the change ships, compare disagreement counts across recent snapshots
   while keeping the number of check-ins in view.

## Public trust line

`/definitions` shows **Matches N of M player corrections** on a released rule
with enough data: of M check-ins that declared this rule (both axes), the
detector also named it in N. It comes from `GET /v1/classifier-quality/labels`
(public, cached for an hour, k-floored, released labels only). It is framed as
disagreement volume, never accuracy, and a rule with too few players shows no
line.
