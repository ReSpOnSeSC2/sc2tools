import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "my-game-didnt-show-up",
  title: "Why didn't my game show up?",
  summary:
    "A game you just played isn't in your stats? Work through these checks: the desktop app, your filters, the replay folder, games the app skips on purpose and what Sync health reports.",
  category: "troubleshooting",
  audience: "all",
  signedInOnly: true,
  order: 20,
  keywords: [
    "game missing",
    "missing game",
    "game not showing",
    "not syncing",
    "sync",
    "upload",
    "no games",
    "stats not updating",
    "replay not uploaded",
    "games synced",
    "paused",
    "skipped",
    "vs ai",
    "team games",
    "custom games",
    "too short",
    "which player is you",
    "battletag",
    "re-sync",
    "sync health",
    "upload failing",
    "upload rejected",
    "no replay folder",
    "update required",
    "sync date range",
  ],
  updated: "2026-11-01",
  body: [
    {
      type: "paragraph",
      text: "A game normally appears a few seconds after it ends: the desktop app reads the replay, syncs it, and every open page updates on its own. If it doesn't, go through these checks in order.",
    },
    { type: "heading", text: "What the agent pill at the top means", anchor: "header-sync-pill" },
    {
      type: "list",
      items: [
        "**Agent online** means your linked desktop app has a recent heartbeat. **Agent offline** shows when it was last seen; **No desktop app linked** means you need to link a PC. Click the pill for exact last-seen and latest-game times, your total games, the top Sync health rows (explained below), **Open Sync health** and **Open Devices**. The separate **Realtime updates** detail describes this browser connection.",
        "The game count increases for newly saved games. Re-syncing an existing game or changing its build label doesn't add another game. The latest game time is when you played, not when its replay uploaded. Its relative label updates every 30 seconds; hover it for the exact time.",
        "During a large import, **Syncing — charts refresh every 30 s** means the count can move before the charts. Ordinary game updates refresh the charts after about two quiet seconds. You can also reload the page to fetch the current data.",
      ],
    },
    { type: "heading", text: "1. Is it in Replays?", anchor: "check-replays" },
    {
      type: "paragraph",
      text: "Open [Replays](/app/replays) and look at the top of the list. If the game is there, it synced fine and a filter is hiding it from the other sections: go to step 2. If it isn't there, go to step 3.",
    },
    { type: "heading", text: "2. Check your filters", anchor: "filters" },
    {
      type: "list",
      items: [
        "By default the analyzer counts **ranked 1v1 ladder games on the current patch** and hides games under 45 seconds. Custom games, games against friends and team games are hidden until you change **Maps** or **Players** in the filter bar.",
        "Look at the **Active filters** row under the filter bar. A matchup, region or date range left on from earlier, or a pick made in Strategies, hides everything else. **Reset to defaults** clears them all.",
        "See [Filters](/help/analyzer-filters) for every filter and its default.",
      ],
    },
    { type: "heading", text: "3. Is the desktop app running?", anchor: "desktop-app" },
    {
      type: "list",
      items: [
        "Look for the SC2 Tools icon in the system tray on your gaming PC. If it isn't there, start **SC2 Tools Agent** from the Start menu.",
        "Open its window. **Paused** means syncing is paused: press **Resume syncing**. **Pairing** means it isn't linked to your account: see [Install and link the desktop app](/help/install-and-pair).",
        "[Devices](/devices) shows when each paired PC was last seen. A PC that hasn't been seen for a long time isn't syncing.",
      ],
    },
    { type: "heading", text: "4. Did the app upload it?", anchor: "recent-uploads" },
    {
      type: "paragraph",
      text: "In the app, open **Recent uploads**. It lists the replays uploaded since the app started, newest first, with **Uploaded** or the reason an upload failed. If the game isn't there, one of these is the usual reason:",
    },
    {
      type: "table",
      head: ["Reason", "What to do"],
      rows: [
        ["The app doesn't watch that replay folder, for example a new region or account", "Press **Auto-detect** in the app's Settings: see [Replay folders](/help/replay-folders)."],
        ["It was a game against the AI", "Games against the computer aren't synced, on purpose."],
        ["The app couldn't tell which player is you", "Set your BattleTag and SC2Pulse IDs in [Settings → Profile](/settings?tab=profile), or your **Player handle** in the app's Settings, then press **Re-sync**."],
        ["Someone left during loading", "The game has no result, so there's nothing to count."],
        ["The replay was cut off or can't be read", "It was interrupted while saving, or comes from an unsupported game version. Press **Re-sync** to try again."],
        ["It's outside the app's **Sync date range**", "Set the range to **All time** in the app's Settings to include older games."],
      ],
    },
    {
      type: "paragraph",
      text: "While a large import runs, the progress card on [Today](/app) also counts skipped replays and says why.",
    },
    { type: "heading", text: "5. Still missing?", anchor: "still-missing" },
    {
      type: "steps",
      items: [
        "Press **Re-sync** in the app. It uploads every replay it can see again; games already synced aren't counted twice.",
        "If the bar at the top of SC2 Tools says *Reconnecting*, the browser is retrying its live connection. Your replay remains on your PC: see [Something went wrong](/help/something-went-wrong).",
        "Still not there? [Report a problem](/help/report-a-problem) with the time you played. In the app, **Activity log → Errors only → Copy → Copy last 200 lines** gets the relevant error, including its traceback. See [Find and copy an error](/help/desktop-app-activity-log).",
      ],
    },
    { type: "heading", text: "Sync health", anchor: "sync-health" },
    {
      type: "paragraph",
      text: "[Settings → Account → Sync health](/settings?tab=account#sync-health) shows what the desktop app on each PC reports about syncing. Each row names a problem, the PC it affects and what to do. The agent pill's details show the top rows. The card reads them once when you open it; press **Check again** to read them again.",
    },
    { type: "heading", text: "No replay folder", anchor: "sync-no-folder" },
    {
      type: "paragraph",
      text: "The desktop app isn't watching a replay folder, or a folder it watched no longer exists. New games can't sync until it has one. In the app's Settings, press **Auto-detect** or add the folder yourself: see [Replay folders](/help/replay-folders).",
    },
    { type: "heading", text: "Syncing is paused", anchor: "sync-paused" },
    {
      type: "paragraph",
      text: "You paused syncing in the desktop app. New games wait on your PC and upload when you press **Resume syncing**. Nothing is lost while it's paused.",
    },
    { type: "heading", text: "Uploads are failing", anchor: "sync-upload-failing" },
    {
      type: "paragraph",
      text: "The desktop app tried to upload games and couldn't. Open the app and press **Retry now**. If it keeps failing, copy the error from its Activity log: see [Find and copy an error](/help/desktop-app-activity-log).",
    },
    { type: "heading", text: "Update required", anchor: "sync-update-required" },
    {
      type: "paragraph",
      text: "This PC runs a desktop app older than the minimum supported version, so it may stop syncing. Install the latest version from [Download](/download). Your settings and games stay.",
    },
    { type: "heading", text: "Player not recognized", anchor: "sync-player-unresolved" },
    {
      type: "paragraph",
      text: "The desktop app skipped replays because it couldn't tell which player is you. The row lists the names it saw most often, with their account IDs, so you can spot an account of yours. Only you see that list. Add your BattleTag or SC2Pulse IDs in [Settings → Profile](/settings?tab=profile), or set your **Player handle** in the app's Settings. Then press **Re-sync** in the app.",
    },
    { type: "heading", text: "Uploads rejected", anchor: "sync-uploads-rejected" },
    {
      type: "paragraph",
      text: "SC2 Tools rejected some uploads in the last 7 days. Updating the desktop app usually fixes this. If it keeps happening, press **Report** on the row. The report starts with the reason codes and counts only, never a player name.",
    },
    { type: "heading", text: "Outside the sync date range", anchor: "sync-date-range" },
    {
      type: "paragraph",
      text: "The desktop app leaves out replays outside its **Sync date range**. To include older games, widen the range in the app's Settings: see [Choose what the desktop app syncs](/help/desktop-app-sync-range#choose-range).",
    },
    { type: "heading", text: "Sync health not reported", anchor: "sync-not-reported" },
    {
      type: "paragraph",
      text: "Sync health needs a recent desktop app. An older app still syncs your games; it just doesn't report these details. Install the latest version from [Download](/download). A PC that is off reports nothing until the app runs again.",
    },
  ],
  related: ["install-and-pair", "replay-folders", "analyzer-filters", "desktop-app-overview"],
};

export default article;
