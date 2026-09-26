# Training replay library

Double-click **Watch Training Games.cmd**, or run:

```powershell
./.venv/Scripts/python.exe -m pluto_sc2.replay_browser --open-browser
```

The launcher reuses an existing library server when it is running. It opens in
your default browser. The library listens only on 127.0.0.1; its temporary local
address is recorded in `runs/replay-browser/server.json`. Restarting the library
can change that address, so use the launcher instead of bookmarking the address.

## Pick a match

- **Stage:** League (default), Evaluation, Opening train, Opening validation, or all.
- **Matchup / learning agent:** filter Protoss games or Terran/Zerg opponent training.
- **Availability:** completed replay files or the game currently in progress.
- **Find a game:** search game number, map and opponent.
- **Watch replay:** starts a dedicated SC2 replay process through Blizzard's API.
- **Watch when ready:** selects one ongoing game; keep this tab open. Its replay
  opens when the match ends. Cancel selection to disable this. This is not live
  streaming and does not slow the game to human speed.
- **Download:** save the original replay archive.

Replays save at game end, before the policy update is committed. The library
distinguishes committed league games from uncommitted or failed attempts.
Completion is based on the league's immutable snapshot manifest. Replay archives
are checked before launching; engine-specific errors are shown in the viewer.

Some older AI-practice replays contain an API player label that SC2 rejects as a
toon handle. For that specific engine error, the viewer can create a derived
copy using the replay's own initData backup. It first proves that all differences
are player labels, preserves every gameplay member and the original SC2 header,
and leaves the original file untouched. The copy and its verification report are
in that viewer's folder. Downloads preserve the original archive, so use this
library to view affected older games. Future games use a verified compatible
player label.

Results are from player one's perspective: the Protoss learner for PvT/PvP/PvZ,
the Terran learner for TvP, or the Zerg learner for ZvP. Training's normalized
time-limit result takes precedence over the engine's raw replay winner. Opening
episodes last six game minutes and are labeled as preparation. They are not full
competitive matches or MMR evaluations.

Use the playback panel for pause, resume, 0.5x/1x/2x/4x/8x speed and closing the
viewer. Seeking to an arbitrary timestamp is not supported. Use the SC2 window
for the observer camera. The library opens one viewer at a time. It does not send
commands to the training clients, stop them, or change their observations.
Additional rendering consumes local hardware resources and may reduce training
throughput. The panel reports initialization or replay errors. A successful launch
request alone does not prove playback started: the panel waits for confirmation
from the dedicated viewer process. Closing the library tab does not close its
viewer or stop training.

## Local research and Blizzard's terms

Blizzard's [official SC2 API](https://github.com/Blizzard/s2client-proto) explicitly
supports machine-learning bots and replay analysis. Its
[AI and Machine Learning License](https://blzdistsc2-a.akamaihd.net/AI_AND_MACHINE_LEARNING_LICENSE.html)
licenses AI testing, machine learning and related research and provides an
automation exception for that authorized use (1.A and 1.C.ii). This project's
local API training and replay viewing are consistent with that intended use.
Local execution alone is not a universal terms exemption; the remaining license
requirements apply. This does not authorize ordinary Battle.net ladder botting.

## Implementation

`pluto_sc2.replay_browser` reads production artifacts without acquiring training
locks. It checks recorded process IDs and creation times to identify running
games. `viewer.json` records startup metadata for newly launched league jobs.
Older jobs use a compatibility fallback. The browser refreshes every five seconds.

Opening replays requires a session-specific URL and request token, same-origin
checks and a catalogued replay ID. Clients cannot submit arbitrary file paths.
Only files within this workspace are catalogued. The launcher validates the MPQ
archive and uses an argument list with `shell=False`. Each viewer has a separate
API port, temporary directory and owned SC2 process. Viewer controls are written
atomically beneath `runs/replay-browser/viewers`; they never enter training data.
