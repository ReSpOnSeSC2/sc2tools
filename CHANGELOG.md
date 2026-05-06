# Changelog

All notable changes to SC2 Tools are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are tagged `vMAJOR.MINOR.PATCH`; the GitHub Actions release
workflow builds the Windows installer on each tag push and attaches the
`.exe` and `.sha256` to the corresponding GitHub Release.

## [Unreleased] - 2026-05-06

### Fixed (agent v0.3.4)

- **Dashboard "Active" card showed only one folder.** When the Settings
  tab was configured with multiple `Replays/Multiplayer` directories
  (one per region or BattleTag), the dashboard's status line still read
  `Folder: <first folder only>` — giving the false impression the agent
  was ignoring the rest. `_format_status_lines` in `ui/gui.py` now
  enumerates every watched folder, pluralises the headline
  (`Watching 2 replay folders`), and the status sub-label uses
  `setWordWrap(True)` so long path lists render cleanly.
- **Auto-detect button erased the list instead of populating it.** The
  Settings tab's Auto-detect previously called `self._folder_list.clear()`
  on the assumption the runner would rediscover on next start — but
  the user couldn't see the result, and any folders the auto-scan
  missed would silently disappear. The button now actively scans
  `find_all_replays_roots()` + `all_multiplayer_dirs_anywhere()` and
  populates the list inline, preserving any user-added entries that
  the scan didn't find.
- **Auto-discovery only saw the first Documents location.** The legacy
  `find_replays_root()` returned the FIRST matching `Documents` folder
  and stopped, so a user with both regular `Documents` AND a OneDrive
  copy of the SC2 tree only had one root watched. Replaced with
  `find_all_replays_roots()` (returns every match, deduped by resolved
  path) and `all_multiplayer_dirs_anywhere()` (unions every Multiplayer
  dir across every root). Probed extra Windows locations:
  `Pictures\Documents`, `%USERPROFILE%\Documents`, and
  `%USERPROFILE%\OneDrive\Pictures\Documents`. Both the runner's
  startup discovery and the watcher's `_discover_roots` now use the
  union helper.
- **Replay-parser import error permanently skipped every replay.**
  When `parse_replay_for_cloud` failed to import
  `core.sc2_replay_parser` (frozen-exe DATAS missing, race during
  PyInstaller extract, or a broken install), it returned `None` and
  the watcher's `_handle_replay` recorded the path as `"skipped"` in
  `state.uploaded`. Even after a fix or restart that resolved the
  import, those replays would never re-enter the queue. Introduced
  `AnalyzerImportError` so the watcher can distinguish a systemic
  import failure (don't skip; throttle the log to once per minute;
  retry on next sweep / restart) from a per-replay parse failure
  (skip as before). On recovery the watcher emits
  `analyzer_recovered`. Made `_ensure_analyzer_on_path` more robust:
  it now probes `_MEIPASS`, the exe parent, the exe grandparent, and
  several `parents[n]` levels for source mode, then retries the
  import once after re-probing in case the bundle DATAS finished
  extracting between the first attempt and the retry.

### Fixed (agent v0.3.3)

- **Replay parsing in the frozen exe.** The PyInstaller bundle did not
  ship `reveal-sc2-opponent-main/core/sc2_replay_parser.py`, and even if
  it had, the runtime `sys.path` patcher used a `parents[3]` walk that
  pointed outside `_MEIPASS` once frozen. Result: every `.SC2Replay`
  the watcher saw failed to parse with a flooding `Could not import
  sc2_replay_parser` error and nothing ever uploaded. The spec now
  bundles the reveal package alongside `SC2Replay-Analyzer`, and
  `replay_pipeline._ensure_analyzer_on_path` switches to `_MEIPASS` in
  frozen mode and the repo root in source mode.
- **Open dashboard sent users to a dead domain.** The runner's
  `_dashboard_url_from_api` fallback hard-coded `https://sc2tools.app`,
  which is no longer authoritative. The marketing + dashboard origin is
  `sc2tools.com`. Updated the runner default, the console UI's pairing
  text, the GUI's API-base placeholder, and the NSIS installer's
  `URLInfoAbout` registry value.
- **Dashboard action row clipped its button labels.** Five buttons in
  one row at the window's minimum width forced Qt to shrink each
  button below its natural size, so `Re-sync from scratch` rendered
  with the trailing word past the button border. Split into two rows
  (local vs. external actions), gave each button a `Maximum, Fixed`
  size policy, and used shorter labels with explanatory tooltips so
  the layout stays readable at 820 px wide.

### Added (agent v0.3.3)

- **Multi-folder replay watching.** StarCraft II writes a separate
  `Replays/Multiplayer` directory per (region, battle.net handle)
  pair, so a player on multiple regions or alts needed more than one
  override. State now stores `replay_folders_override` as a list and
  forward-migrates the old `replay_folder_override` string. The
  Settings tab presents a real list with **Add folder…**, **Remove
  selected**, and **Auto-detect** buttons; the dashboard's "Add replay
  folder…" appends rather than replaces; the tray menu shows
  `(+N more)` when more than one folder is being watched. The watcher
  picks up new entries on its next sweep without a restart.

## [Unreleased] - 2026-05-04

### Added

- **Cloud SaaS foundation (Stage A + D + E + F + G slice).** New monorepo
  layout under `apps/`:

  - **`apps/api/`** — Express + MongoDB cloud API (Render-deployable via
    `apps/api/render.yaml`). Clerk JWT auth + long-lived device-token
    auth so the local agent and the web SPA share routes. Per-user
    storage of opponents, games, custom builds. HMAC-pepper hashing of
    opponent battle-tags so PII never lands in the cloud DB. Routes:
    `/v1/health`, `/v1/me`, `/v1/opponents{,/:pulseId}`,
    `/v1/games{,/:gameId}` (POST ingest), `/v1/custom-builds`,
    `/v1/device-pairings/{start,:code,claim}`, `/v1/devices`,
    `/v1/overlay-tokens`. Socket.io live `games:changed` push.
  - **`apps/web/`** — Next.js 15 (App Router) frontend, Vercel-ready.
    Clerk-hosted sign-in (Google + Discord + email/password). Real
    pages: landing, sign-in/up, `/app` analyzer (with live SyncStatus
    pill), `/devices` pairing flow, `/streaming` overlay-token mgmt,
    `/builds` library, public `/overlay/[token]` for OBS Browser
    Source. SWR-driven data fetching with per-request Clerk JWTs.
  - **`apps/agent/`** — Python single-file agent (PyInstaller-ready).
    Watches the user's SC2 Replays folder (watchdog FS events +
    periodic OneDrive sweep), parses each replay through the existing
    `SC2Replay-Analyzer` parsers (chrono fix preserved), uploads to
    `/v1/games`. Tray UI (pystray) with live status + console
    fallback. Atomic state writes for the device token + dedupe
    cursor. Pairing-code flow.

- **`docs/cloud/SETUP_CLOUD.md`** — top-to-bottom 60-90 min setup
  walkthrough covering MongoDB Atlas, Clerk (with optional custom
  Google OAuth credentials), Render, Vercel, custom domain wiring,
  agent install on the gaming PC, OBS overlay configuration, and
  troubleshooting.

### Performance

- **Opponents tab no longer freezes when new replays land.** The
  4-second `setInterval` in `analyzer.js#startWatching` was calling
  `fs.readFileSync` + `JSON.parse` on `MyOpponentHistory.json`
  (~27 MB) and `meta_database.json` (~137 MB) on the main event loop —
  blocking GET `/api/opponents` for hundreds of milliseconds every
  cycle. Replaced with a worker-thread-backed background loader
  (`stream-overlay-backend/lib/background-loader.js{,.worker.js}`)
  that:
  - Detects file changes via the same cheap mtime+size+head/tail
    signature as before.
  - Off-loads the 27 MB JSON parse to a `worker_threads` worker so
    HTTP requests stream through unimpeded.
  - Atomically swaps `dbCache.meta.data` / `dbCache.opp.data` once the
    parse returns.
  - Salvages the valid prefix on truncated mid-write reads (matches
    the existing `salvageJsonObject` algorithm so behaviour parity is
    maintained).
  - Emits the same `analyzer_db_changed` Socket.io event so live SPA
    tabs continue to refresh in real time.

### Tests

- New: `apps/api/__tests__/{hash,gameRecord}.test.js` — 10 cases
  covering HMAC pepper determinism, token randomness, validator
  enums and required fields.
- New: `apps/agent/tests/{test_state,test_config,test_api_client}.py`
  — atomic-write round-trip, env handling, retry/auth behaviour.
- New: `stream-overlay-backend/__tests__/background-loader.test.js`
  — 4 cases asserting worker-driven reload, signature change
  detection, and stable-signature no-op.
- All `tsc --noEmit --strict` clean for `apps/api/`. Unit suites
  green: 10/10 (api), 4/4 (analyzer background loader).

## [1.4.7] - 2026-05-02

### Fixed (critical)

- **``meta_database.json`` mid-write truncation (139 MB) lost ~14 game
  records and silently failed strict parse.** Same corruption family as
  the v1.4.6 ``MyOpponentHistory.json`` issue, different mode: the file
  ended abruptly inside a half-written game record (3 unclosed opening
  braces at EOF, ~100 KB of trailing partial data), failing strict
  ``JSON.parse`` at byte 136,981,034 of 136,981,633. Builds tab still
  worked because the SPA tolerates an empty ``dbCache.meta.data`` for
  some queries, but per-build / per-game drilldowns degraded silently.

  Two-part fix:

  1. **Recovery script**: ``data/recover_meta_database.py`` salvages the
     current file by walking backward through ``},\n`` record boundaries
     until parse succeeds (recovers ~99.92%, 11,501 game records),
     loads the latest cleanly-parseable backup
     (``meta_database.json.pre-reclassify-2026-05-01T19-02-22-861Z``,
     11,515 records) as the base, and merges per-build with games
     deduped on the ``id`` field (``date|opponent|map|game_length``).
     When the same id appears in both, the SALVAGED-CURRENT version
     wins (carries post-reclassify enrichment + same-day updates).
     Quarantines the corrupt original + backup-of-record under
     ``data/.recovery-meta-<UTC>/`` with a README.
  2. **Backend salvage hardening**: fixes a bug in
     ``stream-overlay-backend/analyzer.js`` ``salvageJsonObject`` where
     the ``bounds.length < 50`` cap inside the boundary-collection loop
     kept only the FIRST 50 ``},\n`` boundaries (from the *start* of
     the file). For any file with more than 50 record boundaries (e.g.
     ``meta_database.json`` at ~72,000) the truncated tail was never
     reached and salvage silently failed. v1.4.7 collects ALL
     boundaries then attempts the LAST 500 (walking backward from end
     of file). In practice salvage of a single mid-record truncation
     succeeds in fewer than 100 attempts; the 500-cap is a fast-path
     safeguard so we don't try tens of thousands of attempts on a
     totally garbage file.

  Net effect: any future ``meta_database.json`` mid-write truncation
  is recovered transparently on backend boot instead of returning
  empty data.

## [1.4.6] - 2026-05-02

### Fixed (critical)

- **Opponents page silently lost full game history (data corruption).**
  Production user reported the Opponents tab only showed today's matches
  while Builds correctly showed full history. Investigation revealed
  ``data/MyOpponentHistory.json`` was a 27.7 MB file whose first 45,184
  bytes were a complete top-level JSON dict (6 opponents only) followed
  by ~27 MB of pure trailing whitespace -- the corruption signature of
  an in-place re-write that produced a shorter payload but did NOT
  truncate the destination file before writing the new content. The
  backend's existing ``salvageJsonObject`` always APPENDED ``\n}\n`` to
  the trimmed content, producing ``{...}\n}\n`` (extra closing brace,
  parse fails). With every salvage strategy missing, ``dbCache.opp.data``
  fell back to ``{}`` and the Opponents tab silently showed nothing
  beyond what the live PowerShell scanner had written that session.

  Two-part fix:

  1. **Recovery of the live file.** Performed an offline merge of the
     6 surviving opponents (sliced to the first balanced top-level
     brace pair) with the most recent large parseable backup
     (``MyOpponentHistory.json.pre-merge-unknown-20260501T143757Z``,
     3,178 opponents / 11,020 game records). Per-opponent merge took
     the union of games (deduped on ``(Date, Map, Result)``) and
     ``max(Wins, Losses)`` per matchup. Result: 3,183 opponents /
     11,033 game records, atomically written via tmp + ``os.replace``,
     verified to parse cleanly. Corrupt original + backup-of-record
     quarantined under ``data/.recovery-<UTC-timestamp>/`` with a
     README explaining root cause + restoration approach.
  2. **Backend salvage hardening.** ``stream-overlay-backend/
     analyzer.js`` ``salvageJsonObject`` rewritten with three ordered
     strategies (cheapest -> most aggressive): trim-trailing-whitespace
     (catches the exact production corruption above), slice-to-first-
     balanced-brace-pair (string- and escape-aware so quoted braces
     don't fool the depth counter -- catches the "well-formed dict
     followed by non-whitespace garbage" case e.g. a half-written
     second copy appended after the first object), then the original
     append-close-brace + drop-trailing-records strategies (catches
     "write was interrupted mid-record"). Returned dict carries a
     non-enumerable ``__salvageStrategy`` hint so the reload path can
     log which strategy hit. This means a future occurrence of the
     same corruption mode is recovered transparently on backend boot
     instead of returning empty data.

## [1.4.5] - 2026-05-02

### Fixed (critical)

- **Session double-counting wins/losses.** ``/api/replay`` had no
  idempotency check, so any duplicate POST for the same replay
  (real-world causes: OneDrive sync emitting 2-3 ``on_created`` events
  for one ``.SC2Replay`` file as it's uploaded; watcher restart picking
  up a replay that landed mid-restart in both the live event and the
  catch-up sweep) would increment ``session.wins`` / ``session.losses``
  / streak / MMR delta twice. Symptom: session widget showed 0-2 when
  only one game was actually lost. Adds a bounded LRU cache (200 entries)
  keyed on ``gameId`` at the top of the handler; duplicates respond
  ``{ ok: true, duplicate: true }`` and bypass all state mutations.
  Payloads missing ``gameId`` (legacy callers, manual POSTs from
  ``/static/debug.html``) fall through unchanged.

### Added

- **Browser auto-open in unified launcher.** Both ``START_SC2_TOOLS.bat``
  copies (repo-root and ``reveal-sc2-opponent-main/``) now have a
  ``[5/5]`` step that polls ``http://localhost:3000/api/health`` for up
  to 30 seconds and then opens ``http://localhost:3000/analyzer/`` in
  the user's default browser via ``Start-Process``. The legacy
  ``SC2ReplayAnalyzer.py`` shim used to do this with
  ``webbrowser.open()``; now that the unified launcher is the only
  supported entry point, the SPA-launch step lives there too. If the
  health probe times out the launcher prints a yellow warning and
  opens the browser anyway -- worst case the user gets a refreshable
  "site can't be reached" page instead of nothing happening.

### Fixed

- **Multi-region opponent matching with MMR-band disambiguation.**
  Replaces the v0.9.5 "first user region with a name hit wins" loop in
  ``Reveal-Sc2Opponent.ps1``. The old logic had two failure modes that
  showed up the moment a player had identities on more than one region
  (e.g. ``us`` + ``eu``):

  1. Opponent name collisions across regions made the script lock onto
     whichever region Pulse's lagged ``lastPlayed`` happened to point
     at -- typically NOT the region the user was actually on after
     switching servers. Symptom: ``[Pulse] Active region detected: EU``
     followed by an MMR for the wrong "John#1234".
  2. When the strict ``caseSensitive=true`` probe missed in every user
     region, the script logged ``"Opponent name not found in any user
     region"`` and then silently fell back to ``Find-PlayerProfile`` +
     ``Get-OpponentTeams`` -- which often DID find a match using the
     same query shape, in a region the user was never told about.
     Symptom: log says "not found" but the next line shows a real MMR
     and head-to-head record (potentially for the wrong player).

  The new logic probes EVERY user region (strict pass, then a
  case-insensitive retry across every region if strict misses
  everywhere), fetches each Pulse hit's team data (rating + last
  played), and scores each candidate by MMR delta against the user's
  rating ON THAT REGION. A 400-MMR band rejects out-of-band collisions.
  The region containing the best in-band candidate wins; tiebreak on
  recency. If no region has an in-band match the fallback prefers the
  user's highest-MMR team for the current race instead of stale
  Pulse-recency. Every decision prints a transparent diagnostic line
  (``[Pulse] Active region: us (in-band MMR match (delta=72,
  case-sensitive))``) so the user can see exactly which signal won.

  Also bumps the embedded ``Reveal-Sc2Opponent.ps1`` ``PSScriptInfo``
  ``.VERSION`` from ``0.9.5`` to ``0.9.6``.

- **``-ActiveRegion`` rejected multi-region configs from subprocess
  launchers.** ``Reveal-Sc2Opponent.ps1``'s parameter declared
  ``[ValidateSet("us", "eu", "kr", "cn")] [string[]]$ActiveRegion``,
  which validates each array element against the set. When the Python
  launcher (``scripts/poller_launch.py`` -> ``core/launcher_config.
  build_poller_argv``) passed ``-ActiveRegion us,eu`` via
  ``subprocess.Popen``'s argv list, ``powershell.exe -File`` bound it
  as a single string ``"us,eu"`` and ValidateSet rejected it before
  the script body ran. Removes the ``ValidateSet`` attribute and
  validates manually after splitting on comma -- both shapes
  (``@("us","eu")`` and ``"us,eu"``) now work, bad codes still
  produce a clean error and ``exit 1`` instead of a noisy parameter
  binding error.

### Removed (Stubbed)

- **``SC2Replay-Analyzer/SC2ReplayAnalyzer.py`` retired.** The legacy
  standalone launcher used to spawn its own ``npm start`` /
  ``replay_watcher`` / ``Reveal-Sc2Opponent.ps1`` stack and open the
  SPA in a browser. It is no longer referenced by anything in the
  active launch chain, but Windows shortcuts and Start-menu pins
  pointing at it still fired and double-launched everything against
  the unified ``START_SC2_TOOLS.bat`` already running. Replaced with a
  50-line stub that pops a Tk ``messagebox`` (with a ``print + input``
  fallback for headless / pythonw-without-Tk) telling the user to use
  ``START_SC2_TOOLS.bat`` instead, then ``sys.exit(0)``. Original
  contents preserved in git history (``git log -p
  SC2Replay-Analyzer/SC2ReplayAnalyzer.py``) if revival is ever
  needed.

## [1.4.0] - 2026-05-02

### Added

- **Watcher hot-reloads ``data/config.json``.** ``watchers/replay_watcher.py``
  now polls ``data/config.json``'s mtime every ~5 s and reconciles the
  running watchdog observer with the latest ``paths.replay_folders`` /
  player handle. Folders the user removes in Settings -> Folders are
  unscheduled in place; folders they add are scheduled and run through
  the catch-up scan so games played before the folder was registered
  still land in the DB. Saving from the SPA no longer requires
  restarting the watcher window.

- **``Settings -> Profile`` runtime helpers.** New
  ``SettingsRuntimeControlsGroup`` renders below the identities group
  and exposes a "Restart Poller" button + helper text explaining the
  watcher hot-reload behaviour. The button POSTs to a new
  ``/api/runtime/restart-poller`` endpoint that spawns a fresh
  ``scripts/poller_launch.py`` (which kicks off a new
  ``Reveal-Sc2Opponent.ps1`` window) so the poller picks up the
  saved identity. The old PowerShell window keeps running until the
  user closes it (different console owner; we can't kill it from
  here), so the success toast tells them so explicitly.

- **``/api/runtime/*`` router.** New ``stream-overlay-backend/routes/
  runtime.js`` owns helper-process restart endpoints:
  ``GET /api/runtime/status`` returns ``{ watcher_hot_reload_sec,
  can_restart_poller }`` so the SPA can decide which controls to render;
  ``POST /api/runtime/restart-poller`` spawns the poller via
  ``poller_launch.py`` (detached, ``stdio: 'ignore'``) and returns the
  child PID.

### Fixed

- **``START_SC2_TOOLS.bat`` hardcoded ``C:\SC2TOOLS``.** The launcher set
  ``TOOLS_ROOT=C:\SC2TOOLS`` and then ``cd /d %TOOLS_ROOT%\reveal-sc2-opponent-main``,
  so any user who unpacked the toolkit on a different drive
  (e.g. ``E:\response\sc2tools``) saw every panel die immediately with
  ``The system cannot find the path specified.`` -- the Replay Watcher
  window in particular flashed the error before exiting because
  ``cd /d`` failed before ``py -m watchers.replay_watcher`` could run.
  Both copies of ``START_SC2_TOOLS.bat`` (repo root and
  ``reveal-sc2-opponent-main\``) now derive ``TOOLS_ROOT`` / ``ROOT``
  from ``%~dp0`` (matching the existing pattern in
  ``reveal-sc2-opponent.bat``) so the launcher works regardless of
  install drive, and they bail out with an explicit "expected path"
  message when the layout is wrong instead of silently spawning broken
  child windows. Honours hard rule #6 (UX must work without docs).

- **Replay watcher honoured a hardcoded ``WATCH_DIR``.**
  ``watchers/replay_watcher.py`` had a hardcoded
  ``DEFAULT_WATCH_DIR = r"C:\Users\jay19\OneDrive\..."`` and ``main()``
  only ever watched that single path. The wizard already writes
  ``paths.replay_folders`` to ``data/config.json`` -- the watcher just
  wasn't reading it. ``main()`` now resolves targets in priority order
  (CLI override -> ``paths.replay_folders`` -> legacy
  ``DEFAULT_WATCH_DIR``), runs the catch-up scan against every
  configured folder, and schedules a watchdog observer per folder so
  users with multiple SC2 installs (Battle.net + PTR, OneDrive +
  Documents) get all of them watched. Missing folders are logged and
  skipped instead of failing the whole watcher.
  ``_read_player_handle()`` now also falls back to
  ``identities[0].name`` when neither legacy ``last_player`` /
  ``player_name`` key is present.

- **Pulse poller hardcoded ``(?i)ReSpOnSe`` for "who's me?".**
  ``Reveal-Sc2Opponent.ps1`` already accepted ``-PlayerName`` for Pulse
  ID resolution but two later regex matches (``Get-MyResult`` and the
  live opponent-detection block) ignored the parameter and matched a
  hardcoded ``(?i)ReSpOnSe``. For every other user, ``$Me`` resolved
  to ``$null`` and the result was silently lost. The script now builds
  a ``$Script:MyNamePattern`` from ``-PlayerName`` (or, when blank,
  derives one by querying Pulse ``/character/<id>`` for each resolved
  ``$CharacterId``) and uses that pattern in both places. The launcher
  side (``launcher_config.build_poller_argv``) was also updated to
  pass ``-PlayerName`` alongside ``-CharacterId`` so the PS1 always has
  the configured handle to work with.

- **``poller_launch.py`` required the legacy sibling project on disk.**
  ``scripts/poller_launch.py`` did
  ``sys.path.insert(0, _REPO_ROOT.parent / "SC2Replay-Analyzer")`` and
  then ``import launcher_config``. Post-merge installs that no longer
  carry the legacy sibling crashed Box 4 with a ``ModuleNotFoundError``
  the moment the launcher started it. ``launcher_config`` is now
  shipped inside the merged repo at ``core/launcher_config.py``;
  ``poller_launch.py`` imports from there first and falls back to the
  legacy sibling location only when the merged copy isn't present.

- **Launcher: only 1 of 3 cmd windows loaded.** ``START_SC2_TOOLS.bat``
  Box 1 pointed at ``C:\SC2TOOLS\SC2Replay-Analyzer\SC2ReplayAnalyzer.py``,
  a separate Python project that no longer exists after the merge into
  ``reveal-sc2-opponent-main``, so the backend never started. Boxes 2
  and 3 used ``python`` while Box 1 used ``py`` -- whichever variant
  was missing from PATH made those panels error out immediately.
  Restructured to ``[1/4]``: Box 1 runs ``npm start`` directly from
  ``stream-overlay-backend``; Box 2 launches the analyzer GUI silently
  via ``pythonw -m gui.run_gui`` (logs go to ``data/analyzer.log``);
  Boxes 3 and 4 use a top-of-file ``%PYTHON%`` variable so the
  interpreter choice is consistent across panels; Box 4 calls
  ``scripts/poller_launch.py`` directly instead of double-shelling
  through ``reveal-sc2-opponent.bat``. ``reveal-sc2-opponent.bat``
  itself now prefers ``py`` and falls back to ``python`` so the
  standalone path still works when only one of the two is installed.

- **Onboarding: replay import failed during the wizard.**
  ``pickPythonProjectDir()`` in ``stream-overlay-backend/analyzer.js``
  only looked for the legacy sibling ``SC2Replay-Analyzer`` directory.
  Since the project is now merged into ``reveal-sc2-opponent-main``
  the lookup returned ``null`` and the wizard surfaced "Could not
  locate the SC2Replay-Analyzer Python project." Even after the path
  check, ``scripts/macro_cli.py`` flat-out didn't exist -- the
  ``/macro/backfill/start`` endpoint was shelling out to a script
  that was never written.

### Added

- ``scripts/macro_cli.py`` -- new CLI with a ``backfill`` subcommand
  that reads the configured replay folders from
  ``data/config.json`` (``paths.replay_folders``), recursively scans
  every ``.SC2Replay`` file, parses each one with
  ``core.sc2_replay_parser.parse_live`` (load_level=2, fast), and
  imports the resulting games into ``data/meta_database.json`` via
  ``AnalyzerDBStore``. Idempotent on game id; supports
  ``--db`` / ``--player`` / ``--limit`` / ``--force``. Emits one
  newline-delimited JSON object per replay so the onboarding wizard
  can render a live progress bar:
  ``{"progress": {"i": N, "total": T, "ok": bool, "file": "..."}}``
  followed by a single
  ``{"result": {"updated": ..., "errors": ..., "skipped": ..., "total": ...}}``.

### Changed

- ``analyzer.js`` ``pickPythonProjectDir()`` now prefers the merged
  layout: ``ROOT`` itself (the ``reveal-sc2-opponent-main`` project)
  is treated as the Python root when ``ROOT/core`` exists, so the
  ML and macro CLIs no longer require a sibling SC2Replay-Analyzer
  directory. The legacy sibling and ``C:\SC2TOOLS\SC2Replay-Analyzer``
  paths are kept as fallbacks for un-migrated installs.

## [1.3.0] - 2026-05-01

### Added

- **Standalone onboarding diagnostic tool.** New
  ``tools/diagnose-onboarding.bat`` and ``tools/diagnose-onboarding.py``
  let a non-developer user diagnose the opaque
  ``no_human_players_found`` Step 3 failure on their own machine. The
  .bat double-clicks; the script auto-discovers replay folders across
  OneDrive variants (including corporate ``OneDrive - Company``),
  classic Documents, Dropbox, Google Drive, iCloud, Box, public
  Documents, plus a bounded recursive walk of every drive letter for
  ``StarCraft II/Accounts`` (skipping ``Windows``, ``$Recycle.Bin``,
  ``System Volume Information``, ``node_modules``, etc.). Drag-drop a
  Multiplayer folder onto the .bat to override auto-discovery. Probes
  ``sc2reader``, parses the newest five replays, and writes
  ``diagnose.txt`` with a one-line VERDICT and per-replay parse
  outcome — the user emails the file back instead of reading the
  wizard''s opaque error code. Reads only; never modifies state.

### Fixed

- **Skip buttons unblock dead-end wizard steps.** Step 3 (Identity)
  could trap a user whose replays sc2reader could not parse: the Next
  button stayed disabled at ``Next (0)`` with no escape. Steps 2
  (Replays) and 4 (Race) had the same dead-end shape when nothing was
  selected. Each step now renders a ghost-styled ``Skip`` button next
  to the disabled Next when no choice has been made; the happy path
  UI is unchanged when a selection exists. Schema-wise, the Apply
  step already tolerates ``identities: []`` (no ``minItems``), and
  ``preferred_races`` is not schema-validated, so Skip on Steps 3 and
  4 produces a valid config the user can fill in later from
  Settings → Profile. Step 2 Skip remains available for symmetry but
  Apply still fails on empty ``replay_folders`` (schema requires
  ``minItems: 1``); documented as a known follow-up.

## [1.2.0] - 2026-05-01

### Added

- **Launcher orchestrates all three runtime components.** ``SC2Replay-
  Analyzer/SC2ReplayAnalyzer.py`` now spawns the Express backend, the
  live ``watchers.replay_watcher``, and the SC2Pulse PowerShell poller
  (``Reveal-Sc2Opponent.ps1``) under one process tree, registers each
  child with ``atexit`` for clean shutdown, and waits for
  ``/api/health`` before opening ``/analyzer/`` in the browser. Closes
  the gap where ``packaging/installer.nsi``''s desktop and Start Menu
  shortcuts ran the launcher — which only spawned the backend — while
  ``START_SC2_TOOLS.bat`` was the only path that booted all three
  windows. New installs and existing shortcuts now pick up watcher +
  poller automatically. ``data/config.json`` gains an optional
  ``runtime`` section (``spawn_watcher`` / ``spawn_poller``, default
  ``true``) so power users can disable individual children; the
  poller auto-disables when the config has neither character IDs nor
  a player name.

- **Pure-function config reader.** New
  ``SC2Replay-Analyzer/launcher_config.py`` exposes ``load_config``,
  ``read_pulse_args``, ``read_runtime_flags``, and ``build_poller_argv``.
  All four are pure (no IO once the file is read) and covered by 21
  unit tests under ``SC2Replay-Analyzer/tests/test_launcher_config.py``.
  The launcher and the standalone helper share ``build_poller_argv``
  so the PowerShell argv shape can never drift between callers.

### Changed

- **``reveal-sc2-opponent.bat`` no longer hardcodes identity.** The
  former ``SC2_CHARACTER_IDS=994428,8970877`` /
  ``SC2_PLAYER_NAME=ReSpOnSe`` / ``ACTIVE_REGIONS=us,eu,kr`` lines are
  gone; the .bat now delegates to a new Python helper
  ``reveal-sc2-opponent-main/scripts/poller_launch.py`` that reads
  ``data/config.json`` (whatever the wizard wrote) and spawns
  PowerShell with the right ``-CharacterId`` / ``-ActiveRegion`` /
  ``-PlayerName`` arguments. Fixes the long-standing problem where a
  fresh install pinged the maintainer''s Pulse IDs until the user
  manually edited the .bat.

### Fixed

- **Wizard Step 5 (Import past replays) actually imports.**
  ``WizardStepImport`` was passing only ``folders`` into the embedded
  ``SettingsImportPanel``; identities never reached
  ``pendingConfig.identities``, so ``selectedNames`` stayed empty and
  the panel''s Start button was permanently disabled. Users could
  click Continue past Step 5 with no historical import ever firing —
  the apply step''s ``start-initial-backfill`` only triggers macro
  recompute on already-imported games, not a folder walk. ``wizard-
  shell.jsx`` now passes ``selectedIdentities`` and ``battleTags``;
  ``wizard-apply-import.jsx`` threads them into ``fakePendingConfig``.
  Smoke-tested against the real first-run wizard flow with
  ``data/config.json``''s two identities.

## [1.1.0] - 2026-05-01

### Fixed

- **Eliminate the file-truncation incident root cause.** Production
  data files (`meta_database.json`, `MyOpponentHistory.json`,
  `config.json`, `custom_builds.json`, `community_sync_queue.json`,
  `import_state.json`, `session.state.json`,
  `stream-overlay-backend/public/_ov/design-tokens.json`,
  `package.json`) and their tracked siblings were being silently
  truncated by writers that did `tempfile + os.replace` /
  `tempfile + fs.renameSync` without an intervening `flush + fsync`.
  Three NTFS-specific failure modes (lazy-writer truncation,
  indent-line truncation, null-byte padding) were observed in
  `data/*.broken-*` over a 96-hour window. Fixed in five phases:
  (1) `flush + fsync` added to `scripts/macro_cli.py` and
  `scripts/buildorder_cli.py` `_save_db`; (2) Python long-tail
  writers (`core/error_logger.py`, `gui/analyzer_app.py` CSV +
  debug report, `core/custom_builds.py` binary backup,
  `core/data_store.py` backup marker) routed through
  `core.atomic_io.atomic_write_{json,text,bytes}`;
  (3) the three duplicated Node atomic-write impls
  (`_atomicWriteJsonSync` in `index.js`, `persistMetaDb`'s inline
  writer in `analyzer.js`, local `atomicWriteJson` in
  `routes/settings.js`) collapsed to thin delegators against
  `lib/atomic-fs.js`; (4) `analytics/spatial.py` cache and
  `analytics/win_probability.py` model save paths picked up
  `flush + fsync`; (5) `scripts/check_atomic_writes.py` added as a
  pre-commit / CI guard so a future regression fails the build.
  Three live data files (96 MB, 2.4 MB, 1.4 KB) recovered from
  the cleanest snapshot (`MyOpponentHistory.json` regained
  ~2,000 opponent records that the truncation had eaten); five
  secondary tracked JSONs restored from HEAD. See
  `docs/adr/0016-atomic-file-writes.md` for the rule and
  `docs/TRUNCATION_AUDIT.md` for the byte-level evidence.

### Fixed

- **Opponent widget shows real W-L when Black Book misses.** The merged
  opponent card was rendering 'first meeting' for opponents the user had
  played before whenever `MyOpponentHistory.json` was truncated mid-write,
  while the scouting card looked correct because its recent-games row reads
  `meta_database.json` directly. Backend now: (1) replaces the indent-
  specific `_attemptHistoryRepair` with a `_salvageJsonObject` salvage that
  walks `},\n` boundaries (handles both modern 4-space and legacy 15-space
  PowerShell indent), (2) wraps `readMetaDb` with the same salvage so the
  live overlay path keeps producing real numbers when meta_database is
  partially written, (3) falls back to a meta-DB-derived W-L when the
  Black Book has no entry for the opponent so opponentDetected and
  scoutingReport always agree on the record, and (4) resets the
  `lastOpponentText` dedup anchor when `opponent.txt` is cleared at
  game-end so a same-text rewrite next game still triggers a fresh emit.
  (`stream-overlay-backend/index.js`)
- **PowerShell `Write-FileAtomic` now fsyncs before rename.** The opponent
  scanner's atomic-write helper had `[System.IO.File]::WriteAllText` followed
  immediately by `Move-Item` -- on Windows NTFS that returns once the bytes
  hit the OS write cache, NOT once they're durable on disk. A kill/sleep/AV
  between rename and lazy-flush left `MyOpponentHistory.json` truncated. The
  helper now opens the temp file via `FileStream`, writes the bytes, calls
  `Flush($true)` (FlushFileBuffers, the Win32 fsync) before closing, and only
  THEN renames. Mirrors the contract used by `core/atomic_io.py` and
  `analyzer.js::persistMetaDb`. (`Reveal-Sc2Opponent.ps1`)
- **PowerShell scanner now writes to `data/MyOpponentHistory.json`.** It was
  writing to the legacy project-root path while every other component reads
  `data/`, which let the two files drift (recently played opponents wouldn't
  show up on the overlay until the next Python writer ran). The scanner now
  resolves `$HistoryFilePath` to `data/MyOpponentHistory.json` (with a
  fallback to the legacy path if `data/` doesn't exist yet).
- **One-shot data repair.** Salvaged and rewrote `data/MyOpponentHistory.json`
  (3168 entries clean, plus 10 unique entries merged in from the legacy
  copy = 3178 total, including the `FIIClicK#670` record that triggered
  this debug session). Salvaged and rewrote `data/meta_database.json` (56
  builds, 7921 games). All three files now parse cleanly via strict
  `JSON.parse`; the salvage fallback in the readers stays in place as
  defense-in-depth. Originals preserved as `.pre-repair-<ts>.bak`.



### Added

- **Windows installer (NSIS).** New `packaging/installer.nsi` plus
  orchestrator `packaging/build-installer.ps1` produce
  `dist/SC2Tools-Setup-<version>.exe`. Bundles embeddable Python 3.12,
  pre-installs every Python and Node.js dependency at build time so the
  user installer needs no PyPI / npm registry access at install time,
  defaults to a per-user install at `%LOCALAPPDATA%\Programs\SC2Tools`,
  detects Node.js 18+ on PATH, registers an HKCU uninstaller, and drops
  Start Menu + Desktop shortcuts pointing at the Stage 3 launcher.
- **Release CI.** `.github/workflows/release.yml` builds the installer
  on tag push `v*.*.*` and on manual dispatch, runs the silent install
  smoke test, and attaches the `.exe` plus `.sha256` sidecar to the
  GitHub Release.
- **ADR 0014** documents the NSIS + bundled-Python decision and the
  per-user install path choice.
- **Auto-update (Stage 12.1).** New `routes/version.js` exposes
  `GET /api/version` (1-hour cached lookup against the GitHub Releases
  API) and `POST /api/update/start` (localhost-only, same-origin,
  single-use nonce). The SPA gets an `<UpdateBanner>` at the top of
  every page that surfaces newer releases, and the existing
  Settings -> About "Check for updates" button is wired to the same
  endpoint. Helper `packaging/silent-update.ps1` waits for the backend
  to exit, downloads the new `.exe` to `%TEMP%`, verifies the published
  SHA256, runs the installer with `/S`, and relaunches via the install
  location stored in `HKCU\Software\SC2Tools`.
- **Version sync guard.** `.github/workflows/version-check.yml` asserts
  that `stream-overlay-backend/package.json` (canonical),
  `SC2Replay-Analyzer/__init__.py` `__version__`, and the SPA's
  `SETTINGS_VERSION` literal all agree on every PR. Drift breaks the
  build instead of shipping a confused About panel.
- **ADR 0015** records the auto-update architecture: version source of
  truth, cache + nonce + spawn-and-exit pattern, and the three-layer
  guard on `/api/update/start`.

### Changed

- **Pinned dependencies.** Every Python and Node.js dependency now uses
  an exact version pin. `SC2Replay-Analyzer/requirements.txt` and
  `reveal-sc2-opponent-main/requirements.txt` use `==`; the Express
  backend's `package.json` mirrors the resolved versions from
  `package-lock.json`. This is a prerequisite for reproducible
  installer builds.

### Notes

- The first installer release will be tagged separately once the
  smoke test has run on a clean Windows 11 VM.
- Users on existing manual installs at `C:\SC2TOOLS\` are not migrated
  by the installer; they can either continue running from there or
  reinstall via the `data\` across by hand.
- Auto-update is op