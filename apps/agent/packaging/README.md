# SC2 Tools Agent — packaging

This folder builds the Windows installer for the agent.

## Prerequisites

- Python 3.12 (`py -3.12 -V` on Windows)
- NSIS 3.x (https://nsis.sourceforge.io/) on PATH
- *(optional)* Windows SDK (signtool.exe) for code signing
- For local signing: a publicly trusted code-signing certificate (.pfx) and its
  password. Unsigned builds have no verified publisher; no reputation timing
  or SmartScreen bypass is promised. Tagged release signing uses the
  owner-approved SignPath Foundation integration below.

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

The script signs the inner agent executable before NSIS, then the final setup,
with SHA-256/RFC3161 timestamps. `verify-signature.ps1` rejects an invalid,
untrusted, missing or untimestamped signature. No certificate is supplied by
this preparation PR, so local builds without `-SigningCert` remain unsigned.

## Owner setup: SignPath Foundation

This prepares the workflow; it does not apply for a certificate, create an
account, add secrets, request a signature, or publish a release. The owner must
obtain approval for the OSS project/certificate and configure the GitHub-hosted
workflow and both PE artifact configurations with SignPath Foundation.
See the [official GitHub integration](https://docs.signpath.io/trusted-build-systems/github).

Configure repository secret `SIGNPATH_API_TOKEN` and repository variables:

| Variable | Value supplied by the approved SignPath project |
| --- | --- |
| `SIGNPATH_ENABLED` | `true` only after the approved configuration is ready |
| `SIGNPATH_ORGANIZATION_ID` | Organization ID |
| `SIGNPATH_PROJECT_SLUG` | Repository project slug |
| `SIGNPATH_POLICY_SLUG` | Approved production signing policy |
| `SIGNPATH_AGENT_CONFIG` | Artifact configuration signing root `sc2tools-agent.exe` |
| `SIGNPATH_INSTALLER_CONFIG` | Artifact configuration signing root `SC2ToolsAgent-Setup-*.exe` |

The pinned official action validates GitHub artifact provenance. CI builds the
bundle, uploads/signs/verifies the inner executable, packages that same bundle
with `-Installer -PackageOnly`, then uploads/signs/verifies setup. SHA-256 and
release upload occur **after** setup signing. `-PackageOnly` never rebuilds the
signed executable and rejects `-Clean` or omission of `-Installer`.

Tagged builds fail before packaging if approved signing is not enabled or
credentials/configuration are missing. A manual workflow run may build an
explicitly unsigned verification artifact while signing is disabled. Do not
publish it as signed. Owner approval and a first real signed workflow run remain
external release requirements. Manual/provider approval may be required by the
configured policy; CI waits up to the action's configured timeout.

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
sidecar, and attaches both files to a **draft** GitHub Release. After integrated
checks, signature verification, and owner publication, the website download card
and installed agent's `/v1/agent/version` feed resolve that stable release; no separate CDN upload or manual
release-feed POST is required.

## Layout

| File | Purpose |
| ---- | ------- |
| `sc2tools_agent.spec` | PyInstaller spec (one-folder by default). Bundles the agent + `apps/replay-engine/` so sc2reader-based parsing works without a separate Python install. |
| `installer.nsi` | NSIS script — installs to `%LOCALAPPDATA%\sc2tools`, shares the per-user Run startup switch, offers shortcut options and opt-in local-data removal, and writes an Add/Remove Programs entry. |
| `build-installer.ps1` | End-to-end pipeline. Use this from CI; never run pyinstaller / makensis by hand for releases. |
| `icon.ico` *(optional)* | 256×256 .ico for the .exe + installer. PyInstaller and NSIS both pick it up automatically when present. |

## Why no auto-update of the venv?

The agent's `updater.py` always replaces the whole `.exe` because
PyInstaller bundles Python itself plus every wheel inside the binary.
There's nothing to "patch" — replace the file, restart the process.

## Startup and uninstall behavior

A first install defaults Windows startup and the desktop shortcut on. Interactive
options can change both. Upgrades, including silent `/S`, preserve the existing
choices. The only active startup mechanism after migration is HKCU Run
`SC2ToolsAgent = '"$INSTDIR\sc2tools-agent.exe" --start-minimized'`. An owned
legacy Startup shortcut migrates after the Run command is written, then is deleted.

Uninstall removes the Run entry and app shortcuts. Its optional, initially
unchecked local-data checkbox deletes only named app files/directories under
`%LOCALAPPDATA%\sc2tools`: agent.json, player_handle.json, logs, data, streaming,
and replay-observations. It never follows replay-folder overrides or recursively
removes the install root. Silent uninstall keeps local data. Custom developer
state directories are managed separately.
