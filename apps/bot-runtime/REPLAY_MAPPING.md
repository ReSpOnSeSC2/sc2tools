# SC2TOOLS mapping and richer imitation data

SC2TOOLS mapping is still active: **104/620 complete local native captures, 516 pending**, checked2026-09-26T02:38:43.071018+00:00. The original agent PID/creation time matches and one SC2 capture child is active. The three prior oversized uploads remain recovered. A fourth, long Lockdown replay retains its complete local cache but exceeds both the corrected5MiB request and200,000-motion-point limits; one shot/death timestamp also needs semantic review. Do not recapture it or truncate its events. [Failure evidence](runs/heartbeat-20260926-0207/upload-recovery/README.md). The installed source fix does not hot-update the running packaged EXE.

The previously installed four implementation and five test files remain unchanged;157 installed-source regression tests passed in the prior repair. Its three verified remote recoveries remain preserved.

Earlier batch receipts follow chronologically.

The user explicitly authorized enabling the installed SC2TOOLS agent and fully
mapping the available eight-worker replays on September 25, 2026. Automatic map
replay capture is enabled; the existing agent processes its queue. Do not start
another agent, another replay engine, or a global 13,000-game resync.

## Current batch

`runs/replay-expansion-inventory-v1/inventory.json` verifies 620 unique current
build originals, both players starting with eight workers: 228 PvT, 124 PvP,
267 PvZ and one TvZ from ReSpOnSe's perspective. The 28 games shorter than a
minute and older engine builds are outside this training-oriented batch.
All 90 original corpus hashes match and remain unchanged.

The durable API dispatch journal is `dispatch.jsonl` in that run directory.
`dispatcher-process.json` records the dispatcher identity. The dispatcher only
requests singleton recomputation; the already paired agent performs the capture
and ordinary upload. HTTP acceptance, local complete capture and cloud upload
are separate states. Never report accepted requests as completed mappings.

Dispatch finished at 22:02:30 UTC: 615 accepted singleton requests and five
reused complete captures. The 22:03:31 UTC completion review verified 16 local
captures complete (11 newly generated), 604 still pending, the original agent
running and exactly one engine child. Both dispatcher processes exited. This
is a timestamped snapshot; use current progress for later counts.
`dispatch-completion-review.json` preserves these receipts.

The 22:14:51 UTC heartbeat verified 20 complete local maps and 600 pending.
One of those complete maps, `At Eternity's Edge LE (39)` (PvZ, original SHA
`9e0983676c71bd54c6fa4bcf61f3c7ff14ef0db0a77326739d4be3aa12fc5646`),
could not upload its rich playback because it exceeded the existing format's
capacity. Its complete 16,313,272-byte native cache and sidecar are preserved.
The agent then uploaded ordinary analysis, so an upload cursor alone is not
proof of rich cloud playback. Do not recapture this replay to fix upload size;
reuse its local artifact after a format/API capacity correction. See the
[heartbeat review](runs/heartbeat-20260925-2206/mapping-preservation-review.md)
and [failure evidence](runs/heartbeat-20260925-2206/capture-budget-failure.json).

Refresh local status without starting an engine:

```powershell
.venv/Scripts/python.exe runs/replay-expansion-inventory-v1/inspect_progress.py
```

Read the resulting `progress-current.json`, current agent logs and process IDs
**plus creation times** before resuming or diagnosing. Respect the run's `STOP`
marker. It stops further dispatch; already queued jobs are controlled by the
agent's Pause syncing or automatic replay capture setting. Preserve unrelated
league/coached STOP markers. Retry a rejected request only after establishing
that it was not already queued; do not blindly replay an uncertain HTTP result.

## What the agent maps

The existing exporter in `C:/SC2TOOLS` captures native positions, paths, unit
lifetimes/morphs, combat events, effects and creep. Its map playback deliberately
combines spectator information with fog disabled. This is useful playback and
review data, **not an admissible observation for the restricted Protoss actor**.

The project separately captures each selected player's preceding observations,
camera, visibility, selection UI, available abilities and exact native action
wire. It retains only permitted current entities and timestamped memory. Both
paths use the original replay identity and exact installed SC2 engine version.
Never fill missing player information using future frames or spectator state.

## The connection to the learner

`src/pluto_sc2/rich_dataset.py` creates immutable derivatives of completed native
player captures. `runs/alphastar-intent-dataset-v1` contains 681 admitted command
and camera intentions from the first 300 seconds of one complete TRAIN game.
All 2,482 original action records were checked against their wire, timestamp and
strictly preceding frame. The derivative includes Probe, Pylon, Gateway, Nexus,
gas, Cybernetics Core and Stalker examples. Unsupported UI inputs and unresolved
actions remain in its admission audit; they are not fake no-op demonstrations.

Some expert construction targets are clipped at a screen edge. These become
planned intentions with explicit camera/selection/visibility requirements, not
permission for the executor to issue raw or offscreen construction commands.
The separate intent decoder must pay for those inputs, reacquire the source and
target and confirm actual accepted actions under the existing 200 APM controller.

The official AlphaStar modules use the separate tensor/trainer bridge in
`src/pluto_sc2/alphastar_tensor.py` and `scripts/train_alphastar_replay.py`.
Training runs write their actual status, source/data hashes, active loss masks,
optimizer update count and checkpoint hash into new immutable run directories.
A successful diagnostic is proof of data flowing through learning, not proof of
a playable policy, held-out accuracy, or an MMR level.

The completed `runs/alphastar-foundation-v1/replay-gradient-v3` diagnostic used
64 TRAIN-only updates on 24 actual replay examples and verified exact checkpoint
reload. Function accuracy rose from 0/24 to 4/24, source-set accuracy from 0/23
to 5/23, and target-unit accuracy from 0/6 to 2/6 under teacher forcing. Position
argmax accuracy stayed 0/9. The separate world-gradient audit confirms active,
finite gradients and lower position loss, without claiming placement skill.
This checkpoint is not deployed into games or the old league.

`policy_intents.py` now converts predicted function/argument indices into
intentions bound to one live session, player, frame and exact entity-pointer
table. It rejects padding, stale bindings, hidden targets, friendly attacks,
unsupported queueing and invalid map coordinates. Predicted intentions have
their own identity; they are never mislabeled as observed native replay wire.
`IntentRuntime(session_id=...)` routes accepted plans through the existing paid
controller. These components still need a live observation-only encoder, a
checkpoint inference caller, and native execution verification before deployment.
The final project regression suite passed 2,818 tests; the agent dispatch and
progress helpers also passed nine isolated tests.

## Larger dataset plan

`runs/rich-replay-expansion-plan-v1/manifest.json` is an **inactive preparation
manifest**: 620 original games, 1,240 participant perspectives. It preserves all
existing 90-game assignments and gives 496 training / 124 validation originals.
Both players and all duplicate copies share one original's partition.

Only training opponent wins against ReSpOnSe receive the requested 2× sampling
weight. Evaluation remains unweighted. PvT supplies TvP opponent examples and
PvZ supplies ZvP; the inventory has only one actual TvZ/ZvT original. Do not
mislabel ZvP examples as ZvT or report 1,240 independent games.

This plan has not changed the active corpus or collected every restricted
perspective. The rich pilot currently validates Protoss; Terran/Zerg capture and
tensor support must be verified with their race-specific worker and action
contracts before those entries can train separate policies. Keep their intended
600 APM/global-own/current-visible-enemy allowance and fog boundary explicit.

After mapping, continue selected-player extraction, held-out opening evaluation
and paid decoder checks. Broad reinforcement learning stays behind the live
opening gate. Preserve completed models and snapshots; do not replace the
existing league baseline with a diagnostic checkpoint.
