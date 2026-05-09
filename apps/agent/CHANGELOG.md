# Changelog

All notable changes to `@sc2tools/agent` go here. Newest first.

## 0.5.13

### Note on the version jump (0.5.10 → 0.5.13)
- `agent-v0.5.11` and `agent-v0.5.12` were tagged but the on-disk
  ``__version__`` bump never landed. The installer filename came from
  the tag (correct) but the binary inside reported itself as 0.5.10
  in heartbeats / crash reports / the updater, putting users in a
  soft update loop. v0.5.13 is the first release where the on-disk
  ``__version__`` matches the tag again.

### Fixed (originally targeted at v0.5.11; PR #157)
- **Active Army chart no longer renders a phantom late-game opponent
  spike.** A streamer's PvZ replay showed the opponent army line
  stay near zero for ~13 minutes and then jump vertically to ~9 200
  in seconds — caused by the SPA reconstructing the army value via
  a fragile cascade (``unit_timeline`` → build-order cumulative +
  timeline-derived deaths → food-supply heuristic) that fell through
  to the cumulative count without applying any deaths whenever the
  timeline was sparse for one side. The agent now ships
  ``army_value`` per ``PlayerStatsEvent`` row (sc2reader's
  authoritative ``minerals_used_active_forces +
  vespene_used_active_forces``) and the SPA chart binds to it
  directly. The derived/heuristic paths are now hard-clamped to
  ``ARMY_FALLBACK_CAP`` so neither can synthesise a vertical spike
  even on legacy uploads.

### Fixed (originally targeted at v0.5.12; PR #159)
- **WarpGate-warped units no longer dropped from the SPA's roster.**
  ``extract_macro_events`` populated ``unit_lifetimes`` only on
  ``UnitBornEvent``, but WarpGate-warped units (Adept, Stalker,
  Sentry, Zealot, Templar) emit ``UnitInitEvent`` + ``UnitDoneEvent``
  and never fire ``UnitBornEvent``. The reference replay had 41
  Adepts warped via WarpGate — every one was missing from the
  composition snapshot. The extractor now accepts EITHER
  ``UnitBornEvent`` OR ``UnitDoneEvent`` as the canonical "alive"
  tick for non-building units, deduped by uid.
- **``_clean_building_name`` no longer corrupts ``"Zergling"``.**
  The helper used a global ``raw_name.replace("Zerg", "")`` —
  ``"Zergling"`` literally starts with the substring ``"Zerg"`` so
  the prefix was eaten and the name became ``"ling"``, falling
  out of every downstream lookup. Same bug corrupted
  ``"SprayZerg"`` → ``"Spray"`` and ``"SupplyDepotLowered"`` →
  ``"SupplyDepoted"``. The prefix-strip now requires a CamelCase
  boundary; ``"Zergling"`` and ``"SprayZerg"`` preserved while
  legacy ``"ZergHatchery"`` still folds to ``"Hatchery"``.

### Fixed (PR #160)
- **Overlords are now counted in the alive roster.** sc2reader's
  ``army_value`` (which the SPA chart binds to) includes Overlord
  supply cost and so does sc2replaystats's Army Value chart.
  Pre-fix, ``Overlord`` was in ``SKIP_UNITS`` so the roster's
  Σ(unit_cost × count) drifted ~100/Overlord below the chart's
  army number for every Zerg game. Removing the skip makes chart
  and roster agree.
- **Overseer (and any morph-from-supply unit) now appears.** With
  Overlord tracked, the existing UnitTypeChange rename path handles
  Overlord → OverlordCocoon → Overseer automatically. A
  defence-in-depth ``elif`` was added so any future morph chain
  whose parent is in SKIP_UNITS but whose target is army-relevant
  surfaces in the timeline.
- **Ability/projectile "units" skipped from the roster.** Reaper
  ``KD8Charge``, Sentry ``ForceField``, Oracle ``OracleStasisTrap``,
  and Disruptor ``DisruptorPhased`` (Purification Nova projectile)
  all fire ``UnitBornEvent`` with a player pid but have no
  meaningful cost-catalog entry. Added all four to ``SKIP_UNITS``
  so they no longer pollute the Macro Breakdown roster as
  broken-icon chips.
- **Building stance forms (``SporeCrawlerUprooted``,
  ``CommandCenterFlying``, etc.) can't leak in via morph creation.**
  The new morph-creation handler in the UnitTypeChange branch now
  rejects names ending in ``Uprooted`` / ``Flying`` / ``Lowered``
  AND any uid already in the building-lifetimes tracker, so the
  airborne/uprooted form of a building can't show up as a "unit".

### Re-import note
- Re-import (or click Recompute on the Macro Breakdown panel) on any
  replay extracted by an earlier agent to pick up the new
  ``army_value`` field, the alive-Adept tracking, and the corrected
  Zergling / Overlord / Overseer roster contents. Legacy uploads
  keep rendering through the SPA's clamped derived path — no
  vertical spike, but the absolute army number stays an
  approximation until re-uploaded.

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
