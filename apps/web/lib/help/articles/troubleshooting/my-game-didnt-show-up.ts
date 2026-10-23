import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "my-game-didnt-show-up",
  title: "Why didn't my game show up?",
  summary:
    "A game you just played isn't in your stats? Work through these checks: the desktop app, your filters, the replay folder and games the app skips on purpose.",
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
  ],
  updated: "2026-10-23",
  body: [
    {
      type: "paragraph",
      text: "A game normally appears a few seconds after it ends: the desktop app reads the replay, syncs it, and every open page updates on its own. If it doesn't, go through these checks in order.",
    },
    { type: "heading", text: "What the header sync pill means", anchor: "header-sync-pill" },
    {
      type: "list",
      items: [
        "**Live** means this browser has an authenticated connection for updates. **Connecting**, **Reconnecting**, or **Offline** describes the browser connection, not whether your gaming PC is running. Check [Devices](/devices) for your desktop app.",
        "**Games synced** increases for newly saved games. Re-syncing an existing game or changing its build label doesn't add another game. The latest sync time updates every 30 seconds; hover it for the exact time.",
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
        "Still not there? [Report a problem](/help/report-a-problem) with the time you played. In the app, **Open log folder** gets the log file to attach.",
      ],
    },
  ],
  related: ["install-and-pair", "replay-folders", "analyzer-filters", "desktop-app-overview"],
};

export default article;
