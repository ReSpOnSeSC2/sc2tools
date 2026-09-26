# Visible neural checkpoint preview

This runner connects the saved AlphaStar-derived diagnostic network to native
StarCraft II. It is inference only: no optimizer updates, coached fallback,
automatic build order, or ladder rating measurement. The current checkpoint is
`runs/alphastar-foundation-v1/full-game-fit-v1`, with 5,065 cumulative offline
updates on one permitted-perspective PvT training replay. It is not a competitive
policy or the original DeepMind AlphaStar model.

The Windows host uses the current player observation, the existing paid camera
and spatial-selection controller, a hard 200-input rolling-minute limit, and fog
of war. It verifies exactly eight starting workers without editing the scenario.
The persistent WSL GPU worker receives one observation at a time and returns a
checkpoint-, session-, player-, and frame-bound prediction. Native simulation
does not advance during inference; a one-times pacing target makes the game
watchable. Actual wall time can be longer because inference and transport add
latency.

## Start one isolated game

Use a fresh output directory for each attempt. Existing runs, checkpoints,
corpora, snapshots, and STOP markers must be preserved.

1. Run `scripts/play_alphastar_checkpoint.py prepare` with the pinned checkpoint
   directory, matching public `game-data.json`, supported eight-worker map, and
   fresh output directory. This starts no processes.
2. Start `scripts/serve_alphastar_checkpoint.py` in the pinned WSL GPU environment
   with that session, checkpoint, and catalog. Supply a hashed, permitted,
   observation-only warmup frame. Its prediction is discarded and RNG reset;
   replay labels and spectator mapping must never be used as live actor input.
3. Wait for `worker-status.json` to show `ready` and `warmup_complete: true` with a
   recent heartbeat. Verify process identity; do not duplicate workers.
4. If SC2TOOLS is capturing replays, use its normal **Pause syncing** control.
   Keep automatic capture enabled. Wait until its SC2 child has exited and the
   persisted pause bit is true. The installed agent's Pause cancels and later
   retries an unfinished capture; completed caches and its queue are retained.
   Do not edit its state file, kill the agent, or launch a competing engine.
5. Run `scripts/play_alphastar_checkpoint.py run --output <fresh-session>` using
   the Windows virtual environment. The host rechecks pause, worker readiness,
   hashes, STOP markers, and absence of any existing SC2 client before launch.
6. After the owned game and worker end, use **Resume syncing** in the agent and
   verify capture resumes. Do not leave mapping paused after the preview.

The prepare/run and worker CLIs document all required paths with `--help`.
The current installed agent state path is only read for its pause flag; its
credentials must never be logged. A future supported agent engine lease can
replace the manual UI handoff, but the installed 0.16.11 agent has no such API.

## Evidence and limitations

- `preview.json` pins the model, catalog, map, and controller source.
- `worker-status.json` identifies the model worker and inference progress.
- `live-status.json` shows observed HUD, actual predictions, accepted/deferred
  intents, and input counts. Deferred illegal/unavailable predictions are not
  silently replaced with scripted actions.
- `events.jsonl` and numbered consumption receipts retain execution evidence.
  Consumed observation spool bodies are removed to bound disk usage.
- `status.json`, `audit.json`, and `game.SC2Replay` record the final outcome and
  restrictions. A startup failure is not gameplay skill evidence. A saved replay
  is considered natively checked only when its final hash matches the bytes
  verified by SC2; inspect both replay verification fields.

The first connected run is `runs/alphastar-native-preview-v3`; it stopped after
120 game seconds on a transient Windows/WSL status-file sharing error. A bounded
retry fixes that transport issue. The subsequent `runs/alphastar-native-preview-v4`
completed a 300-second connection check with no training updates, eight starting
workers, and a peak of 159 paid inputs per rolling minute. Its opening failed:
it reached 21 workers and built gas, but no Gateway or army. Replay mapping was
resumed through the agent UI after its owned game and worker exited.

Earlier attempts retain evidence of pre-game/initialization issues. Do not interpret a functioning
adapter as successful learning: unweighted held-out matches, broader replay
coverage, temporal context, source/target accuracy, and actual reinforcement
learning remain separate work.
