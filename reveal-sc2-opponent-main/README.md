# SC2 Replay Analyzer & Stream Overlay

> **[⬇ Download Latest Release](https://github.com/jay1988stud/reveal-sc2-opponent/releases/latest)**

A full StarCraft II toolkit for Windows: live opponent intelligence, stream overlays, replay analysis, and an AI voice readout that briefs you on your opponent before the game starts — all free, all local.

---

## Features

### 🎙️ Scouting Voice Readout *(new)*
At the start of every ranked game, a voice reads out everything known about your opponent:

> *"Facing LetaleX, Zerg. You're 3 and 1 against them — 75 percent win rate. They are your nemesis. Cheese warning — they got you at 4 minutes. Your best answer is Ling Bane Muta — 80 percent win rate. Good luck."*

- Powered by the **Web Speech API** — completely free, no API key required
- Only speaks data that actually exists — never reads "unknown" filler
- Detects rival and nemesis status automatically from your game history
- Flags cheese history and suggests your historically best counter-build
- Adjust volume, speed, pitch, delay, and voice at **http://localhost:3000/voice-settings.html**

### 🕵️ Pre-Game Opponent Intelligence
Live overlay widgets that fire the moment a game loads:
- Opponent name, race, and MMR
- Your head-to-head record and win rate
- Last N games with build orders on both sides
- Opponent's most-used opening and your best historical counter
- Cheese warning if they've rushed you under 5 minutes before
- Rival / nemesis badge (auto-assigned by game count)

### 📊 Replay Analysis
- Full build-order detection for Terran, Zerg, and Protoss
- Win predictor by matchup and build
- Map-specific performance breakdown
- Macro score tracking (chrono, inject, mule, supply)
- Post-game strategy reveal with animated build timeline

### 📺 Stream Overlay Widgets (OBS Browser Sources)
All widgets live in `SC2-Overlay/widgets/` and are loaded as OBS browser sources at `localhost:3000`:

| Widget | What it shows |
|--------|--------------|
| `scouting.html` | Pre-game opponent card + voice readout |
| `opponent.html` | Name, race, MMR, H2H record |
| `cheese.html` | Cheese warning pop-up |
| `rival.html` | Rival / nemesis alert |
| `session.html` | Session W/L, MMR, streak |
| `post-game.html` | Post-game strategy reveal |
| `best-answer.html` | Your best counter-build |
| `fav-opening.html` | Opponent's most-used build |
| `meta.html` | Meta frequency check |
| `mmr-delta.html` | MMR gained/lost |
| `rank.html` | Rank up / rank down |
| `streak.html` | Win/loss streak splash |
| `topbuilds.html` | Your top builds by win rate |

### 🗺️ Roadmap
See [`roadmapfeaturesup.md`](roadmapfeaturesup.md) for the full feature roadmap — 10 planned improvements that push the app well beyond sc2replaystats.com.

---

## Requirements

- Windows 10 or later
- Python 3.10+
- Node.js 18+
- StarCraft II installed (ranked 1v1 only)

---

## Setup

### 1. Install dependencies
```bat
cd stream-overlay-backend
npm install
cd ..
pip install -r requirements.txt
```

### 2. Configure your character IDs
Find your SC2Pulse character ID at https://sc2pulse.nephest.com/sc2/#search

Add it to `character_ids.txt` or run the setup wizard:
```bat
python check_setup.py
```

### 3. Launch everything
```bat
START_SC2_TOOLS.bat
```

This starts 4 components in sequence:
1. **SC2 Tools Launcher** — Express backend + opens the Web Analyzer at `http://localhost:3000/analyzer/`
2. **Replay Watcher** — Live replay parsing, writes opponent history and meta database
3. **API Poller** — Polls SC2 client API for live opponent detection
4. **Voice Settings** — Opens `http://localhost:3000/voice-settings.html` in your browser

### 4. Add OBS browser sources
In OBS, add a **Browser Source** for each widget you want. Point it at the widget URL, e.g.:
```
http://localhost:3000/widgets/scouting.html
```
Recommended size: 400×300 for most widgets. The scouting card works best at 500×350.

---

## Voice Settings

Open **http://localhost:3000/voice-settings.html** while the backend is running.

| Setting | Description |
|---------|-------------|
| Enable toggle | Turns the voice on/off without touching anything else |
| Volume | 0–100% |
| Speed | 0.85× = deliberate, 1.0 = normal, 1.2 = fast |
| Pitch | Lower = deeper, 1.0 = neutral |
| Delay | How long after the scouting card appears before speaking |
| Voice | Any voice installed on your Windows machine |
| Test button | Plays a sample readout immediately |

Settings are saved to `data/config.json` and take effect on the next game.

---

## How Opponent Detection Works

The toolkit uses two data sources:
- **SC2 Client API** (`localhost:6119/game`) — Blizzard's official streamer API. Detects opponent in real time.
- **SC2 Pulse** (`sc2pulse.nephest.com`) — Community-maintained player database. Resolves BattleTags, MMR, and race.

Replay files are parsed by `sc2reader` to extract build orders, game lengths, and macro stats. Everything is stored locally in `data/`.

---

## Security / ToS

This toolkit only calls official Blizzard and SC2 Pulse API endpoints. No memory reading, packet sniffing, render hooks, or datamining. The SC2 client API was added by Blizzard explicitly for streamers.

SC2 Pulse follows Blizzard's ToS including the 30-day privacy policy. No private data is collected or transmitted. Use at your own risk — the license reflects that no guarantees can be made.

---

## Original Project

This toolkit is built on top of [reveal-sc2-opponent](https://github.com/sc2-pulse/sc2-pulse) by the SC2 Pulse team. The PowerShell opponent detection script (`Reveal-Sc2Opponent.ps1`) is their work.
