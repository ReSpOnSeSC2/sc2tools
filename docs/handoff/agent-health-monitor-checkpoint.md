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

## A2: the dashboard card (done)

2026-11-01. Branch `claude/agent-health-card`, worktree `agent-health-a2`,
stacked on `claude/agent-health-monitor`. Nothing is committed yet.

### What the card shows

- `GuiUI.on_health(snapshot)` keeps only the newest snapshot, under the UI
  event lock. It never enters the 256-event pre-window backlog, so a burst
  can't push pairing or phase events out. Once the window exists, at most one
  `healthChanged` paint waits, and it always paints the newest snapshot.
- The status card (`ui/health_card.py`) shows the headline with the existing
  "?" (`desktop-app-status`), one line per visible row and a grey footer with
  the off rows' sentences.
- A line is a coloured dot, the sentence, at most one action button, and a "?"
  when the row has its own article. Cloud warnings open
  `desktop-app-sync-problems` at the connection kind's anchor. Identity and
  upload rows open `my-game-didnt-show-up`.
- `health.py` now gives identity and upload rows `GAMES_HELP`
  (`my-game-didnt-show-up`). The slug is in `AGENT_HELP_SLUGS` and the web
  lockstep test, in the same order.
- A row keeps its line while its id stays. A new count, sentence, dot or
  tooltip updates that line in place. Its buttons are rebuilt only when the
  row's action or help changes, and they read the line's current row when
  clicked. So a live count never takes a button, or its keyboard focus, away
  mid-click.
- The folders row lists the watched paths on hover, as the old headline did.
- Copy details shows when a row is an error. It copies the version, the
  headline, every row and footer line, the raw boot error or analyzer
  diagnostic, and the last 20 ERROR log lines.
- A boot failure shows its headline, its sentence, Restart agent and Copy
  details.
- The update badge and notice, the capture notice, What's new, the transient
  notice and folder Undo work as before.

### One source of truth

- The window's own `StatusFacts`, its `derive_status` call, the `statusView`
  signal, `GuiUI.on_status_view` and the card's 30 s and 1 s timers are gone.
  The runner's 30 s `refresh_status` already refreshes the time-based rows.
- The sidebar line now reads "● {headline}". Its hover adds the rows that need
  attention.
- The totals and the Pause, Re-sync and Add folder buttons follow the window's
  own pairing state, the one the pairing card uses, and a pending settings
  save.
- Folder changes from Settings (Save, instant Remove and Auto-detect) go
  through `_show_replay_folders`. Its `cell.ui.on_folders` updates the window,
  the tray and the health card's folders row together. Without a multiplexer
  it calls the tray and the window directly, as before.
- Starting a full Re-sync clears the archive row. Once
  `_handle_replay_archive_resync` succeeds, `_request_desktop_resync` calls
  `health.set_archive_status(0, 0)` only with a live upload queue and a
  running All-time sweep. A filtered, paused or unavailable-queue Re-sync,
  or one that fails to start, keeps it.
- The tray follows the same snapshot (see Tray below).

### Action map

| Action | What it does |
|---|---|
| link_pc | The pairing card's next step when the card is on screen (open the link page, get a new code, retry, link again); otherwise Link again. |
| retry_now | Upload retry (`on_sync_retry`). The signed-out cloud row offers it too, not Link PC. |
| add_folder | The add-folder flow (`_click_choose_folder`). |
| set_player_name | Opens Settings with the player-name field near the top, focused and selected. |
| resume | `on_pause(False)`. It waits for a pending settings save. |
| open_obs_settings | Opens Settings with the OBS card near the top. |
| install_update | The update card's install, on a worker thread. |
| restart_agent | Asks to confirm, with No as the default like the other confirmations, then restarts (see below). It waits for a pending settings save. |
| copy_details | Copy details. |
| open_log | The Activity log, errors only. |

A failing action is logged as `gui_health_action_failed` and never breaks the
card.

The signed-out cloud row now offers Retry now. Link again would keep the
rejected token, so nothing would be linked and the watchdog's failure count
would reset. The retry lets the watchdog confirm the unlink. Then the pairing
row offers Link PC. The A1 rule table above still shows the old `link_pc`.

### Restart agent

- `sc2tools_agent/relaunch.py` imports only the standard library.
  `run_agent` builds an `AgentRelaunch` before `_bootstrap` edits the
  environment. The new copy then reads settings saved since, such as a fixed
  API address.
- Restart agent arms it and calls the usual `request_stop`. When
  `_run_locked_agent` returns, `run_agent` releases the instance lock and only
  then starts the new copy. A copy started earlier would hand off to the old
  window and exit.
- Frozen runs start `sys.executable` with the same flags and
  `PYINSTALLER_RESET_ENVIRONMENT=1`. Source runs start
  `sys.executable -m sc2tools_agent` with the same flags.
- The restarted copy keeps its window visible. `--start-minimized` is dropped,
  and the relaunch environment sets `SC2TOOLS_RESTARTED=1`. The new copy's
  `_bootstrap` pops the marker and skips the saved `start_minimized` setting.
  It pops it on every start, so nothing that copy starts later (such as the
  updater's helper) inherits it. The next normal start minimizes again.
- The spawn is detached like the updater's helper: no console window and a new
  process group on Windows, a new session elsewhere, no inherited handles. A
  failed spawn is logged as `agent_relaunch_failed` and shutdown still
  finishes.
- Headless runs have no restart.

### Tray

- `TrayUI.on_health` replaces `on_status_view`. The tray's title is the
  snapshot's headline. Its hover reads "SC2 Tools - {headline}".
- The dot is `snapshot.tray` in palette colours: green, amber, red and grey
  for paused. There is no dot while starting. The cyan and blue tray dots are
  gone.
- Until the first snapshot arrives, the title keeps the old counters. A
  snapshot that arrives before the icon exists, as in a headless start, is
  drawn when the icon starts.
- `StatusView` still reaches the console sink. `_change_status` is unchanged.
- The `desktop-app-status` help article now describes the new card and tray:
  the headline, rows with one button each, the grey footer for off features,
  a boot failure with Restart agent, and the four tray dots.

### Not done

- Facts that need new hooks still add no row: the socket connection, live
  contact (a live-on run shows no live row), OBS state, the identity source,
  missing added folders and the transport error kind.
- Copy details still reads the log on the Qt thread, as before.
- Slice B (the heartbeat `sync` block, API and web) hasn't started.
- The unpublished 0.24.8 changelogs describe the health card and tray changes.
  No tag, native build or release was created.

### A2 verification

From `apps/agent`, with `-q -p no:cacheprovider`, after the review fixes:

- `tests/test_gui_health_card.py tests/test_relaunch.py tests/test_gui_runtime_controls.py tests/test_gui_pairing_recovery.py tests/test_gui_activity_log.py tests/test_health_monitor.py tests/test_help_links.py tests/test_tray_status.py tests/test_tray.py tests/test_runner_save_settings.py tests/test_runner_replay_archive.py`:
  155 passed.
- Runner, folder and window neighbours (`test_gui_folder_instant`,
  `test_gui_settings_polish`, `test_replay_folder_discovery`,
  `test_dashboard_runner`, `test_instance_lock`, `test_packaging_smoke`,
  `test_runtime_status_sync`, `test_calm_sync`, `test_gui_explicit_open`,
  `test_build_checkin_ui_runner`, `test_state`, `test_runner_live_identity`,
  `test_gui`, `test_status_model`): 175 passed, 6 skipped. The skips are the
  packaging checks that need PowerShell 7.
- Card neighbours (`test_gui_update_card_layout`, `test_gui_capture_consent`,
  `test_service_notices`, `test_gui_shared_agent_menu`): 12 passed.

The independent verifier found that a filtered or unavailable-queue Re-sync
could clear the archive row without starting a full backup. The fix checks
for a live queue and an unpaused All-time filter; four regression cases keep
the warning for absent queues, season/custom filters and paused sync.

After that fix, the targeted agent command above passed 159 tests. The web
help gate (`lib/help app/help components/help`, one fork) passed 23 files and
161 tests, including `agentLinks.test.ts` and the article markup/link checks.
Nine deliberate mutations were caught, including the new incomplete-sweep
guard, the six reviewed fixes, newest-snapshot delivery and restart ordering.
The mutation runner restored each source byte-for-byte. Local records are
under `.cache/agent-health-a2-20261102/` (`targeted-01`, `web-help-01` and
`mutation-01`); records are created exclusively and never overwritten.

The full agent suite and exact-head CI still need to finish before delivery.
