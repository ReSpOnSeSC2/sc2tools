# SC2 Tools Agent — packaging

This folder builds the Windows installer for the agent.

## Prerequisites

- Python 3.12 (`py -3.12 -V` on Windows)
- NSIS 3.x (https://nsis.sourceforge.io/) on PATH
- *(optional)* Windows SDK (signtool.exe) for code signing
- *(optional)* An EV code-signing certificate (.pfx) — without it
  SmartScreen will warn first-time users for ~30 days while the binary
  builds reputation.

## Quick build (unsigned)

```powershell
cd apps/agent
pwsh packaging/build-installer.ps1 -Version 0.2.0 -Installer
```

Outputs `dist/SC2ToolsAgent-Setup-0.2.0.exe`.

## Signed release build

```powershell
$env:SC2TOOLS_SIGNING_PASSWORD = '<your pfx password>'
pwsh packaging/build-installer.ps1 `
    -Clean `
    -Version 0.2.0 `
    -Installer `
    -SigningCert C:\codesign\sc2tools.pfx
```

The script signs both the inner `sc2tools-agent.exe` (by re-running
`signtool` after PyInstaller emits it) and the final NSIS setup .exe
with a SHA-256 timestamp from `http://timestamp.sectigo.com`.

## Publishing the release feed

After the signed installer is uploaded to a CDN, publish it to the
cloud's release feed so existing agents auto-update:

```bash
SHA=$(sha256sum SC2ToolsAgent-Setup-0.2.0.exe | cut -d' ' -f1)
curl -X POST https://api.sc2tools.app/v1/agent/releases \
  -H "x-admin-token: $AGENT_RELEASE_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d @- <<JSON
{
  "channel": "stable",
  "version": "0.2.0",
  "releaseNotes": "Pause syncing, log folder, re-sync, folder picker.",
  "artifacts": [
    {
      "platform": "windows",
      "downloadUrl": "https://downloads.sc2tools.app/SC2ToolsAgent-Setup-0.2.0.exe",
      "sha256": "$SHA",
      "sizeBytes": $(stat -c %s SC2ToolsAgent-Setup-0.2.0.exe)
    }
  ]
}
JSON
```

The agent's startup poll picks this up within minutes.

## Layout

| File | Purpose |
| ---- | ------- |
| `sc2tools_agent.spec` | PyInstaller spec (one-file by default). Bundles the agent + `SC2Replay-Analyzer/` so sc2reader-based parsing works without a separate Python install. |
| `installer.nsi` | NSIS script — installs to `%LOCALAPPDATA%\sc2tools`, registers a Startup-folder shortcut, writes an Add/Remove Programs entry. |
| `build-installer.ps1` | End-to-end pipeline. Use this from CI; never run pyinstaller / makensis by hand for releases. |
| `icon.ico` *(optional)* | 256×256 .ico for the .exe + installer. PyInstaller and NSIS both pick it up automatically when present. |

## Why no auto-update of the venv?

The agent's `updater.py` always replaces the whole `.exe` because
PyInstaller bundles Python itself plus every wheel inside the binary.
There's nothing to "patch" — replace the file, restart the process.
