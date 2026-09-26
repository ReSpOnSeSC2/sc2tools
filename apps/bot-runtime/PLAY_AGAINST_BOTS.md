# Play against the training bots

Double-click **Play Against Bots.cmd** to open your local SC2 Training Lab.
The **Play against a bot** panel is above the replay library.

1. Choose **Your race** and **Bot race**. Both default to Protoss.
2. Choose the **Bot checkpoint**. The latest committed checkpoint is the newest
   saved policy; older checkpoints let you revisit previous versions. Click
   **Refresh bots** to pick up newly saved versions while training continues.
3. Choose an **Eight-worker map**, then click **Start game**.
4. Wait for the panel to report that the game is running. Play in the larger
   1280×720 StarCraft II window using your normal mouse, keyboard, camera, and
   hotkeys. A smaller 640×480 window for the bot may also be visible.

These are local games through Blizzard's SC2 API. No Battle.net lobby or ladder
login is needed. Both players start with eight workers. Games run in real time
so you can play normally. The selected bot version remains fixed for the match,
even if the training league saves a newer checkpoint in the meantime.

The Protoss bot retains its 200 APM maximum, camera restrictions, and fog of war.
Terran and Zerg retain their higher 600 APM maximum and access to the full visible
map; fog of war still applies. The panel shows the selected bot's restrictions.
The bots' current strength is unmeasured; a local result is not a ladder MMR.

## Finish, watch, and play again

The game ends normally when a player wins, loses, or leaves. You can also use
**End match** in the browser to close this human-play session. It only controls
the dedicated practice game. It does not stop the training league or a replay
viewer. Closing the browser tab alone does not end the match.

The panel preserves its session in the current browser tab. Reloading the page
reconnects to that match, and **Refresh bots** also discovers an active game.
Only one human-play session can run at a time. Once a game ends, **Dismiss**
clears its status, or choose another checkpoint and start your next game.

Completed practice replays appear in the library under **Stage → Human matches**.
Use **Watch replay** to review one with the same pause and speed controls as the
training replays. Results in these rows are from **your perspective** (player
one); training rows retain the learning agent's perspective. Use the matchup
and player-one race filters to narrow the list.

Human practice games do not automatically update any policy or enter the replay
training dataset. Training keeps running in its existing processes. Running an
additional rendered game uses CPU and GPU resources and may reduce training
throughput.

## If a game does not start

Startup may take a moment while StarCraft II loads. A launch request is followed
by actual engine status in the panel. If startup fails, the panel displays the
specific error. Refresh the bot list and check that a saved checkpoint and an
eight-worker map are available. If a request loses its connection, use
**Refresh bots** to recover the active session before starting another match.

Use the launcher to reopen the library rather than bookmarking its temporary
local address. The server listens only on 127.0.0.1 and accepts catalogued bots
and maps; the browser does not send arbitrary file paths or connect to an online
matchmaking service.
