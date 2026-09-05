# Observed map replay export

The tracker parser is a fast fallback. Its position events are sparse and do
not contain terrain creep masks. Command target coordinates are orders, not
unit positions. The web replay marks this fallback and uses recorded anchors
without inventing mining trips or movement routes.

For detailed playback, the desktop agent can run the replay through the
installed StarCraft II engine. This optional export captures actual unit
positions, unit type changes, presence intervals, spell effect extents and
global creep. It runs in hidden background windows and does not control an
existing game process.

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

Pure tests cover bit order and row orientation, stationary sample compression,
cargo and ownership changes, morph lifecycles, effect lifetimes, weapon cooldown
resets, current attack targets, cache identity and incomplete artifact fallback:

```powershell
python -m pytest apps/replay-engine/tests/test_sc2_observation_export.py -q
```

Local artifacts have a 128 MiB limit. The cloud compactor normally simplifies
tracks within a declared 0.15 world-unit position error; validation against
370,795 source observations measured a maximum error of 0.1494 world units.
The complete example includes 18 observed spell effects and 406 creep frames,
with a serialized API upload body of 4,456,521 bytes including attack data. This
preserves turns and timing within the existing upload budget. Hard budget
limits can require additional thinning or data omission, in which case
`fidelity.complete` is false. “Complete” means the
sampled export survived those limits; it does not claim a position sample at
every simulation loop. A time-bounded export never publishes a partially
serialized artifact.
