import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "desktop-app-overview",
  title: "The desktop app: window, tray and settings",
  summary:
    "What the SC2 Tools desktop app does on your PC, what each page of its window shows, how to pause or re-sync, and where its settings and logs are.",
  category: "desktop-app",
  audience: "all",
  order: 1,
  keywords: [
    "desktop app",
    "agent",
    "tray",
    "system tray",
    "window",
    "dashboard",
    "recent uploads",
    "activity log",
    "logs",
    "pause",
    "resume",
    "re-sync",
    "resync",
    "quit",
    "close",
    "updates",
    "auto update",
    "start with windows",
    "player handle",
    "sync date range",
    "settings",
  ],
  updated: "2026-10-23",
  body: [
    {
      type: "paragraph",
      text: "The desktop app watches your StarCraft II replay folders. A few seconds after each game it reads the new replay on your PC and syncs the result to your account: build orders, timings, macro, MMR and the original file. While you play it also tells SC2 Tools about the game in progress, which drives the live card on [Today](/app), your OBS overlays and build check-in. Not installed yet? See [Install and link the desktop app](/help/install-and-pair).",
    },
    { type: "heading", text: "The window", anchor: "window" },
    {
      type: "table",
      head: ["Page", "What it's for"],
      rows: [
        ["Dashboard", "Shared status and recovery, Last game, locally tracked Today record, upload totals and history-import progress. Re-sync is in Settings Maintenance; Updates is beside the sidebar version. While unlinked, it shows your pairing code."],
        ["Recent games", "Up to 200 local outcomes across restarts, with status/date filters and collapsed history imports. Double-click a game for website analysis; right-click for its exact replay file, Retry or Copy error. See [Your recent games](/help/desktop-app-recent-games)."],
        ["Activity log", "What the app is doing right now, with complete tracebacks, level filters, search, follow controls, copy actions and **Open log folder**. See [Find and copy an error](/help/desktop-app-activity-log)."],
        ["Settings", "Replay folders, what to sync, start-up and updates, map replay capture, build check-in and OBS scene switching."],
        ["Streams", "Set one stream title for your connected YouTube, Twitch and Kick accounts."],
      ],
    },
    { type: "heading", text: "Window and tray", anchor: "tray" },
    {
      type: "list",
      items: [
        "Closing the window keeps the app running in the system tray, next to the clock, and it keeps syncing.",
        "Double-click the tray icon, or right-click it and choose **Open agent window**, to bring the window back.",
        "The tray menu also has **Open dashboard** (opens SC2 Tools in your browser), **Build check-in…**, **Pause syncing**, **Re-sync from scratch**, **Choose replay folder…**, **Check for updates** and **Open log folder**.",
        "To stop the app completely, choose **Quit** in the tray menu.",
      ],
    },
    { type: "heading", text: "Pause or re-sync", anchor: "pause-and-resync" },
    {
      type: "list",
      items: [
        "**Pause syncing** stops uploads but keeps watching your folders. **Resume syncing** uploads everything that waited.",
        "**Re-sync** uploads every replay the app can see again. Use it after a snapshot restore, after deleting your game history, or when support asks you to. A game is never counted twice, so it's safe; with many replays it can take a while.",
      ],
    },
    { type: "heading", text: "Settings", anchor: "settings" },
    {
      type: "table",
      head: ["Setting", "What it does"],
      rows: [
        ["Player handle", "Your in-game name, so the app knows which player is you. Leave it blank to detect it from your replays."],
        ["Sync date range", "Which replays to upload: **All time**, a season, or a custom range. Pick **Current season** if you have years of old replays and want today's stats first. Replays outside the range are skipped, not deleted. See [Choose what to sync](/help/desktop-app-sync-range)."],
        ["Replay folders", "The folders the app watches. See [Replay folders](/help/replay-folders)."],
        ["Start-up", "**Run SC2 Tools Agent on Windows startup** and **Start minimised to the system tray**."],
        ["Updates", "**Install agent updates automatically** is on by default. Turned off, the app only tells you when an update is out, unless the update is required to keep syncing."],
        ["Map replay", "**Automatically capture map replays** records detailed playback for each new game. It uses a lot of CPU for a few minutes per replay. See [Accurate map playback](/help/game-page-accurate-playback)."],
        ["Build check-in", "When to ask which build you went for. See [Build check-in](/help/build-check-in)."],
        ["OBS scene switching", "Switch OBS scenes when a game starts and ends. See [OBS auto scene switching](/help/obs-auto-scene-switching)."],
      ],
    },
    {
      type: "paragraph",
      text: "Press **Save settings** at the bottom of the page. **Saving settings…** keeps the form briefly disabled while the durable save finishes; you can still use the sidebar and Activity log. **Saved** confirms completion, and a failure keeps your edits available to try again. The map replay and build check-in switches apply straight away.",
    },
    {
      type: "callout",
      tone: "info",
      title: "API address (advanced)",
      text: "**API base URL** is only for self-hosted or development setups. Leave it blank or click **Reset to default** to return to sc2tools.com. **Test** checks whether the address is reachable. Changing the address applies after restarting SC2 Tools.",
    },
    { type: "heading", text: "Logs", anchor: "logs" },
    {
      type: "paragraph",
      text: "The app writes its log to `%LOCALAPPDATA%\\sc2tools\\logs\\agent.log`. The **Activity log** page shows recent entries. Use **Errors only → Copy → Copy last 200 lines** to capture a failure, or **Open log folder** to attach the complete file when you [report a problem](/help/report-a-problem). [Find and copy an error](/help/desktop-app-activity-log) explains search and following.",
    },
    { type: "heading", text: "Updates", anchor: "updates" },
    {
      type: "paragraph",
      text: "The app checks for new versions on its own and, with automatic updates on, installs them and restarts minimised. **Check for updates** checks right away; the result shows on the Dashboard page. [Settings → Foundation](/settings?tab=foundation) shows which version your PC is running.",
    },
  ],
  related: ["desktop-scouting", "install-and-pair", "replay-folders", "my-game-didnt-show-up", "build-check-in"],
};

export default article;
