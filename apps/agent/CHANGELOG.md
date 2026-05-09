# Changelog

All notable changes to `@sc2tools/agent` go here. Newest first.

## 0.5.11

### Fixed
- **Active Army chart no longer renders a phantom late-game opponent
  spike.** A streamer's Jagannatha LE PvZ replay (10/22/2020) showed
  the opponent army line stay near zero for ~13 minutes and then
  jump vertically to ~9 200 in seconds — a number that didn't
  reflect actual gameplay. The cause was the SPA's army-value
  reconstruction cascade falling through to a *cumulative
  build-order count without death subtraction* whenever
  `unit_timeline.opp` was sparse for late-game samples.

  The agent now ships `army_value` per `PlayerStatsEvent` row in
  `stats_events` / `opp_stats_events` — sourced from sc2reader's
  `minerals_used_active_forces + vespene_used_active_forces`, the
  same authoritative number the in-game Army graph and
  sc2replaystats's Army Value chart show. The SPA chart now binds
  the army line to this directly, removing the fragile cascade
  entirely. Older sc2reader builds that expose
  `*_used_current_army` instead are picked up by a fallback so
  every install in the wild keeps emitting a valid number.

  Re-import affected replays after upgrading to overwrite the
  stored `macroBreakdown.stats_events` with the freshly-extracted
  values; legacy uploads keep rendering via the SPA's clamped
  derived path (no spike, but the absolute number stays an
  approximation until re-uploaded).

## 0.5.10

### Fixed
- **Build classification no longer flips on Sentry hallucinations.** A
  Sentry's Hallucination ability spawns Phoenix / VoidRay / HighTemplar
  / Archon / Immortal / Colossus / WarpPrism events that look identical
  to real production in the replay event log. The classifier was
  therefore mis-tagging 2-base Charge / Templar PvT games as
  `PvT - Phoenix Opener` or `PvT - Phoenix into Robo` whenever the
  opponent's Sentry tossed a single hallucinated Phoenix.
  Every pre-built build now requires its tech-structure prerequisite
  (Phoenix → Stargate, HighTemplar → Templar Archives,
  Carrier/Tempest/Mothership → Stargate + Fleet Beacon,
  Colossus/Disruptor → Robotics Facility + Robotics Bay, etc.). A unit
  only counts toward classification when at least one prerequisite
  alternative was *started* before the unit appeared. The structure
  does not need to still be standing — a Stargate killed at 5:00 still
  qualifies a Phoenix at 7:00, since the construction event lives in
  the event log permanently.
  Re-process affected replays after upgrading: re-import via the agent
  to overwrite the stored `myBuild` value with the freshly-computed
  classification.

## 0.5.9

### Fixed
- **Sync date range filter now takes effect IMMEDIATELY on Save.**
  Previously, already-queued uploads continued to fly out for up to
  ~30 seconds after a filter change, and watchdog FS events could slip
  through during the watcher's 10-second poll window. The runner now
  (a) drops queued uploads outside the new window via the new
  `UploadQueue.drain_outside_filter()`, (b) triggers an immediate
  watcher sweep via `ReplayWatcher.request_immediate_sweep()`,
  (c) re-evaluates previously-filtered replays against the new window,
  all before `save_state()` commits to disk so the on-disk state never
  diverges from the in-memory state on a partial-Save crash. The
  upload queue itself now re-checks the filter at the moment of the
  network call as defense-in-depth, so a job that beat the runner's
  drain (worker had already pulled it off the queue mid-batch) is
  still skipped before paying the HTTPS round-trip.
- The runner used to gate its post-Save `request_full_resync()` call
  on `cleared_filtered > 0`. A user transitioning from "All time" to
  "Current season" on a fresh-ish state has zero "filtered" entries
  to clear, so the resync ping never fired and the watcher only
  noticed the new filter ~10 seconds later on its next periodic
  sweep. Now resync + immediate-sweep are unconditional on every
  filter change.
- `save_state` previously ran BEFORE the filtered-entries cleanup
  loop, so the in-memory state and the disk state diverged for the
  rest of the runner's lifetime. On agent restart the stale
  "filtered" entries reloaded from disk and were never re-evaluated.
  Now `save_state` runs ONCE per Save click, after every in-memory
  mutation completes.

### Added
- `UploadQueue.drain_outside_filter() -> int` walks the queue and
  drops every job whose `game.date_iso` falls outside the active
  sync filter, returning the count dropped. Re-enqueues survivors in
  their original submission order. Persists `state.uploaded` once
  atomically if anything was dropped. Surfaces drops via the
  existing `_on_failure` callback (with a new `_FilteredOutError`
  sentinel exception) so the GUI's Recent uploads feed shows
  filter-drops alongside transport / rejection failures.
- `ReplayWatcher.request_immediate_sweep()` runs one extra sweep on
  a daemon thread without waiting for the periodic poll. Spawns a
  fresh thread per call; safe to call repeatedly because the
  watcher's `_inflight` set + `state.uploaded` dedupe prevent
  doubled work, and the new `_roots_lock` serialises concurrent
  rediscovery passes.
- `GuiUI.show_settings_status(msg)` lets the runner surface a
  post-Save toast in the Settings tab. The runner uses it to show
  the filter apply summary (active filter label, queued uploads
  dropped, previously-filtered replays re-eligible). Auto-clears
  after 5 seconds via a Qt single-shot timer.
- The dashboard status card now displays the active filter chip
  (e.g. "Watching for replays · Filter: Season 67"). Reads from a
  tracked `_active_filter_label` set on Save (not the live combo
  widget) so an in-progress edit never briefly mislabels the chip.

## 0.5.8

### Added
- **Batch upload + multi-worker upload pipeline.** The watcher's parse
  output now feeds into the cloud's batch endpoint
  (`POST /v1/games {games: [...]}`) instead of one HTTP request per
  game. Default batch size 25, default concurrency 1. With the
  cloud's 120 req/min rate limit that's `1 worker × 2 req/sec ×
  25 games/req = 50 games/sec sustained` — about 25× the v0.5.7
  ceiling on the same rate-limit budget. Configurable via
  `SC2TOOLS_UPLOAD_BATCH_SIZE` and `SC2TOOLS_UPLOAD_CONCURRENCY`
  env vars. Per-game `accepted` / `rejected` arrays in the response
  are mirrored back into `state.uploaded` independently, so a
  partial-success batch (e.g. 23 accept + 2 schema-reject) marks
  each game correctly.
- **Backpressure on `UploadQueue.submit`.** Pre-v0.5.8 the bounded
  queue silently dropped jobs when full. Process-mode parsers
  produce 5–10× faster than the upload thread can drain, so
  ~80% of replays were getting dropped + re-parsed on the next
  sweep, looping indefinitely. The new behaviour blocks the parse
  done-callback thread until the queue has space (5-min safety
  timeout). No data loss.
- **`Retry-After` honored on 429.** When the cloud rate-limits an
  upload, the API client reads the `Retry-After` header (RFC 7231
  integer-seconds form, with HTTP-date fallback) and sleeps that
  long instead of falling through to the 0.5/1/2-second exponential
  backoff. Clamped at 60 s so a buggy / hostile server can't hang
  the agent indefinitely.
- **`Pause` now stops the parser, not just uploads.** Pre-v0.5.8 the
  watcher kept submitting parses in the background while paused;
  process mode made that flood the log even after the user clicked
  Pause expecting silence. Pause now short-circuits both the
  periodic sweep and live watchdog file-create events.
- **Process-pool parse mode is back, default-on, with three guardrails.**
  The watcher's parse executor now picks `ProcessPoolExecutor` by default,
  giving the user's `parse_concurrency` slider real CPU parallelism (≈5×
  wall-clock speedup measured on a 12k-replay backfill — see
  `README.md#parse-pool-modes` for the table). The v0.3.9 attempt at
  this shipped enabled and crashed every PyInstaller-frozen child during
  spawn with `BrokenProcessPool`; v0.3.10 disabled the feature entirely.
  v0.5.8 re-enables it with:
  1. `_parse_in_worker` calls `bootstrap_analyzer_path()` as the FIRST
     thing it does on the child side, unconditionally re-bootstrapping
     the analyzer roots onto the child's `sys.path`. This fixes the
     direct cause of the v0.3.9 incident: the child importing
     `core.sc2_replay_parser` before the parent's `sys.path` mutations
     reached it.
  2. A boot-time synthetic probe in `_probe_process_pool()` spawns one
     child, asks it to import `core.sc2_replay_parser`, and waits 30 s
     for an answer. On any failure the agent logs
     `parse_pool_probe_failed err=<reason>` and falls back to
     `ThreadPoolExecutor` for the rest of the session — no crash, no
     stuck queue.
  3. A runtime catch in `_submit_parse` swaps the live process pool for
     a thread pool if `BrokenProcessPool` ever surfaces mid-session
     (e.g., a worker OOM during an unusually long replay). The replay
     re-submits transparently and the rest of the session continues
     in threading mode.
- New env var `SC2TOOLS_PARSE_USE_PROCESSES`: set to `0`, `false`,
  `off`, or `no` (case-insensitive, whitespace-tolerant) to force
  threading mode and skip the boot probe entirely. Anything else —
  including unset — keeps process mode enabled.
- New log line `parse_pool_mode=process|thread workers=N reason=…`
  emitted exactly once at boot, plus a second one if the runtime
  fallback triggers. Greppable triage signal for support.

### Changed
- `_on_worker_done` now takes the submitted path string as an explicit
  second argument (captured in the `add_done_callback` closure) so the
  inflight set is cleared even when `future.result()` raises. Without
  this a worker crash would orphan the inflight entry and the replay
  would never re-submit on a subsequent sweep. Threading-mode behaviour
  is unchanged.
- `ReplayWatcher.stop()` reads the live executor under `_executor_lock`
  before shutting it down — the runtime fallback can swap it
  mid-session and the previous read would have raced.

### Fixed
- Inflight-set leak when a parse worker raises before producing a
  result tuple. Previously the `finally:` block in `_on_worker_done`
  was unreachable because the early `return` in the `except`
  branch ran first. Now the `finally:` runs unconditionally and uses
  the captured submission path.

### Migration notes
- No state-file schema changes. State written by 0.5.7 loads
  unchanged in 0.5.8.
- The Settings tab's parse-concurrency slider now caps at
  `min(cpu_count, 12)` instead of `cpu_count`. Beyond ~8-12
  parse workers, additional workers just queue up parsed games
  in memory while the upload pipeline drains at its rate-limited
  ceiling — the cap keeps the slider honest. Users with a saved
  `parse_concurrency_override > 12` (e.g. 32 from running the old
  uncapped slider) get auto-clamped to 12 on next agent boot with
  a `parse_concurrency_clamped from=N to=12` log line. Power
  users on a self-hosted cloud API with a higher rate limit can
  bypass the cap entirely via the `SC2TOOLS_PARSE_CONCURRENCY`
  env var.
- If you experience instability on the new default, set
  `SC2TOOLS_PARSE_USE_PROCESSES=0` and please open an issue with the
  `parse_pool_probe_failed` line from `agent.log` so we can debug
  the underlying spawn issue on your install.
