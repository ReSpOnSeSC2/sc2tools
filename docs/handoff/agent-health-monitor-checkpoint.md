# Agent health monitor (roadmap 76, slice A1)

2026-11-01. Branch `claude/agent-health-monitor`, worktree `agent-health-a1`,
based on `origin/main`. Nothing is committed yet. This slice adds the health
model and feeds it. Nothing renders it yet.

## What the monitor does

`apps/agent/sc2tools_agent/health.py` is new. It has no Qt and imports only the
standard library plus the stdlib-only `folder_info` labels.

- Subsystems push facts through small setters on `HealthMonitor`. Each push
  replaces one frozen `HealthFacts` under one lock. Pushes from many threads
  never lose each other.
- A push claims at most one pending recompute. The recompute runs at most twice
  a second and always reads the newest facts. Many pushes in one window give one
  recompute.
- The clock (`clock`, monotonic), wall time (`now`) and scheduler (`schedule`)
  are injectable. The default scheduler starts one daemon `threading.Timer`
  named `sc2tools-health` per window. There is no long-lived thread.
- `evaluate(facts, now)` is pure. It returns a frozen `HealthSnapshot` that
  compares by value. An equal snapshot is not emitted again.
- Subscribers run outside the lock. If a subscriber pushes again, the newer
  snapshot reaches every subscriber after the current one. A failing
  subscriber or scheduler is logged and never breaks a push.
- `refresh()` re-checks time-based rules without new facts. The runner calls it
  from the existing 30 s status refresh.

`None` in a fact means "not reported yet". A rule with unknown input adds no
row, so the app never claims something it hasn't checked.

## Snapshot

- `headline`: "Everything's working", "1 thing needs attention",
  "N things need attention", or a boot headline. While the phase is `starting`
  or `connecting` and nothing needs attention, it is "Starting SC2 Tools…".
- `attention`: the number of `warn` and `error` rows.
- `level`: the most severe visible level, or `ok`.
- `tray`: `red`, `amber`, `grey`, `green`, or `None`.
- `rows`: visible rows, sorted by level (error, warn, info, ok), then table order.
- `footer`: the `off` rows, in table order.

Tray level: `red` when the top row is an error. `None` while starting with
nothing to attend to. `grey` when the first warn row is the pause. `amber` for
any other first warn row. Otherwise `green`. Table order keeps a pairing
problem amber while paused, as the old status priority did.

## Rule table

The table order is the order below. A boot failure replaces every other row
and empties the footer. Help is `desktop-app-status` unless noted.

| # | Row id | When | Level | Sentence | Action |
|---|---|---|---|---|---|
| 0 | boot | boot failure, or phase `boot_error` | error | The failure summary (see below) | restart_agent |
| 1 | pairing | unlinked | warn | This PC was unlinked from your account. | link_pc |
| 1 | pairing | not linked | warn | Link this PC to your account to start syncing. | link_pc |
| 1 | pairing | linked | ok | This PC is linked to your account. | |
| 2 | paused | paused | warn | Sync is paused until 14:30. / Sync is paused, so new replays wait until you resume. | resume |
| 3 | cloud | uploads held (connection not online) | warn | Can't reach sc2tools.com, so 312 replays are waiting. Busy, slow-down and signed-out variants. Help: desktop-app-sync-problems. | retry_now (link_pc when signed out) |
| 3 | cloud | heartbeat failing for 150 s | warn | Can't reach sc2tools.com right now; SC2 Tools keeps trying. Busy variant. Help: desktop-app-sync-problems. | |
| 3 | cloud | socket disconnected | info | Actions from the website can't reach this PC right now. | |
| 3 | cloud | a heartbeat succeeded | ok | Connected to sc2tools.com. | |
| 4 | failures | 3 or more terminal failures in 10 min | warn | 5 uploads failed in the last 10 minutes. | open_log |
| 5 | folders | no folder watched | warn | No replay folder found; add your StarCraft II Replays folder. | add_folder |
| 5 | folders | added folders missing | warn | 1 replay folder you added is missing. | add_folder |
| 5 | folders | watching | ok | Watching 2 replay folders (EU, NA). | |
| 6 | identity | 3 or more `player_unresolved` skips in the last week (older skips, such as observed games, never warn) | warn | 12 games from the last week were skipped because SC2 Tools couldn't tell which player was you. | set_player_name |
| 6 | identity | source reported as none | info | SC2 Tools doesn't know your player name yet. | set_player_name |
| 6 | identity | source known | ok | Your player name comes from your sc2tools.com profile. Cache, replay and Settings variants. | |
| 7 | analyzer | probe failed | error | The replay analyzer didn't load, so new replays can't be read. | open_log |
| 7 | analyzer | probe ok | ok | The replay analyzer is ready. | |
| 8 | uploads | pending | info | Uploading 12 replays. | |
| 8 | uploads | archive backlog | info | Backing up 40 replay files. | |
| 8 | uploads | last upload known | ok | Last upload 3 min ago. | |
| 8 | uploads | started, nothing yet | ok | Waiting for your next game. | |
| 9 | archive | server reports games without originals | info | 12 of your 300 saved games need one full Re-sync to back up their replay files. | |
| 10 | filter | a sync range is set | info | Only games from Season 67 sync. | |
| 11 | updates | install failed | warn | Version 0.25.0 couldn't install. | install_update |
| 11 | updates | required | warn | This version is no longer supported; install version 0.25.0. | install_update |
| 11 | updates | available | info | Version 0.25.0 is ready to install. | install_update |
| 12 | live | live off | off | Live game features are off. | |
| 12 | live | contact in the last 15 s | ok | Connected to StarCraft II. | |
| 12 | live | otherwise | off | StarCraft II is closed. | |
| 13 | obs | off | off | OBS scene switching is off. | |
| 13 | obs | password rejected | warn | OBS rejected the saved password. | open_obs_settings |
| 13 | obs | not connected | info | OBS isn't connected, so scenes won't switch. | open_obs_settings |
| 13 | obs | connected | ok | Connected to OBS. | |
| 14 | auto_update | off | off | Automatic updates are off. | |

The cloud row is hidden while the PC isn't linked. The uploads row is hidden
while unlinked, paused or offline, because those rows already explain it.

## Boot failures

`classify_boot_error(exc, *, state_dir=None)` returns a frozen
`BootFailure(kind, summary)` and never raises.

| Kind | When | Headline | Summary |
|---|---|---|---|
| network | requests connection or timeout errors, `ConnectionError`, `TimeoutError`, HTTP 408, 429 or 5xx | SC2 Tools couldn't reach sc2tools.com | Check your internet connection, then restart SC2 Tools. |
| analyzer | an `ImportError` of `core`, `sc2reader`, `mpyq` or `s2protocol`, or a traceback through them | SC2 Tools couldn't load the replay analyzer | The replay analyzer didn't load (reason). |
| state_dir | permission errors, or disk full, read-only or any `OSError` inside the data folder | SC2 Tools can't use its data folder | Windows blocked a file or folder SC2 Tools needs (reason). / SC2 Tools can't use its data folder (reason). |
| unknown | anything else | SC2 Tools couldn't start syncing | The first line of the error, up to 140 characters. |

The reason uses `strerror` for file errors, so no file path is shown.

## Wiring in this slice

`runner._Multiplexer` builds one `HealthMonitor` next to `StatusFacts`, seeds it
with phase, pairing, pause and folders, and fans each snapshot out with
`getattr(sink, "on_health", None)`. No sink has `on_health` yet.

Facts pushed today:

- `on_phase`, `on_analyzer_probe`, `on_paused`, `on_folders`, `on_filter_label`,
  `on_pairing_state`, `on_unlinked`, `on_paired`, `on_connection_state`,
  `on_upload_success`, `on_upload_failed`, `on_pending`,
  `on_replay_archive_status` and `on_update_available`.
- `on_recent_snapshot`: skip counts by reason and the saved last upload time.
- The update scheduler now passes `required` and `failed` to
  `on_update_available`. Sinks still get only the version.
- Heartbeat success and failure, through `_health_heartbeat`, after the
  existing recovery hooks run. Failures record `errors.classify(exc).kind`.
- The queue's existing `on_archive_pending_changed` callback.
- `--no-live` and the auto-update setting, at start and after Settings saves.
- The GUI boot worker records `classify_boot_error(exc)` before
  `on_phase("boot_error")`.

`derive_status`, `StatusView` and every existing sink are unchanged. The tray
keeps its `StatusView` dot. Only the paused dot changed: it is now the new
`palette.GREY`. The `desktop-app-status` help article says "Grey dot." for
Paused.

## Decisions

- Paused is a `warn` row. It counts as attention and greys the tray.
- Sentences carry no countdown, so snapshots stay stable and dedupe works.
  Ages use minutes, hours or days and refresh with the 30 s status refresh.
- One heartbeat failure is not a problem. The cloud row warns after 150 s of
  failures, about three missed beats.
- "Starting SC2 Tools…" is an extra headline. Saying "Everything's working"
  before boot finishes would repeat the bug this item fixes.
- `copy_details` is in the action set but no row uses it. The card keeps Copy
  details as its own button, next to Restart agent for boot failures.
- Requests errors are matched by class name, so `health.py` never imports
  requests.

## Slice A2 (agent GUI)

- Add `GuiUI.on_health` and a `healthChanged(object)` signal. Keep only the
  latest snapshot before the window exists; don't queue it in the 256-event
  deque.
- Rebuild the dashboard card as headline, rows and a grey footer. Remove the
  window's own `StatusFacts` derivation so one source feeds the card.
- Map row actions to handlers: Link PC, Retry now, Add folder, Set player name
  (focus the name field), Resume, Open OBS settings (scroll to the OBS card),
  Install update, Open log, Copy details and Restart agent.
- Restart agent must spawn the new process after `AgentInstanceLock` is
  released, with different commands for frozen and source runs.
- Decide whether the tray dot follows `snapshot.tray` (dropping cyan and blue),
  and update the help article in the same change.
- Clear the archive row when Re-sync starts.

## Slice B (heartbeat, API, web)

- Build the heartbeat `sync` block from `HealthMonitor.facts()` plus state:
  pending, archive pending, paused, folder counts, last upload, last error kind,
  skip counts, rejected, filtered and unresolved names. Cap it under 2 KB.
- Whitelist it in `recordHeartbeat`, count ingest rejections by code, add
  `GET /v1/me/sync-health` and the doctor warnings, then the web pill, Sync
  health card and Devices row. Old agents send no `sync`; treat that as unknown.

## Not done

- Nothing renders snapshots yet.
- These setters exist and are tested but nothing calls them yet: `set_socket`
  (no SocketClient callback), `live_contact` and `set_live(True)` (the poller
  only emits on phase changes), `set_obs` (no disconnect callback),
  `set_identity` (`_ensure_player_handle` doesn't report its source),
  `set_folders(missing=...)` (only the window knows missing folders) and
  `set_transport_error`.
- Until live contact is wired, a live-on run shows no live row.
- The archive row only clears when the server reports again.
- Changelogs are untouched; the release step adds them.

## Verification

From `apps/agent`:

- `python -m pytest tests/test_health_monitor.py tests/test_status_model.py tests/test_tray_status.py tests/test_runtime_status_sync.py tests/test_help_links.py -q`:
  91 passed.
- Runner-adjacent files (`test_build_checkin_ui_runner`, `test_build_checkin_wiring`,
  `test_calm_sync`, `test_dashboard_runner`, `test_foundation_publication_races`,
  `test_match_aware_workers`, `test_obs_token_rotation`, `test_pairing_recovery`,
  `test_runner_live_identity`, `test_runner_obs_settings`,
  `test_runner_replay_archive`, `test_runner_save_settings`,
  `test_preset_policy_cache`, `test_theme`, `test_tray`): 267 passed.

The full agent suite, web vitest and builds were not run.
