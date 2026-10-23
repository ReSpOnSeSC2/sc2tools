import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "desktop-app-recent-games",
  title: "Your recent games in the desktop app",
  summary: "Read the desktop Dashboard, find a replay or error, and retry selected files without re-importing everything.",
  category: "desktop-app",
  audience: "all",
  keywords: ["recent games", "recent uploads", "last game", "today", "MMR", "failed", "retry", "copy error", "Explorer"],
  updated: "2026-10-23",
  body: [
    { type: "paragraph", text: "The desktop Dashboard shows your last synced game and the record of games tracked locally today. Open **Recent games** in the sidebar for the latest 200 local outcomes, kept across app restarts and shown only for the currently linked account." },
    { type: "heading", text: "What the Dashboard counts", anchor: "dashboard" },
    { type: "table", head: ["Tile", "How to read it"], rows: [
      ["Last game", "The newest locally tracked game with a recorded result. Open analysis takes you to that game on the website."],
      ["Today", "W–L and games by the replay's played date in your local timezone. Net MMR compares consecutive ladder games with known ratings in the same region and ladder race. Missing ratings, custom games and ladder changes break the comparison."],
      ["Synced · +N today", "Successful uploads by upload time. Importing an old replay today increases this count without adding it to today's played record."],
      ["Waiting", "Eligible replays still waiting on disk or in the queue, counted in the background without counting queued files twice."],
      ["Last upload", "Relative time of the latest successful upload. It survives restarting the app."],
      ["Failed (24 h)", "Locally tracked files whose latest outcome needs attention within the last 24 hours. View problems opens the Problems filter."],
    ] },
    { type: "callout", tone: "info", title: "Older uploads have fewer details", text: "On the first launch, up to 100 dated upload entries seed the list. They have no invented result, opponent or played date. Today is a locally tracked record, not a replacement for your complete website history." },
    { type: "heading", text: "Find a game or file", anchor: "rows" },
    { type: "steps", items: [
      "Choose **All**, **Uploaded**, **Problems** or **Skipped**, then a date range. Hover over When for the absolute local date and time.",
      "Read the result, matchup, opponent, map, length, your MMR and latest sync status. Bulk history imports stay under one collapsed row; double-click that group to expand it.",
      "Double-click a game to open its website analysis. A legacy row without a known game ID opens the local file location instead.",
      "Right-click **Show in Explorer** to select the exact replay, or **Copy path** to copy its full local path. A missing file produces an explanation rather than opening another file.",
    ] },
    { type: "heading", text: "An upload failed", anchor: "errors" },
    { type: "list", items: [
      "Right-click the row and choose **Retry** or **Copy error**. Select several failed rows for **Retry failed**. Retry keeps your saved sync date range and leaves unrelated uploads alone.",
      "A linked-PC error (401/403) needs **Link again**. A rate limit (429) waits and retries automatically. A busy service (5xx) waits or offers Retry now. [Sync problems](/help/desktop-app-sync-problems) explains each recovery.",
      "For a successful row, **Re-analyze** requests that file again. Games are upserted rather than counted twice. Skipped files and reason-specific retry are explained in [Importing your replay history](/help/desktop-app-import).",
    ] },
    { type: "heading", text: "Game notifications and maintenance", anchor: "actions" },
    { type: "paragraph", text: "Enable **Settings → Notify me after every new game syncs**, then Save, for a local result message with opponent and map. It starts off; history imports and resumed games stay quiet. **Re-sync replay library…** is at the bottom of Settings in **Maintenance**. **Check for updates** is beside the version in the sidebar." },
  ],
  related: ["desktop-app-import", "desktop-app-overview", "desktop-app-sync-problems", "desktop-app-activity-log"],
};

export default article;
