import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  "slug": "desktop-app-tray",
  "title": "Where the app lives: window, tray, pausing, quitting",
  "summary": "Bring the desktop window back, pause syncing, and fully quit SC2 Tools.",
  "category": "desktop-app",
  "audience": "all",
  "order": 3,
  "updated": "2026-10-23",
  "keywords": [
    "tray",
    "window",
    "close",
    "minimize",
    "quit",
    "pause",
    "resume",
    "shortcut",
    "second launch"
  ],
  "body": [
    {
      "type": "paragraph",
      "text": "SC2 Tools keeps watching replay folders after you close its window. Find the icon beside the Windows clock; Windows may place it under the **Show hidden icons** arrow. Double-click the desktop shortcut again to bring the existing window forward."
    },
    {
      "type": "heading",
      "text": "Open the window or quit",
      "anchor": "window-and-quit"
    },
    {
      "type": "paragraph",
      "text": "Right-click the tray icon and choose **Open SC2 Tools**, or double-click the icon. **Open dashboard** opens your account in a browser. Closing the window keeps syncing; use **Quit** to fully exit. The window also has **Quit SC2 Tools** below **Help & support**."
    },
    {
      "type": "paragraph",
      "text": "The first time the window hides, a tray reminder explains where it went. If the tray is unavailable, closing offers **Quit** or **Minimize** and remembers the choice. Minimize keeps the app on the taskbar."
    },
    {
      "type": "heading",
      "text": "Pause and resume",
      "anchor": "pause"
    },
    {
      "type": "paragraph",
      "text": "**Pause syncing** holds queued replays without removing them. The window and tray show the same pause state. Choose **Pause for 1 hour** for an automatic resume time, or **Pause until I resume** to leave it paused. The pause survives a restart. Use **Resume** in either place to continue sooner."
    },
    {
      "type": "heading",
      "text": "More actions",
      "anchor": "more"
    },
    {
      "type": "list",
      "items": [
        "**Build check-in…** reopens a pending game check-in or its website queue.",
        "**More → Add replay folder…** brings the window forward and uses its normal folder picker.",
        "**More → Re-sync library…** opens the confirmation dialog. Resume first and remove an active sync date filter before starting a full re-sync.",
        "**More → Open log folder** opens the local logs. **Check for updates** reports its result; a pending version adds **Install update vX** to the menu."
      ]
    },
    {
      "type": "paragraph",
      "text": "The coloured tray dot uses the same status as the window. Read [What the status lights mean](/help/desktop-app-status) for the colours and next actions."
    }
  ],
  "related": [
    "desktop-app-status",
    "replay-folders",
    "desktop-app-updates"
  ]
};

export default article;
