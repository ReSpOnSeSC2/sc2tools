# SC2 Tools

A suite of advanced StarCraft II tools for serious ladder players: deep replay analysis, real-time opponent intelligence, and a complete browser-source overlay system for streamers. Two complementary applications shipped together — one for understanding your past games, one for winning your next one.

---

## Overview

SC2 Tools bundles two applications:

**SC2Replay-Analyzer** — Statistical and machine-learning–driven replay analysis. Macro scoring, spatial engagement clustering, opponent profiling, and a trained win-probability model that estimates win likelihood at any timestamp in the game.

**Reveal SC2 Opponent** — Real-time opponent intelligence powered by SC2Pulse, with a Tkinter dashboard, automatic replay watcher, MMR scanner, strategy detector, and a full streamer overlay system with sixteen-plus ready-made HTML widgets for OBS.

Both ship as a single Windows installer with a guided first-run wizard, a browser-based analyzer SPA, automatic background updates, and a community-shared custom-build database.

---

## Features

### Replay analysis
- Frame-accurate event extraction from `.SC2Replay` files (game events, tracker events, attribute events, message events).
- Macro score that quantifies economic and production efficiency against optimal benchmarks.
- Spatial analytics — engagement-zone clustering, army-movement heatmaps, map-aware feature extraction.
- Trained win-probability classifier (`wp_model.pkl`) callable from CLI or GUI.
- Persistent SQLite metadata layer with migrations for tracking thousands of replays over time.
- Long-running opponent profiler that builds behavioral fingerprints across every game you have played against a given player.
- Browser-based analyzer SPA at `/analyzer` with dashboards, build-order timelines, opponent-profile drill-downs, and chrono / macro charts rendered inline (no external chart dependency).
- PyQt desktop GUI for offline analysis.

### Live opponent intelligence
- Continuous MMR scanner backed by the SC2Pulse API.
- Auto-watcher that detects new replays the moment Blizzard writes them and triggers analysis.
- Strategy detector recognizing signature builds and cheese patterns (cannon rush, proxy barracks, twelve-pool, dark-templar all-ins, etc.).
- Editable custom-build library in JSON — define your own patterns and the detector picks them up.
- **Community-shared build database** — when one player adds a custom build, every player on the next sync sees it. The local copy is a cache; the server is canonical.
- Build-order classifier driven by `data/build_definitions.json`.
- Tkinter dashboard for at-a-glance opponent context before queue pop.

### Streamer overlays
Sixteen-plus browser-source widgets (`SC2-Overlay/widgets/`) drop straight into OBS, Streamlabs, or any browser-source-capable broadcasting tool. Communicate with the bundled Node.js websocket backend for live updates between games.

| Widget | Purpose |
|---|---|
| `opponent.html` | Opponent profile card with race, MMR, recent record |
| `mmr-delta.html` | Live MMR change indicator |
| `streak.html` | Current win/loss streak |
| `session.html` | Session-aggregate stats |
| `rank.html` | League and tier display |
| `cheese.html` | Cheese alert banner |
| `topbuilds.html` | Most-used builds against this opponent |
| `meta.html` | Race-vs-race meta context |
| `match-result.html` | Post-game result card |
| `post-game.html` | Detailed post-game summary |
| `rematch.html` | Rematch indicator |
| `rival.html` | Recurring-opponent rival flag |
| `scouting.html` | Scouting intel feed |
| `fav-opening.html` | Opponent's favorite opening |
| `best-answer.html` | Suggested counter-build |
| `mmr-delta.html` | Live MMR delta tracker |

### First-run wizard

The first time you launch SC2 Tools, a multi-step wizard fills in `data/config.json` for you: detects your StarCraft II install, locates your replay folder, looks up your SC2Pulse character ID, asks for your race preference, and offers to import existing build definitions. No JSON editing required.

### Settings, diagnostics, and backups

The analyzer SPA includes a full Settings page with sub-tabs for Profile, Folders, Overlay, Builds, Integrations, About, and more. A Diagnostics page surfaces health checks, recent error counts, the loaded sc2reader version, and a one-click "Bundle logs" button for support tickets. Backups under Settings → Backups snapshot `data/` to a timestamped zip and let you restore from any snapshot in one click.

### Auto-updates

When a newer release lands on GitHub, a banner appears at the top of every page in the analyzer:

> Version 1.0.1 is available — view release notes | Update now ✕

Clicking "Update now" downloads the new installer, verifies its SHA256 against the published value, runs it silently, and relaunches the app. There is also a manual "Check for updates" button under Settings → About. The banner only appears when GitHub has a release with a strictly higher version than the installed one, and dismissing it keeps it dismissed for the session. See `docs/adr/0015-auto-update-architecture.md` for the security model behind the update endpoint.

---

## Repository structure

```
sc2tools/
├── SC2Replay-Analyzer/              Deep replay analysis suite
│   ├── analytics/                   Statistical + ML modules
│   │   ├── clustering.py            Engagement-zone clustering
│   │   ├── feature_extractor.py     ML feature pipeline
│   │   ├── macro_score.py           Macro efficiency scoring
│   │   ├── opponent_profiler.py     Long-term opponent profiles
│   │   ├── spatial.py               Map-aware spatial analytics
│   │   └── win_probability.py       Trained classifier inference
│   ├── core/                        Replay loading + event extraction
│   ├── detectors/                   Pattern detectors
│   ├── db/                          SQLite persistence + migrations
│   ├── ui/                          PyQt GUI
│   ├── scripts/                     CLI entry points
│   ├── data/                        Map bounds + cached spatial data
│   ├── __init__.py                  Package metadata; reads __version__
│   ├── SC2ReplayAnalyzer.py         Stage 3 launcher (entry point)
│   ├── web_analyzer.py              Browser-based analyzer
│   └── requirements.txt             Pinned Python dependencies
│
├── reveal-sc2-opponent-main/        Live opponent intel + overlays
│   ├── core/                        Replay parser + build detection
│   ├── analytics/                   Opponent profiling + macro scoring
│   ├── gui/                         Tkinter analyzer dashboard
│   ├── watchers/                    Replay + MMR watchers
│   ├── scripts/                     Asset extraction utilities
│   ├── data/                        Build definitions + opponent history
│   ├── SC2-Overlay/                 OBS browser-source widgets
│   │   ├── widgets/                 Sixteen-plus widget HTML files
│   │   ├── icons/                   Race / league / unit / building icons
│   │   ├── app.js, styles.css       Shared overlay logic + theming
│   │   └── icon-registry.js         Icon-name lookup table
│   └── stream-overlay-backend/      Node.js Express + websocket server
│       ├── index.js                 Server entry point + route mounting
│       ├── analyzer.js              Live analysis bridge
│       ├── routes/                  Express route factories
│       │   ├── settings.js          /api/settings (Stage 2)
│       │   ├── onboarding.js        /api/onboarding (wizard backend)
│       │   ├── backups.js           /api/backups
│       │   ├── diagnostics.js       /api/diagnostics
│       │   ├── custom-builds.js     /api/custom-builds (cloud sync)
│       │   └── version.js           /api/version + /api/update/start
│       ├── public/analyzer/         The browser SPA (index.html + components/)
│       ├── package.json             Pinned Node dependencies (canonical version)
│       └── overlay.config.json      Server-side overlay defaults
│
├── packaging/                       Windows installer build pipeline
│   ├── installer.nsi                NSIS Modern UI 2 script
│   ├── build-installer.ps1          Stage + bundle Python + npm ci + makensis
│   ├── silent-update.ps1            Auto-update helper (Stage 12.1)
│   └── installer-assets/icon.ico
│
├── cloud/community-builds/          Server-side custom-build database
├── docs/adr/                        Architecture Decision Records
├── .github/workflows/               release.yml + version-check.yml
├── CHANGELOG.md                     Keep-a-Changelog format, semver tags
└── README.md                        This file
```

---

## Installation

### Windows installer (recommended for most users)

Download the latest `SC2Tools-Setup-<version>.exe` from the [Releases page](https://github.com/ReSpOnSeSC2/sc2tools/releases/latest), double-click, hit Next a few times. The installer:

- Installs to `%LOCALAPPDATA%\Programs\SC2Tools` by default (no admin prompt). You can pick a different folder on the Directory page.
- Bundles its own Python 3.12 interpreter, so nothing PATH-related can go wrong on the user side.
- Pre-installs every Python and Node.js dependency at build time, so the install itself does not need PyPI / npm registry access.
- Detects Node.js 18+ on PATH (required for the streaming overlay backend). If Node is missing the installer offers to open the official download page; the rest of the install completes either way.
- Drops a Start Menu entry and a Desktop shortcut pointing at the launcher.
- Registers a clean uninstaller under Add/Remove Programs.

The installer SHA256 is published alongside the `.exe` on the Releases page so you can verify the download:

```powershell
Get-FileHash .\SC2Tools-Setup-1.0.0.exe -Algorithm SHA256
# Compare against the .sha256 sidecar on GitHub Releases.
```

### Manual install (developers, contributors, non-Windows)

For development on the codebase, or to run on macOS / Linux where the Windows installer does not apply:

#### Prerequisites
- Windows 10 / 11, macOS, or Linux (the launchers and PowerShell scripts are Windows-specific; the Python and Node code is otherwise platform-independent)
- Python 3.10 or newer (Python 3.12 recommended; CI tests against 3.12)
- Node.js 18 or newer
- PowerShell 5.1 or newer (Windows-only paths)
- A Battle.net account with at least one ranked SC2 ladder game on record (for SC2Pulse lookups)

#### Setup

```powershell
git clone https://github.com/ReSpOnSeSC2/sc2tools.git
cd sc2tools

# SC2Replay-Analyzer
cd SC2Replay-Analyzer
pip install -r requirements.txt
cd ..

# Reveal SC2 Opponent
cd reveal-sc2-opponent-main
pip install -r requirements.txt

# Stream overlay backend
cd stream-overlay-backend
npm ci
cd ..\..
```

`npm ci` is preferred over `npm install` because the repository commits an exact `package-lock.json`. All Python and Node dependencies are pinned to specific versions; the CI matrix verifies this on every PR.

### Building the installer locally

If you want to produce a `SC2Tools-Setup-<version>.exe` from a clean checkout (for example, to test a release candidate before tagging):

```powershell
choco install nsis -y                    # one-time, if you do not have NSIS
.\packaging\build-installer.ps1 -Test
```

Output lands at `dist\SC2Tools-Setup-<version>.exe` plus a matching `.sha256`. The `-Test` flag runs a silent install + uninstall smoke test before the script returns. See `docs/adr/0014-installer-nsis-bundled-python.md` for the design rationale (NSIS over WiX, bundled Python over detect-and-prompt, per-user install over Program Files).

### First run

On first launch — whether from the installer's Desktop shortcut or `python SC2Replay-Analyzer\SC2ReplayAnalyzer.py` — the app runs a multi-step setup wizard that:

1. Detects your StarCraft II install and locates your replay folder.
2. Asks for your SC2Pulse character ID (or looks it up from your Battle.net handle).
3. Records your race preference for race-specific UI accents.
4. Offers to import existing build definitions.
5. Writes everything to `data/config.json` and `data/profile.json`.

You can re-run the wizard at any time from Settings → Profile → "Re-run wizard".

---

## Usage

### One-click launcher

The installer's Desktop shortcut runs `SC2Replay-Analyzer\SC2ReplayAnalyzer.py` via the bundled `pythonw.exe`. From a manual install:

```powershell
.\reveal-sc2-opponent-main\START_SC2_TOOLS.bat
```

Brings up the GUI, MMR scanner, replay watcher, and overlay backend together.

### Browser-based analyzer (SPA)

Once the stream-overlay-backend is running, open the analyzer in any browser:

```
http://localhost:5050/analyzer
```

(The exact port comes from `overlay.config.json` — `5050` is the default.) Tabs include Dashboard, Builds, Strategies, Settings, and Diagnostics. The Update banner sits at the top of every tab.

### SC2Replay-Analyzer

Desktop GUI:
```powershell
cd SC2Replay-Analyzer
python SC2ReplayAnalyzer.py
```

Web interface:
```powershell
python web_analyzer.py
```

CLI utilities:
```powershell
python scripts/macro_cli.py      --replay "path\to\replay.SC2Replay"
python scripts/buildorder_cli.py --replay "path\to\replay.SC2Replay"
python scripts/spatial_cli.py    --replay "path\to\replay.SC2Replay"
python scripts/ml_cli.py         --replay "path\to\replay.SC2Replay"
```

### Reveal SC2 Opponent

Standard launcher:
```powershell
cd reveal-sc2-opponent-main
.\reveal-sc2-opponent.bat
```

GUI only:
```powershell
python gui\run_gui.py
```

PowerShell mode (no GUI):
```powershell
.\Reveal-Sc2Opponent.ps1
```

Stream overlay backend (for OBS browser sources):
```powershell
cd stream-overlay-backend
node index.js
```
Then add OBS browser sources pointing at the widget URLs printed by the server (for example, `http://localhost:5050/overlay/widgets/opponent.html`).

---

## Configuration

Most users never edit JSON by hand: the wizard handles `config.json` on first run, and Settings → Profile / Folders / Overlay / Builds covers the day-to-day knobs. For reference, the data files live under `data/`:

- **`data/config.json`** — schema-validated runtime config. Edit via Settings, not by hand. The wizard creates this on first launch.
- **`data/profile.json`** — your personal profile (character ID, races, display names).
- **`data/build_definitions.json`** — built-in build patterns that ship with the codebase. Tracked in git.
- **`data/custom_builds.json`** — your local custom-build cache. The community-shared database is canonical (see Stage 7 in the roadmap); this file is a local mirror that updates on next sync.
- **`data/meta_database.json`** — your replay history index. Populated as you play. Not tracked in git.
- **`data/MyOpponentHistory.json`** — opponent W-L history. Populated as you play. Not tracked in git.
- **`stream-overlay-backend/overlay.config.json`** — server-side overlay defaults (websocket port, widget refresh rate, theming).

---

## Notes on data files

The repository deliberately does not include the following — they are generated, regenerable, or personal:

- `meta_database.json` and its `.backup-*` / `.broken-*` / `.pre-*` snapshots — built up over time as you play.
- `wp_model.pkl` — the trained win-probability model. A pretrained build will be released separately; in the meantime the analyzer falls back gracefully when the model is missing.
- `MyOpponentHistory.json`, `opponent.txt`, `character_ids.txt` — personal data populated as you play.
- `custom_builds.json` — your local mirror of the community-shared build database. Regenerated on next sync from the cloud canonical store.
- `analyzer.log` — runtime log file. Rotated automatically.

These are listed in `.gitignore`. Your local copies are untouched. The Windows installer also excludes them from its staging tree, so a fresh install never overwrites your replay history.

---

## Releases

Tags follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html): `vMAJOR.MINOR.PATCH`. Pushing a tag matching `v*.*.*` triggers `.github/workflows/release.yml` on a clean Windows GitHub Actions runner, which:

1. Builds the installer with `packaging/build-installer.ps1`.
2. Runs the silent-install smoke test.
3. Computes and publishes the `.sha256` sidecar.
4. Attaches both files to the GitHub Release for that tag.

The version string is canonical in `reveal-sc2-opponent-main/stream-overlay-backend/package.json`. `SC2Replay-Analyzer/__init__.py` reads the same file at import time, and `.github/workflows/version-check.yml` asserts both — plus the SPA's `SETTINGS_VERSION` literal — agree on every PR. See the changelog at [`CHANGELOG.md`](CHANGELOG.md) for per-release notes.

---

## Acknowledgements

This project stands on the shoulders of giants. The work below is what makes any of this possible:

### SC2Pulse and Nephest

Enormous thanks to **Nephest** and the **[SC2Pulse](https://www.nephest.com/sc2/)** project. SC2Pulse is the foundation of our live MMR tracking, ladder lookups, opponent resolution, and historical match data. Without Nephest's painstakingly maintained API and the years of work keeping the SC2Pulse ladder dataset clean, current, and freely accessible, the entire real-time opponent-intelligence layer of this project would not exist.

Nephest has built and operated SC2Pulse as a community service — open, reliable, and free — and that kind of contribution is what makes community projects like this one viable. If you use SC2 Tools and find it useful, please consider supporting SC2Pulse directly through the donation links on [nephest.com](https://www.nephest.com/sc2/).

### sc2reader and s2protocol

Replay parsing leans on the work of two foundational open-source projects: **[sc2reader](https://github.com/ggtracker/sc2reader)** and Blizzard's **[s2protocol](https://github.com/Blizzard/s2protocol)**. Decoding `.SC2Replay` files is genuinely hard — the format is a nested MPQ archive containing serialized event streams whose protocol definitions change with every SC2 patch since 2010. The maintainers of these libraries have been quietly absorbing all of that complexity for over a decade so the rest of us can do interesting things with replay data. Massive respect.

### Icons and game assets

- League, race, unit, building, and upgrade iconography is sourced from community-maintained sets. See `reveal-sc2-opponent-main/SC2-Overlay/icons/CREDITS.md` and `MANIFEST.md` for full per-icon attribution, plus `LICENSE-burnysc2.txt` and `LICENSE-sc2-icons.txt` for the originating licenses.

### Open-source dependencies

A long list of Python and JavaScript packages — see the respective `requirements.txt` and `package.json` files. Special mention to the maintainers of NumPy, scikit-learn, pandas, PyQt, and Tkinter on the Python side, and Express plus the websocket ecosystem on the Node side.

### Packaging

The Windows installer is built with **[NSIS](https://nsis.sourceforge.io/)** (Nullsoft Scriptable Install System) and bundles the official **[python.org embeddable distribution](https://www.python.org/downloads/windows/)**. Both are freely redistributable; SHA256 verification is enforced at build time to keep supply-chain risk low.

---

## Roadmap

A working development roadmap lives at `MASTER_ROADMAP.md`. High-level direction (most of the install / update / wizard plumbing has shipped; remaining items are below):

- Cross-replay trend analysis and regression
- Improved cheese-detection precision
- Mobile-friendly overlay theme
- Optional Twitch chat integration for the overlay
- Pretrained win-probability model release
- macOS and Linux support for the launchers (manual install path works today)
- Authenticode-signed installer (the SHA256 channel works today; signing adds a second layer)

Issues and feature requests welcome.

---

## Contributing

Pull requests are welcome. Please:

1. Open an issue first for substantial changes so we can align on direction.
2. Test against actual `.SC2Replay` files before submitting — replays in the wild have edge cases that synthetic tests miss.
3. Do not commit large binaries, trained models, replays, or personal data. The repository's `.gitignore` is already configured to keep these out; please respect it.
4. Match the code style of the surrounding files. The engineering standards (file size caps, function complexity, line length, dependency pinning) are documented in `MASTER_ROADMAP.md` and enforced by CI.
5. When bumping the version, edit `stream-overlay-backend/package.json` only — `SC2Replay-Analyzer/__init__.py` reads from there at runtime, and the SPA's `SETTINGS_VERSION` literal is verified against it by `.github/workflows/version-check.yml` on every PR.

---

## License

See `reveal-sc2-opponent-main/LICENSE.txt` for the project license. Individual icon and asset packs retain their original licenses; see the corresponding `LICENSE-*.txt` files in `reveal-sc2-opponent-main/SC2-Overlay/icons/`.

---

## Disclaimer

StarCraft and StarCraft II are trademarks of Blizzard Entertainment, Inc. This project is not affiliated with, endorsed by, or sponsored by Blizzard Entertainment. All game assets, unit names, building names, and trademarks are the property of their respective owners. SC2 Tools is an independent community project provided as-is, with no warranty.

---

## Contact

GitHub: [@ReSpOnSeSC2](https://github.com/ReSpOnSeSC2)

Built by an SC2 player, for SC2 players. GLHF.
