# Observed map replay export

The tracker parser is a fast fallback. Its position events are sparse and do
not contain terrain creep masks. Command target coordinates are orders, not
unit positions. The web replay marks this fallback and uses recorded anchors
without inventing mining trips or movement routes.

For detailed playback, the desktop agent can run the replay through the
installed StarCraft II engine. This optional export captures actual unit
positions, unit type changes, presence intervals, spell effect extents and
global creep. On Windows, agent 0.16.8 starts its recorder off-screen without
activation and keeps its capture windows out of view. It does not control an
existing game process. Users do not manually open the replay. The first
generation runs the saved game through StarCraft; later Recomputes reuse a
compatible complete local recording. Ordinary syncing and viewing an uploaded
recording do not launch StarCraft.

## Desktop app

Open a game's map replay and select **Generate accurate playback**, or use
**Recompute** in its Macro Breakdown. Both controls share the same recording
and upload progress; reopening the panel resumes an active recording. Keep the
updated desktop agent connected on the computer containing the original replay
and StarCraft II installation. The packaged agent includes the protocol
dependencies; users do not need Python or a separate pip installation.

The agent records the replay in the background, then uses its normal sync
pipeline to upload the result. The page polls progress and reports recording,
upload, missing-file, offline-agent and runtime failures. One recording runs per
agent at a time. Existing tracker playback remains available during recording.
The action uses the signed-in user's paired device and verifies game ownership.
Agent 0.16.7 also isolates the external StarCraft process from the packaged
agent's Windows DLL search paths. A capture failure preserves a bounded engine
log in the observation cache's `diagnostics` directory and reports its location.
The Windows recorder starts suspended, joins an owned kill-on-close Job Object,
then resumes with window suppression active. Only diagnostic handles are
inherited. The job stops its capture subtree when the agent exits, including
crashes. This is background automation, not a headless Windows game engine.
Window handling is asynchronous: unusual driver or system dialogs cannot be
guaranteed invisible on every computer. A private non-input desktop was tested
and rejected because this SC2 renderer could not initialize Direct3D there.

Before capture, the agent checks the existing lossless local artifact against
the replay SHA-256, participant, artifact version, complete observation channels
and default-or-better sample interval. Matching recordings are reused for
reanalysis and upload without starting StarCraft. Partial, compacted, incompatible
or lower-resolution artifacts trigger a new capture. This also allows upload
compression fixes to repair existing recordings without simulating them again.

## Developer setup and standalone use

For a source checkout, install the optional exporter dependencies into the same
Python environment as the replay engine, then run:

```powershell
python -m pip install -r apps/replay-engine/requirements-observations.txt
python apps/replay-engine/core/sc2_observation_export.py "C:/Replays/game.SC2Replay" --player-id 2
```

`--player-id` is the participant whose units should be labeled “You”. The
export verifies the replay's player IDs and exact engine version. Set
`SC2PATH` or pass `--sc2-path` if StarCraft II is installed outside the default
Windows directory. Blizzard can download missing historical replay binaries
and game data through its local API. `--no-download` requires those assets
to be installed already.

The default output is the replay filename with `.observations.json` appended.
Use `--output` to choose another location. The parser discovers adjacent
artifacts automatically. Alternatively, set `SC2TOOLS_OBSERVATION_DIR` and
store the artifact as `<replay SHA-256>.json` in that directory.

An artifact replaces tracker movement only when its replay hash and player
identity match and all simulation passes finished. Partial exports produced
with `--max-game-seconds` are useful for diagnostics and cannot silently
replace a complete replay. Parse failures, missing dependencies and missing
artifacts leave the normal tracker playback available.

## Deployment

Ship the API, web replay viewer and updated desktop agent together. The agent's
requirements pin the SC2 protocol, protobuf and WebSocket dependencies, and its
PyInstaller spec collects their modules alongside the bundled replay engine.
Older agents receive an explicit update-required response. Stored tracker
payloads remain usable and gain observed playback when regenerated.

Rebuild progress is a bounded, temporary API-process cache. HTTP requests and
the paired device socket must reach the same API instance; a scaled deployment
needs shared job storage and a Socket.IO adapter. Restarting the API clears
progress, while recorded artifacts and uploaded game details remain durable.
The viewer polls `/map-playback/status`, which checks the owned game's slim
record without hydrating replay data. Full playback is fetched on completion,
with bounded retries and recovery reads if an API restart loses job state.
The exporter allows 15 minutes and upload confirmation another two minutes;
the viewer stops polling after 18 minutes and leaves a retry/check-back message.

## What is observed

- Unit positions and active spell effects are sampled every four simulation
  loops, approximately 0.179 seconds on Faster. `--step-loops 1` increases
  temporal resolution. Interpolation between samples is still a display
  approximation; neither route planning nor physics are reimplemented.
- Each participant is replayed separately. Only that participant's own units
  and effects are retained from its pass. This avoids enemy snapshots and
  combines both players' authoritative state. Blizzard's “Everyone” observer
  perspective returns live units but silently omits raw spell effects.
- Participant passes request only raw state, without unused score or feature
  images. The four-loop sample interval is unchanged. A matched Washout probe
  produced identical raw units, weapon data and effects while reducing each
  local observation from about 377 KB to 81 KB; feature rendering remains
  enabled for the separate global-creep pass.
- Global creep comes from a third, lightweight “Everyone” pass using the
  engine's native-resolution feature minimap with fog disabled. Participant
  creep remains filtered by that player's visibility even with those options,
  so it cannot substitute for this pass. Rows are flipped once into SC2 world
  coordinates and encoded as contiguous set-cell runs. Creep is sampled about
  once per second, including clear frames, so shrinking and disconnected
  coverage are preserved.
- Cargo absence hides a unit without declaring it dead. Only observed death
  events or a recorded lifecycle transition end a life. Matching tracker death
  attribution distinguishes combat deaths from spent workers and merges.
- Weapon attack animations use positive cooldown resets observed on consecutive
  samples of a participant's own units and armed structures. An attack order,
  an engaged target, or a nearby enemy does not trigger a shot. Slightly negative
  ready-state cooldowns returning to zero are excluded. The shot's aim point is
  retained only when its actual engaged target has a current visible engine
  position. Missing target data still permits a firing animation, but does not
  invent a target or projectile path. Shot timestamps identify the first sample
  showing a cooldown reset, with approximately 0.179-second resolution at the
  default step; they are not per-loop weapon events. Very short cycles between
  observations can be missed. `fidelity.attacks` distinguishes this channel
  from older exports that do not contain weapon telemetry.
- Stable engine tags remain decimal strings in JSON to avoid JavaScript
  integer precision loss. Their low 32 bits match replay tracker unit IDs,
  allowing spell caster references and precise tracker deaths to be reconciled.

The raw engine API exposes only its supported persistent effects. Abilities
without such an effect, including many self buffs and targeted abilities,
continue to use recorded cast cues with their provenance retained. A command
alone does not prove that an ability succeeded.

## Validation

The exporter was exercised over a complete 10000 Feet LE calibration replay
using its matching Base95841 runtime and data version. Native creep mask
alignment was checked against the recorded starting Hatchery. A participant
observation at an actual Corrosive Bile cast returned the effect's target,
owner and radius, while “Everyone” returned no effects at the same loop.
The completed capture contains 3,165 observed weapon cycles, including melee
units, ranged units, Void Ray beams and defensive structures. Of those cycles,
2,913 have a current observed target position suitable for aiming the animation.
Renderer tests verify attack clip selection, close-target facing, deterministic
rewinds, movement after an attack and the loading fallback. Refresh tests keep
older recordings without attack telemetry eligible for regeneration.

The Windows background launcher was exercised against the Washout replay's
matching Base97563 runtime. All three capture windows stayed hidden across
advancing observations in both participant and Everyone probes. The participant
probe retained the recorded Corrosive Bile target and weapon cooldown data;
the Everyone probe's 176-by-168 creep mask matched the previously verified
recording. Native Windows integration tests cover unrelated-window isolation,
streams, timeouts and cleanup after agent termination. These are bounded
background-runtime probes, not a claim that every driver or Windows dialog
can be suppressed.

Pure tests cover bit order and row orientation, stationary sample compression,
cargo and ownership changes, morph lifecycles, effect lifetimes, weapon cooldown
resets, current attack targets, cache identity and incomplete artifact fallback:

```powershell
python -m pytest apps/replay-engine/tests/test_sc2_observation_export.py -q
```

Local artifacts have a 128 MiB limit. The cloud compactor starts with a
0.15 world-unit position error and raises that bound in 0.05-unit steps only
when the upload budget requires it, up to 0.5 units. The chosen value is
reported as `fidelity.positionError`. Every candidate is recomputed from the
original observations; arbitrary point thinning is never applied to engine
tracks. Both sides of cargo visibility changes, form changes, observation
gaps and teleport-sized jumps remain fixed anchors. Compression cannot create
a new moving interval longer than two seconds.

The Washout LE validation replay contains 469,568 source position samples.
Its complete payload retains 139,836 trajectory anchors with a reported
0.35-unit bound; comparison at every source timestamp measured a maximum
error of 0.3494 units. All 1,106 unit lives, 167 structures, 4,293 weapon cycles,
3,783 observed aim points, 524 creep frames and 29 effects remain. The normal
API request body is 4,939,810 bytes; gzip of the compact record is 1,035,149
bytes. Its formerly misplaced Interceptor now appears at its recorded cargo
exit position immediately when it becomes visible.

If the protected evidence cannot fit at 0.5-unit accuracy, the agent reports
an upload-capacity failure and preserves the recorded artifact and existing
cloud playback. It does not upload a misleading partial engine payload.
`fidelity.complete` means the sampled export survives within its reported
position bound; it does not claim a position sample at every simulation loop.
Tracker fallback payloads can still report `complete: false` when their own
budgets omit evidence. A time-bounded export never publishes a partially
serialized artifact.
