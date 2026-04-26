# SC2 Tools

A suite of advanced StarCraft II tools for serious ladder players: deep replay analysis, real-time opponent intelligence, and a complete browser-source overlay system for streamers. Two complementary applications shipped together — one for understanding your past games, one for winning your next one.

---

## Overview

SC2 Tools bundles two applications:

**SC2Replay-Analyzer** — Statistical and machine-learning–driven replay analysis. Macro scoring, spatial engagement clustering, opponent profiling, and a trained win-probability model that estimates win likelihood at any timestamp in the game.

**Reveal SC2 Opponent** — Real-time opponent intelligence powered by SC2Pulse, with a Tkinter dashboard, automatic replay watcher, MMR scanner, strategy detector, and a full streamer overlay system with sixteen-plus ready-made HTML widgets for OBS.

---

## Features

### Replay analysis
- Frame-accurate event extraction from `.SC2Replay` files (game events, tracker events, attribute events, message events).
- Macro score that quantifies economic and production efficiency against optimal benchmarks.
- Spatial analytics — engagement-zone clustering, army-movement heatmaps, map-aware feature extraction.
- Trained win-probability classifier (`wp_model.pkl`) callable from CLI or GUI.
- Persistent SQLite metadata layer with migrations for tracking thousands of replays over time.
- Long-running opponent profiler that builds behavioral fingerprints across every game you've played against a given player.
- Web interface for browsing analytics in your browser.
- PyQt desktop GUI for offline analysis.

### Live opponent intelligence
- Continuous MMR scanner backed by the SC2Pulse API.
- Auto-watcher that detects new replays the moment Blizzard writes them and triggers analysis.
- Strategy detector recognizing signature builds and cheese patterns (cannon rush, proxy barracks, twelve-pool, dark-templar all-ins, etc.).
- Editable custom-build library in JSON — define your own patterns and the detector picks them up.
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
│   ├── SC2ReplayAnalyzer.py         GUI launcher
│   ├── web_analyzer.py              Browser-based analyzer
│   └── requirements.txt
│
└── reveal-sc2-opponent-main/        Live opponent intel + overlays
    ├── core/                        Replay parser + build detection
    │   ├── sc2_replay_parser.py     Replay decode pipeline
    │   ├── build_definitions.py     Build pattern registry
    │   ├── custom_builds.py         User-defined build loader
    │   ├── strategy_detector.py     Strategy + cheese detection
    │   └── data_store.py            Persistence layer
    ├── analytics/                   Opponent profiling + macro scoring
    ├── gui/                         Tkinter analyzer dashboard
    ├── watchers/                    Replay + MMR watchers
    ├── scripts/                     Asset extraction utilities
    ├── data/                        Build definitions + opponent history
    ├── SC2-Overlay/                 OBS browser-source widgets
    │   ├── widgets/                 Sixteen-plus widget HTML files
    │   ├── icons/                   Race / league / unit / building icons
    │   ├── app.js, styles.css       Shared overlay logic + theming
    │   └── icon-registry.js         Icon-name lookup table
    ├── stream-overlay-backend/      Node.js websocket server
    │   ├── index.js                 Server entry point
    │   ├── analyzer.js              Live analysis bridge
    │   ├── sc2_catalog.js           Game-data catalog
    │   └── overlay.config.json      Server config
    ├── Reveal-Sc2Opponent.ps1       PowerShell launcher
    ├── reveal-sc2-opponent.bat      Batch launcher
    └── START_SC2_TOOLS.bat          Top-level "everything on" script
```

---

## Installation

### Prerequisites

- Windows 10 or 11 (the launchers and PowerShell scripts assume Windows; the Python and Node code is otherwise platform-independent)
- Python 3.10 or newer
- Node.js 18 or newer (only required for the stream overlay backend)
- PowerShell 5.1 or newer
- A Battle.net account with at least one ranked SC2 ladder game on record (for SC2Pulse lookups)

### Setup

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

# Stream overlay backend (optional, only if streaming)
cd stream-overlay-backend
npm install
cd ..\..
```

---

## Usage

### One-click launcher

```powershell
.\reveal-sc2-opponent-main\START_SC2_TOOLS.bat
```

Brings up the GUI, MMR scanner, replay watcher, and overlay backend together.

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
python scripts/macro_cli.py   --replay "path\to\replay.SC2Replay"
python scripts/spatial_cli.py --replay "path\to\replay.SC2Replay"
python scripts/ml_cli.py      --replay "path\to\replay.SC2Replay"
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
Then add OBS browser sources pointing at the widget URLs printed by the server (for example, `http://localhost:8080/widgets/opponent.html`).

---

## Configuration

Each tool reads a local `config.json`. Important settings:

- **Replay folder** — Auto-detected from your StarCraft II install. Override here if you keep replays elsewhere.
- **SC2Pulse character ID** — Your Battle.net character ID. The MMR scanner and opponent lookups use this to resolve opponents on the ladder.
- **Custom builds** — Edit `data/custom_builds.json` to define your own build templates. The strategy detector picks them up automatically on the next launch.
- **Build definitions** — `data/build_definitions.json` is the master list of detectable build patterns. Edit with care.
- **Overlay config** — `stream-overlay-backend/overlay.config.json` controls websocket port, widget refresh rate, and theming defaults.

---

## Notes on data files

The repository deliberately does not include the following — they are generated, regenerable, or personal:

- `meta_database.json` and its backups — built up over time as you play.
- `wp_model.pkl` — the trained win-probability model. A pretrained build will be released separately; in the meantime the analyzer falls back gracefully when the model is missing.
- `MyOpponentHistory.json`, `opponent.txt`, `character_ids.txt` — personal data populated as you play.

These are listed in `.gitignore`. Your local copies are untouched.

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

---

## Roadmap

A working development roadmap lives at `SC2Replay-Analyzer/ROADMAP.md`. High-level direction:

- Cross-replay trend analysis and regression
- Improved cheese-detection precision
- Mobile-friendly overlay theme
- Optional Twitch chat integration for the overlay
- Pretrained win-probability model release
- macOS and Linux support for the launchers

Issues and feature requests welcome.

---

## Contributing

Pull requests are welcome. Please:

1. Open an issue first for substantial changes so we can align on direction.
2. Test against actual `.SC2Replay` files before submitting — replays in the wild have edge cases that synthetic tests miss.
3. Do not commit large binaries, trained models, replays, or personal data. The repository's `.gitignore` is already configured to keep these out; please respect it.
4. Match the code style of the surrounding files.

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
