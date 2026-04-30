# ADR 0014 -- Windows installer: NSIS + bundled embeddable Python

Status: Accepted
Date: 2026-04-30
Owner: packaging / release

## Context

A central goal for this stage is "Windows .exe installer that drops the
entire suite onto a fresh machine" with the explicit constraint that a
non-technical user double-clicks, hits Next, and lands at the Stage 2
wizard with zero shell or PATH knowledge required (Hard Rule #6).

The brief gave us a tool (NSIS) and an outline. The decisions below
filled in the gaps that the outline left open.

## Decisions

### 1. NSIS over MSI / Inno Setup / WiX

NSIS is the smallest battle-tested option (~200 KB self-extracting stub)
and uses an imperative scripting model that maps cleanly onto our needs:
copy a tree, run a few external commands, register an uninstaller. WiX
would be cleaner for transactional installs, but the toolchain (Heat /
Light / Candle, MSI tables, custom action DLLs) is dramatically heavier
than what we get out of returning the user to a wizard. Inno Setup is
fine but has no Linux-friendly compiler, which complicates the GitHub
Actions matrix if we ever want to dry-run from Linux.

### 2. Bundle embeddable Python 3.12 instead of detecting a system Python

The brief offered "detect Python 3.10+; if missing, prompt to install or
bundle it." We chose pure bundle for three reasons:

1. **Determinism.** A bundled Python.exe at a known path means we know
   exactly what `python` the launcher and the backend will run against.
   `pip install` outcomes are reproducible. Replay parsing ABI is
   stable. A user with a system Python 3.13 alpha or a corp-IT-frozen
   3.10.0 introduces a long tail of "works on my machine" bugs we don't
   need.
2. **Hard Rule #6 (UX without docs).** Asking a non-technical streamer
   to install Python from python.org, tick "Add to PATH", and re-run
   the installer is exactly the friction we are designing this stage
   to remove.
3. **Pre-baking pip install.** Because the bundled Python is fixed, we
   can run `pip install -r requirements.txt` once at build time inside
   `build\stage\python\`, which means the user installer never needs
   PyPI access. This works for offline corporate machines and is much
   faster on first launch.

The cost is ~25 MB extra installer size, which is a fine trade.

### 3. Detect (not bundle) Node.js

Node is detected on PATH at install time. If missing, the installer
opens https://nodejs.org and continues without aborting (the user can
finish the install offline; the streaming overlay backend will start
working once Node lands). We did not bundle Node because:

- Node is comparatively heavy (~30 MB embedded distribution), and the
  Stage 7 community-builds sync will eventually want a Node service
  that can be updated independently of the desktop launcher.
- Most streamers already have Node installed for OBS/Streamlabs plugin
  workflows.
- The desktop launcher (Stage 3 SC2ReplayAnalyzer.py) does not depend
  on Node; only the overlay/backend does, and that subsystem can lag
  the first install without breaking the Stage 2 wizard.

If field reports show Node detection friction, we can flip this to
"detect, then bundle if missing" without changing the on-disk layout.

### 4. Per-user install (LOCALAPPDATA), not Program Files

The brief said "%ProgramFiles%\SC2Tools\ (or user-chosen dir)". We
default to `%LOCALAPPDATA%\Programs\SC2Tools` instead. Reasons:

- No UAC / admin prompt -- non-technical users sometimes click the
  wrong button on UAC and abort the install.
- The wizard, settings page, and custom-builds cache write under
  `data\` continuously; a Program Files install would force every
  write through admin elevation or break.
- This matches what modern Windows apps (Discord, VS Code user
  installer, GitHub Desktop) do.

The user can still pick `C:\SC2Tools` or a Program Files path on the
Directory page if they prefer. The uninstaller registers under HKCU
to match.

### 5. Pre-bake node_modules\, strip __pycache__

`build-installer.ps1` runs `npm ci` and `pip install` into the staging
tree at build time, then deletes every `__pycache__\` directory before
handing the tree to makensis. This makes the installer hash stable
across builds (ignoring NSIS's own embedded timestamps -- truly bit-
identical reproducibility would need `SOURCE_DATE_EPOCH` plumbing
through NSIS and is out of scope for this ADR).

### 6. Pin everything (== for pip, exact for npm, choco/action versions)

Every dependency that ships in the installer is pinned to an exact
version. `requirements.txt` uses `==`; `package.json` mirrors the
resolved versions from `package-lock.json`. NSIS itself is pinned to
3.10 in the GitHub Actions workflow. Without this the installer is a
moving target.

## Consequences

- The installer ships at roughly 60-70 MB. Acceptable for a one-time
  download; if it grows past 150 MB we should revisit Node bundling.
- A Python upgrade requires bumping `PythonVersion` in
  `build-installer.ps1` AND adding the new SHA256 to
  `PYTHON_SHA256_BY_VERSION`. The build aborts if the user passes a
  version we have not pinned.
- An installer rollback requires uploading an older release artifact;
  there is no in-place "downgrade" path. Users who need rollback can
  uninstall and run the previous .exe.

## Rollback plan

If a release breaks installs in the field:

1. Mark the GitHub release as a draft so the public download link
   disappears.
2. Push a new tag with the previous good version + a `-hotfix.N`
   suffix and re-run `release.yml`.
3. Open a follow-up issue against `packaging/` with the failing log
   from `%TEMP%\sc2tools-setup.log`.

## See also

- `packaging/installer.nsi`
- `packaging/build-installer.ps1`
- `.github/workflows/release.yml`
- Hard Rule #6, MASTER_ROADMAP.md
