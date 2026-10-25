# SC2 moment alerts checkpoint

2026-10-25. Branch `codex/wave4-sc2-moment-alerts`, PR735. Final product
source is `960026d2`; owner main `8d68cdd5` and the actual Game Desk squash
`34b14d7f` are integrated. ADR0051 records the foundation.

The nine closed moment kinds are opt-in under existing multichat alert
preferences. All start off, silent and without bot posting. The same existing
Save chat settings flow persists a complete bounded snapshot. Local Test
changes no preference, emits no OBS event and sends no chat message. A keyed
owner form aborts held saves and retires private drafts on account changes.

Fresh newly inserted competitive replays use one slim history scan capped at
10,001 rows/1.5 seconds. Default-off users skip that scan and the owner lease.
A conditional receipt on the existing owner/game row, source revision,
owner mutation lease and exact token admission guard claims and delivery.
Historical imports, resumed, hidden, deleting/deleted and repeat ingestions
do not create moments. No collection, index, migration, polling job or new
provider connection was added. Delivery after a claimed receipt is best effort:
an interrupted delivery may miss a toast instead of posting it twice.

Comparative facts stay in the exact account/race cohort. Replay MMR is the
game-start rating, with explicit provenance. Season peaks require a cache-only
regional boundary and complete recorded time coverage. Only actual Pulse league
snapshots establish a league change; the first snapshot is a baseline. Known
opponent toon mismatches reject equal stale numeric profile IDs for revenge.

The existing dedicated Event alerts source receives `overlay:moment` over its
existing socket. Bounded batches preserve same-turn multi-achievement arrivals.
Ladder cards wait behind supporter alerts and expire after two minutes. Sounds
follow the actual visible queue and do not repeat on supporter preemption.
Game pause consumes Ladder events while supporter recognition continues.
Resync/disconnect clears queued cards. The existing keyed client, explicit
source object identity and retired-socket admission epoch fence late callbacks,
including A → B → A. Ladder events never enter provider engagement intake.

Each accepted moment reuses the existing Clips writer. Optional bot posting
reuses its bounded queue and existing exact-token/current-connection guards;
it does not create or enable a platform connection.

Validation:

- 52 Moment API rule/runtime/owner-route checks pass using disposable Mongo.
  They cover concurrent and restarted ingestion, owner visibility/erasure,
  held rotation admission, source correction, strict preferences and real
  post-ingest fanout. API types and strict changed-helper lint pass.
- 208 affected web/Help checks pass. A later source-only guard adds one
  A → B → A test; the final source/reconnect selection passes 10 tests, and
  the focused actual alert/settings selection passes 9. These counts overlap.
  Full web types and strict changed-source lint pass.
- Required `npm run engine:build` assembles and smokes
  `f96c086eb83fdc40` (engine 1.6.12, Python 3.14.2, 223 files/79 pyc).
  Final Next production build passes. Budget limits are unchanged: dedicated
  widget 319.2/325 kB, overlay 235.9/240, Dock 214.6/225, Today 238.9/240,
  landing 214.7/215, opponent 476.1/500.
- The real loopback Socket.IO/browser matrix passes 591 checks with 29 captures,
  at 300/320/390/768/1440 px in both themes. It renders the real settings form,
  source/queue/card/audio hook and Clips consumers using explicit synthetic
  auth/API/provider/audio boundaries, final production CSS and actual fonts.
  It checks all nine kinds, explicit Save/local-only Test, raid priority,
  sound dedupe, pause, token/owner changes, no overflow, 44 px targets, contained
  long labels and axe on the new settings block. Provider traffic is blocked.
- Help regenerated 85 articles; the new article, Learn guide, changelog and
  owner setup explain provenance, defaults, refresh and rollback.

Representative captures are under `screenshots/game-moment-alerts-*.png`:
`settings-light-300`, `preview-dark-300`, `settings-dark-1440`,
`ladder-light-1440`, `supporter-priority-dark-300` and `clips-light-300`.

PR735 remains open pending final-head GitHub checks and the Vercel deployment
quota. Do not merge before all gates pass and current main is checked. No
deployment retry, provider post, production operation, account activation,
native release or version bump was performed.

Initial CI on `e628cf18` passed the responsive job. The API run passed 5,679
tests with one stale route expectation omitting the new explicit
`rank.source: estimate`; the fixture was corrected without changing runtime
behavior. The web run passed 7,502 tests with two failures in the existing
Overlay dirty-form fixture, whose signed-in auth mock omitted its owner ID.
The mock now supplies that ID so the real owner-scoped form mounts. Final-head
checks must confirm both fixture corrections and the evidence.
