# @sc2tools/agent - local replay daemon

Watches your SC2 Replays folder, parses each new replay, and uploads
the result to the SC2 Tools cloud API. Ships with a production
PySide6 GUI window for non-technical users, a system-tray indicator
for power users, and a console fallback for headless / CI runs.

## For end users - the easy path

1. Download `SC2ToolsAgent-Setup-X.Y.Z.exe` from the releases page.
2. Double-click the installer.
3. The agent launches and opens the **main window**. The
   pairing card says **Getting your code…**, then shows a large 6-digit
   code and its expiry countdown. Click **Link this PC in your browser**,
   sign in to SC2 Tools, and confirm the PC. The code is already filled in.
   Use **Copy code** for another browser or **Get a new code** to refresh it.
   If the internet is unavailable, leave the window open: it keeps trying.
   **Retry now**, **Open activity log**, and **Need help?** are there to help.
4. Done. The agent keeps running in the system tray. To open the
   window again, click the Start Menu shortcut **SC2 Tools Agent**
   or the desktop icon.

No command line. No `.env` editing. The Settings tab inside the
window covers API base URL, log level, replay folder override,
auto-start on Windows login, and "start minimised to tray".

For detailed map playback, enable **Settings → Map replay → Automatically
capture map replays**. The agent records new and re-synced games with
StarCraft II before uploading them, including movement, attacks, spells and
creep. This can use substantial CPU for several minutes per replay. For games
already synced, use **Re-sync** once; compatible saved recordings are reused.
Leave the setting off to sync standard analysis only. The website's
**Generate accurate playback** button can record one game on demand with
either setting, using agent 0.16.11 or newer.

**Streams** accepts statistic tokens such as `SC2 | {mmr} MMR | {record}` and
shows a live preview. Automatic updates start off: choose the connected
platforms, enable **Refresh titles after each synced game**, and save its
settings. Twitch/Kick are selected initially; YouTube is not. Updates wait for
the live replay to sync, skip unchanged titles and run at most every ten minutes
on their own worker. See [Stream titles](https://sc2tools.com/help/desktop-stream-titles).

If you unpair this PC on the website, the desktop window says **This PC was
unlinked from your account**. Click **Link again** and confirm the new code.
Your settings, queued replays, and sync history stay on the PC. Closing the
window keeps the app running in the tray; use **Quit** to stop it.

During an outage, the Dashboard shows the number of waiting replays and a
retry countdown. **Retry now** starts another attempt. Temporary connection
problems do not add error rows to Recent uploads. Permanent replay outcomes
show a plain-language message, technical details on hover, **Copy details**,
and a help link. Read [Pairing problems](https://sc2tools.com/help/pairing-troubleshooting)
or [Sync problems](https://sc2tools.com/help/desktop-app-sync-problems).

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
| Dashboard | Shared status card (Starting / Connecting / Link this PC / Unlinked / Watching / Syncing / Paused / Needs attention / Error), its cause and next action, pairing code and recovery; green pairing confirmation for four seconds, upload totals when linked, separate update card and release notes. Status matches the sidebar and tray dot. Pause, Re-sync, Add folder, Check for updates, and Open dashboard actions. |
| Recent uploads | Last ~100 replays the agent has handled, with timestamps and per-row status. Double-click reveals the replay in Explorer. |
| Activity log | Incremental tail of `%LOCALAPPDATA%\sc2tools\logs\agent.log`, with complete tracebacks, readable level filters, Ctrl+F search, follow/pause, copy selection or last 200 lines, and Open log folder. |
| Settings | Replay folders and sync date range, start-up, updates, capture, build check-in and OBS. Save confirms what applied; API address, log level and import speed name their restart requirement. The API field supports Reset to default and Test. |
| Streams | Shared stream title and YouTube description, connected channels, and verified or accepted per-platform save results. |

Closing the window hides it in the tray while syncing continues. A one-time reminder
explains where it went. Launching the shortcut again brings that same window forward.
Without a tray, Close offers Quit or Minimize and remembers the choice.
Use **Quit** in the tray or **Quit SC2 Tools** below sidebar Help to fully exit.

### Streams

The **Streams** page saves one title for your connected YouTube, Twitch and
Kick accounts and reports whether each title was verified or accepted. Kick's
public API can omit its title while offline, so an accepted offline save does
not claim verified readback or disconnect the account.

Edit the **YouTube description** directly below the shared title, then click
**Save title & description**. The description applies to both YouTube formats
and is saved for future sessions. A current unfinished pair is updated when
its ownership can be verified; the vertical description automatically includes
the horizontal partner's watch link. Unsaved edits survive page refreshes,
and saved templates preserve deliberately empty descriptions.

Pair the agent with your SC2Tools account, then use **Connect** for each
platform. Authorize stream-control permission in your system browser once;
SC2Tools keeps provider credentials encrypted on its server. Existing alert
connections need this explicit permission upgrade before they can manage
streams. The agent never asks normal users to register developer apps.
The only available YouTube channel is selected automatically. Two different
existing reusable keys are suggested when their horizontal and vertical roles
are clear; ambiguous keys still need your choice. Fresh setup defaults to Public,
Not made for kids, automatic next-session preparation and an editable description.
Review these choices and the exact OBS output names, then save setup. Existing
saved preferences and custom descriptions are preserved. Suggestions never
save settings or prepare broadcasts by themselves.
The server must provide the streaming API before these controls can connect.
SC2Tools never imports OBS login tokens or creates stream keys.

Deployment operators must enable **Update channel information** (`channel:write`)
in the registered SC2Tools Kick app before users connect stream controls. A URL
requesting that scope cannot grant it when the developer app has it disabled.
Normal users only complete the official consent screen.

After saving YouTube setup, open **OBS connection details** and choose
**Horizontal** or **Vertical**. **Fetch connection details** reads only that
selected reusable key. Copy its server URL and key into the Aitum output named
in the panel. The key stays masked until **Reveal key** or **Copy key** is used;
the agent keeps these details only in the open panel. Repeat for the other
format. This provides connection information; it does not write OBS settings.

Website account badges distinguish **Notifications ready** from **Stream
controls authorized**. A desktop agent paired to the same SC2Tools account
uses those stream-control permissions. **Ready** on a YouTube destination
means its session has also been prepared and bound to the saved key.

Click **Prepare YouTube session** once while both outputs are stopped. When
both show **Ready**, start their existing Aitum broadcaster buttons. If enabled,
SC2Tools prepares the next pair after both broadcasts have ended and both
outputs have stopped. Keep the agent running in the tray for this feature.
Each session has separate horizontal and vertical viewing links and chats;
the vertical description automatically links to its horizontal partner.

An existing pending broadcast on either selected key blocks preparation and
is preserved. Review that event in YouTube Studio before trying again. An
uncertain create response also blocks replacement; **Check / recover session**
can recover a known owned broadcast without inserting another.

**Advanced local setup** remains available for owners using their own OAuth
apps. Import a Google Desktop client with YouTube Data API v3 enabled. Twitch
requires a public OAuth client; Kick requires a client with the redirect
`http://localhost:8768/oauth/kickcallback`. Local connections use Windows DPAPI
under the agent's `streaming/` directory. Google's external Testing mode can
expire a local refresh token after seven days; use production consent for
ongoing use. Public rollout requires Google verification of the added sensitive
scope and enough shared project quota; packaging alone does not deploy the API.

The controller prepares metadata and sessions; OBS/Aitum sends the video.
It never starts a stream when the agent launches or when a game changes scenes.

The sidebar **Help & support** link opens the desktop guide. The round **?** buttons beside sync range, replay folders, OBS, build check-in and Activity log open their matching how-to. Closing the window keeps syncing in the tray; use the tray **Quit** action to stop it.

### Preview and place check-in cards

Settings → Build check-in → Cards previews either card with fixed sample data,
even with check-ins off. **Preview - nothing is saved** means answers stay local;
dragging the header still remembers the position for real cards. Any answer,
Escape or 90 seconds closes the sample, and real cards take priority. **Reset card
positions** clears every card kind and moves visible cards to their default spot;
**Open check-in queue on sc2tools.com** uses the same URL as the tray. Previews use
the last accepted replay's known race, falling back to ZvP; older history cannot
replace a newer race. Preview code does not change controller business logic.

On a real after-game card, click search, type, Enter to pick/focus the top visible
match, then Ctrl+Enter to confirm. Down focuses the first result without choosing;
Up returns to search. No match leaves the choice unchanged. Esc closes an opponent
list first, then means Later. These keys never activate a card over the game.

### Private scouting

Settings → Build check-in → **Show scouting at loading** is a local PC choice.
With check-ins enabled, loading cards show the current opponent's record, recent
opening samples, best recorded answer and a two-line private note. Turning off
Ask during the loading screen leaves a slim scouting-only card. Missing or
ambiguous identity never borrows another account's private note. **Open dossier**
opens the validated account path in your configured dashboard.

After the replay syncs and identifies the opponent, **Note for next time → Save
note** saves up to 500 characters to that opponent's private dossier, separately
from the game's check-in notes. Notes are never enabled for read-aloud. Scouting
uses a bounded authenticated device-room brief with a current-game cache fallback;
private notes do not go to OBS overlay rooms. Native cards retain their Windows
capture-exclusion request and non-activating loading flags. Offscreen tests verify
those requests, not every capture tool's behavior or real OS foreground state.
Read [Private desktop scouting](https://sc2tools.com/help/desktop-scouting).

## Tray menu (right-click the indicator)

| Item | What it does |
| ---- | ------------ |
| Status lines | The same status and next action as the window; full headline in the tooltip. |
| Install update vX | Requests the pending installer at the next safe moment. |
| Open SC2 Tools | Default/double-click action; restores the running window. |
| Open dashboard | Opens your account in the browser. |
| Build check-in… | Opens a pending game check-in or its website queue. |
| Pause syncing / Resume | Shared with the window and persisted across restarts. |
| Pause → For 1 hour / Until I resume | Holds queued replays; a timed pause resumes automatically. |
| More → Add replay folder… | Opens the window's Qt picker; applies immediately with Undo. |
| More → Re-sync library… | Uses the window's confirmation and paused/date-filter guards. |
| More → Open log folder | Opens the local logs in Explorer. |
| More → Check for updates | Reports a ready version, up-to-date result, or failed check. |
| Quit | Stops the agent. |

Replay folder rows show region, toon handle, replay count, newest replay age, and
Auto-detected / Added by you. Hover for the raw path, use Open in Explorer, or
press Delete to remove a row. Add, Remove, and Auto-detect persist immediately;
Undo restores the previous selection without resetting upload history. Redirected
Windows Documents and localized OneDrive folders are included in detection.

### Game Mode

Settings → Performance offers Gentle (up to 2 workers, idle priority), Balanced
(up to 4 workers, below normal priority), and Maximum (up to 12 workers, below
normal priority), each limited by CPU count. Save and restart to apply the worker
count. Existing custom worker limits remain until a speed is saved. On POSIX,
background workers request nice(10).

Pause history import while I'm in a game is on by default. The shared live-game
gate holds new history parses and archive jobs through loading/play and for 20
seconds after the match ends. Fresh rank-zero replays retain their priority lane.
Automatic accurate replay capture does not start mid-match. Pause on battery also
holds background work. A 120-second event silence or 45-minute match safety limit
releases the gate; --no-live disables it. Manual Pause holds all queued syncing.

The separate update card offers What's new (Markdown notes), Install now, and
Later (24 hours). Optional automatic updates respect the saved setting; Install
now still works when auto-update is off. Required updates defer at most 24 hours
from first discovery. Every install waits for two idle minutes, stopped OBS
outputs, and no capture. Failure leaves Retry and Download installer actions.
Capture notices cannot erase an update. After a version change, an Updated toast
and What's new link offer bundled notes even offline. Source checkouts use the
manual installer path. No release is published by these source changes.

Read [Tray and window](https://sc2tools.com/help/desktop-app-tray),
[Status lights](https://sc2tools.com/help/desktop-app-status),
[Performance](https://sc2tools.com/help/desktop-app-performance), and
[Updates](https://sc2tools.com/help/desktop-app-updates).

## Parse pool modes

The replay-parse step runs through one of two `concurrent.futures`
executors. Which one the agent picks is decided once at startup and
logged on the next line of `agent.log`:

```
parse_pool_mode=process workers=12       # the fast path
parse_pool_mode=thread  workers=12        # fallback, GIL-serialised
```

### What changed in v0.5.8

Process mode is the default again. v0.3.9 first shipped it and ran
into a `BrokenProcessPool` on every PyInstaller-frozen child during
spawn — the child's `sys.path` did not contain the analyzer roots
the parent had added, so `from core.sc2_replay_parser import …`
inside the lazy import path of `parse_replay_for_cloud` failed
during pickle-rehydration. v0.3.10 disabled the feature entirely
and pinned everyone to threading mode.

v0.5.8 re-enables process mode with three guardrails:

1. The worker function `_parse_in_worker` calls
   `bootstrap_analyzer_path()` as the FIRST thing it does on the
   child side, so the analyzer roots are unconditionally on the
   child's `sys.path` before any of its real imports run.
2. A synthetic boot-time probe spawns one child, asks it to import
   `core.sc2_replay_parser`, and waits 30 s for an answer. A failure
   means the agent transparently falls back to `ThreadPoolExecutor`
   for the rest of the session and logs `parse_pool_probe_failed`
   with the underlying exception type and repr.
3. A runtime catch in `_submit_parse` swaps the live process pool
   for a `ThreadPoolExecutor` if `BrokenProcessPool` ever surfaces
   mid-session (e.g., a worker OOM during an unusually long replay
   parse). The replay re-submits to the new pool transparently.

### Why process mode matters

`sc2reader` is GIL-bound. Under `ThreadPoolExecutor`, raising
`parse_concurrency` from 1 to 12 produced no measurable wall-clock
improvement on a backfill — every thread was waiting on the GIL
held by whichever sc2reader call happened to be active. Under
`ProcessPoolExecutor`, each worker is a real OS process with its
own GIL, so 12 workers actually parse 12 replays in parallel.

Measured impact on a backfill of ~12,000 historical replays:

| Mode | Wall-clock | Throughput |
| ---- | ---------- | ---------- |
| Threads, 1 worker | baseline | ~30 replays / min |
| Threads, 12 workers | ~baseline | ~33 replays / min |
| Processes, 12 workers | ~5× faster | ~150 replays / min |

The cost is memory: each warmed-up worker holds ~150 MB of
`sc2reader` parse state and the analyzer's build-detector caches.
On a 12-worker backfill that's roughly 1.8 GB of resident set above
the baseline agent — fine on any modern gaming PC, but worth
knowing about on a 4-GB-RAM Surface or similar.

### Forcing threading mode

Set `SC2TOOLS_PARSE_USE_PROCESSES=0` (or `false`, `off`, `no`,
case-insensitive) before launching the agent. The opt-out skips
the boot probe entirely so you don't pay the 1–3 s spawn warm-up.

```powershell
$env:SC2TOOLS_PARSE_USE_PROCESSES = "0"
py -m sc2tools_agent
```

Use this if you suspect the process-pool path is causing
instability on your install — and please include the
`parse_pool_probe_failed` log line in any bug report so we can
debug the underlying spawn issue.

### What to look for in `agent.log`

After a normal startup:

```
parse_pool_mode=process workers=12
```

After an env opt-out:

```
parse_pool_mode=thread workers=12 reason=env_opt_out
```

After a probe failure:

```
parse_pool_probe_failed err=broken_process_pool repr=… falling_back_to_threads
parse_pool_mode=thread workers=12 reason=probe_failed
```

After a mid-session worker death:

```
parse_pool_runtime_failure_falling_back reason=BrokenProcessPool(…) workers=12
parse_pool_mode=thread workers=12 reason=runtime_fallback
```

The runtime fallback only fires once per session — once the agent
has committed to threading, it stays there until the next restart.

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
pwsh packaging\build-installer.ps1 -Installer
```

The script reads the canonical version from
`sc2tools_agent\__init__.py` and outputs
`dist\SC2ToolsAgent-Setup-<version>.exe`. Local `-SigningCert` signs both
the inner executable and setup. The release workflow uses owner-configured
SignPath Foundation signing and verifies trusted timestamped signatures; absent
credentials do not turn an unsigned build into a signed one. The installer drops a Start Menu
shortcut and optional desktop shortcut. Installation options default Windows
startup on for a first install; installer and Settings share the per-user
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run\SC2ToolsAgent`
value with `--start-minimized`. Legacy Startup shortcuts migrate to this value,
and silent upgrades preserve the existing choice. The Finish page offers Launch
now. Uninstall keeps pairing/settings/logs unless local-data removal is explicitly
selected; original replay folders and cloud games are kept. See [packaging/README.md](packaging/README.md) for the full
build pipeline including code signing and the release-feed publish
step.

Read [Install, start-up and uninstall](https://sc2tools.com/help/desktop-app-install).
