# @sc2tools/agent - local replay daemon

Watches your SC2 Replays folder, parses each new replay, and uploads
the result to the SC2 Tools cloud API. Ships with a production
PySide6 GUI window for non-technical users, a system-tray indicator
for power users, and a console fallback for headless / CI runs.

## For end users - the easy path

1. Download `SC2ToolsAgent-Setup-X.Y.Z.exe` from the releases page.
2. Double-click the installer.
3. The agent launches and opens the **main window**. The 6-digit
   pairing code is shown in a large, readable card - click **Open
   pairing page**, sign in to SC2 Tools on the web, paste the code.
4. Done. The agent keeps running in the system tray. To open the
   window again, click the Start Menu shortcut **SC2 Tools Agent**
   or the desktop icon.

No command line. No `.env` editing. The Settings tab inside the
window covers API base URL, log level, replay folder override,
auto-start on Windows login, and "start minimised to tray".

## For developers - the source-install path

```bash
cd apps/agent
py -m pip install -r requirements.txt
copy .env.example .env
# (optional) override the cloud target:
#   .env -> SC2TOOLS_API_BASE=http://localhost:8080
py -m sc2tools_agent
```

By default the GUI launches. Pass `--no-gui` to suppress the window
when you are iterating on backend code; the tray + console UIs come
up exactly like 0.2.x:

```bash
py -m sc2tools_agent --no-gui
```

The agent stores its pairing token + preferences under
`%LOCALAPPDATA%\sc2tools\agent.json` (Windows) or
`~/.local/share/sc2tools/agent.json` (POSIX).

### CLI flags

| Flag | What it does |
| ---- | ------------ |
| `--no-gui` | Disable the PySide6 main window. Tray + console only. |
| `--start-minimized` | Hide the GUI on launch - only the tray icon shows. The autostart entry uses this. |
| `--version` | Print version and exit. |

## Architecture

```
runner.py
  +-- config.py          load env (+ state-stored overrides), pick state dir
  +-- state.py           atomic write of agent.json (paused, folder, GUI prefs)
  +-- autostart.py       HKCU\...\Run toggle for "run on Windows login"
  +-- api_client.py      bearer-token HTTP + retries
  +-- pairing/flow.py    /start -> poll -> token persisted
  +-- replay_finder.py   probe Documents+OneDrive for SC2 dirs
  +-- replay_pipeline.py import existing parser, build CloudGame
  +-- watcher.py         watchdog FS events + periodic sweep + override
  +-- uploader/queue.py  bounded queue, dedupe, pause, resync
  +-- updater.py         poll /v1/agent/version, verify SHA-256, install
  +-- crash_reporter.py  Sentry SDK with PII redaction
  +-- ui/
        +-- gui.py       PySide6 main window  (production UX)
        +-- tray.py      pystray indicator    (always alongside the GUI)
        +-- console.py   stdout fallback      (headless / CI)
```

The runner brings up all three UI sinks and broadcasts each event
(pairing code, status change, upload success/failure) through a
multiplexer, so they are always in sync. PySide6 imports are guarded:
on a source install without `pip install -r requirements.txt`, the
agent falls back gracefully to tray+console.

## Main window - what is where

| Tab | Contents |
| --- | -------- |
| Dashboard | Status badge (Active / Paused / Pairing / Error), pairing code card (only visible until paired), Synced / Queued / Last-upload stats, action buttons (Pause, Re-sync, Choose folder, Check for updates, Open dashboard). |
| Recent uploads | Last ~100 replays the agent has handled, with timestamps and per-row status. Double-click reveals the replay in Explorer. |
| Activity log | Live tail of `%LOCALAPPDATA%\sc2tools\logs\agent.log` with a level filter (All / INFO+ / WARNING+ / ERROR only) and an Open Log Folder button. |
| Settings | API base URL, log level, replay folder override, auto-start on Windows login, start-minimised checkbox. Edits persist atomically; most apply on next start. |

Closing the window minimises it to the tray (the agent keeps running).
**Quit** lives on the tray menu - that fully exits the process.

## Tray menu (right-click the indicator)

| Item | What it does |
| ---- | ------------ |
| Status / last upload / watching | Three-line tooltip - read-only |
| Open dashboard | Launches your browser at the SPA |
| Pause syncing / Resume syncing | Persists across restarts; queue keeps draining but holds jobs |
| Open log folder | Opens `%LOCALAPPDATA%\sc2tools\logs` in Explorer |
| Re-sync from scratch | Clears the dedupe cursor + re-uploads every replay |
| Choose replay folder | Native folder picker; override persists in `state.replay_folder_override` |
| Check for updates / Install update X.Y.Z | Polls the cloud release feed; on a fresh release, downloads + verifies + launches the installer |
| Quit | Stops the agent |

## Tests

```bash
py -m pytest
```

Unit tests cover state round-trips (including the new GUI-pref fields),
config env handling, the API client retry/auth behaviour, the updater
(download + SHA-256 verify against a local stub HTTP server), the
crash reporter PII redaction, the upload queue pause / resync
behaviour, the autostart registry helpers (with a fake `winreg`),
and the GUI module import-without-PySide6 contract. Integration
tests against a live API are out of scope here - see
`apps/api/__tests__/` for that.

## Production packaging

```powershell
cd apps\agent
pwsh packaging\build-installer.ps1 -Version 0.3.0 -Installer
```

Outputs `dist\SC2ToolsAgent-Setup-0.3.0.exe` (signed when
`-SigningCert` is supplied). The installer drops a Start Menu
shortcut, a desktop shortcut, and a per-user startup-folder shortcut
(launched with `--start-minimized` so logging in does not pop a
window). See [packaging/README.md](packaging/README.md) for the full
build pipeline including code signing and the release-feed publish
step.
