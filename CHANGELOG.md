# Changelog

All notable changes to SC2 Tools are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are tagged `vMAJOR.MINOR.PATCH`; the GitHub Actions release
workflow builds the Windows installer on each tag push and attaches the
`.exe` and `.sha256` to the corresponding GitHub Release.

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