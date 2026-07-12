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
pwsh packaging/build-installer.ps1 -Installer
```

The version defaults to the canonical `sc2tools_agent.__version__` and
the output is `dist/SC2ToolsAgent-Setup-<version>.exe`.

## Signed release build

```powershell
$env:SC2TOOLS_SIGNING_PASSWORD = '<your pfx password>'
pwsh packaging/build-installer.ps1 `
    -Clean `
    -Installer `
    -SigningCert C:\codesign\sc2tools.pfx
```

The script signs the final NSIS setup `.exe` with a SHA-256 timestamp
from `http://timestamp.sectigo.com`.

## Publishing a release

The canonical version in `sc2tools_agent/__init__.py` and the newest
section in `apps/agent/CHANGELOG.md` must match. After that commit is
merged, tag that exact commit and push the single agent tag:

```powershell
$version = "0.14.0" # must match sc2tools_agent.__version__
git tag "agent-v$version"
git push origin "agent-v$version"
```

The `agent installer` GitHub Actions workflow verifies the tag against
the package version, builds the installer, creates its `.sha256`
sidecar, and attaches both files to a public GitHub Release. The website
download card and the installed agent's `/v1/agent/version` feed both
resolve that release automatically; no separate CDN upload or manual
release-feed POST is required.

## Layout

| File | Purpose |
| ---- | ------- |
| `sc2tools_agent.spec` | PyInstaller spec (one-file by default). Bundles the agent + `apps/replay-engine/` so sc2reader-based parsing works without a separate Python install. |
| `installer.nsi` | NSIS script — installs to `%LOCALAPPDATA%\sc2tools`, registers a Startup-folder shortcut, writes an Add/Remove Programs entry. |
| `build-installer.ps1` | End-to-end pipeline. Use this from CI; never run pyinstaller / makensis by hand for releases. |
| `icon.ico` *(optional)* | 256×256 .ico for the .exe + installer. PyInstaller and NSIS both pick it up automatically when present. |

## Why no auto-update of the venv?

The agent's `updater.py` always replaces the whole `.exe` because
PyInstaller bundles Python itself plus every wheel inside the binary.
There's nothing to "patch" — replace the file, restart the process.
