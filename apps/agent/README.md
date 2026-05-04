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
  ├── state.py           │   atomic write of agent.json
  ├── api_client.py      │   bearer-token HTTP + retries
  ├── pairing/flow.py    │   /start → poll → token persisted
  ├── replay_finder.py   │   probe Documents+OneDrive for SC2 dirs
  ├── replay_pipeline.py │   import existing parser, build CloudGame
  ├── watcher.py         │   watchdog FS events + periodic sweep
  ├── uploader/queue.py  │   bounded queue, dedupe via state.uploaded
  └── ui/                │   tray (pystray) + console fallback
```

## Tests

```bash
py -m pytest
```

Unit tests cover state round-trips, config env handling, and the API
client retry/auth behaviour. Integration tests against a live API are
out of scope here — see `apps/api/__tests__/` for that.

## Production packaging

```bash
pip install pyinstaller
pyinstaller --onefile --windowed --name sc2tools-agent \
    --add-data "icon.png;." \
    sc2tools_agent\__main__.py
```

The resulting `dist/sc2tools-agent.exe` is ~12 MB. For a stable
SmartScreen experience, sign with an EV code-signing cert.
