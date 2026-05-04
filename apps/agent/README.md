# @sc2tools/agent — local replay daemon

Tiny Python program that runs on the user's PC, watches the SC2
Replays folder, parses each new replay, and uploads the resulting
JSON record to the cloud API. Tray icon. No GUI install pain.

## Quick start

```bash
cd apps/agent
py -m pip install -r requirements.txt
copy .env.example .env
# Edit .env → SC2TOOLS_API_BASE=https://api.sc2tools.app
py -m sc2tools_agent
```

On first run the agent prints a 6-digit pairing code. Open
[`/devices`](https://sc2tools.app/devices) on the website, paste the
code, and the agent stores its long-lived token under
`%LOCALAPPDATA%\sc2tools\agent.json`.

## Architecture

```
runner.py                ┐
  ├── config.py          │   load env, pick state dir
  ├── state.py           │   atomic write of agent.json (paused, override folder)
  ├── api_client.py      │   bearer-token HTTP + retries
  ├── pairing/flow.py    │   /start → poll → token persisted
  ├── replay_finder.py   │   probe Documents+OneDrive for SC2 dirs
  ├── replay_pipeline.py │   import existing parser, build CloudGame
  ├── watcher.py         │   watchdog FS events + periodic sweep + override
  ├── uploader/queue.py  │   bounded queue, dedupe, pause, resync
  ├── updater.py         │   poll /v1/agent/version, verify SHA-256, install
  ├── crash_reporter.py  │   Sentry SDK with PII redaction
  └── ui/                │   tray (pystray) + console fallback
```

## Tray menu (right-click the indicator)

| Item | What it does |
| ---- | ------------ |
| Status / last upload / watching | Three-line tooltip — read-only |
| Open dashboard | Launches your browser at the SPA |
| Pause syncing / Resume syncing | Persists across restarts; queue keeps draining but holds jobs |
| Open log folder | Opens `%LOCALAPPDATA%\sc2tools\logs` in Explorer |
| Re-sync from scratch | Clears the dedupe cursor + re-uploads every replay |
| Choose replay folder… | Native folder picker; override persists in `state.replay_folder_override` |
| Check for updates / Install update X.Y.Z | Polls the cloud release feed; on a fresh release, downloads + verifies + launches the installer |
| Quit | Stops the agent |

## Tests

```bash
py -m pytest
```

Unit tests cover state round-trips, config env handling, the API
client retry/auth behaviour, the updater (download + SHA-256 verify
against a local stub HTTP server), the crash reporter PII redaction,
and the upload queue's pause / resync behaviour. Integration tests
against a live API are out of scope here — see `apps/api/__tests__/`
for that.

## Production packaging

```powershell
cd apps\agent
pwsh packaging\build-installer.ps1 -Version 0.2.0 -Installer
```

Outputs `dist\SC2ToolsAgent-Setup-0.2.0.exe` (signed when
`-SigningCert` is supplied). See [packaging/README.md](packaging/README.md)
for the full build pipeline including code signing and the release-feed
publish step.
