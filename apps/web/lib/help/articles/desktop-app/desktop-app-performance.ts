import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  "slug": "desktop-app-performance",
  "title": "Game Mode and import speed",
  "summary": "Keep history imports and capture out of your games, and choose how much background work the app does.",
  "category": "desktop-app",
  "audience": "all",
  "order": 4,
  "updated": "2026-10-23",
  "keywords": [
    "game mode",
    "performance",
    "fps",
    "workers",
    "gentle",
    "balanced",
    "maximum",
    "battery",
    "history",
    "capture"
  ],
  "body": [
    {
      "type": "paragraph",
      "text": "Open desktop **Settings → Performance**. **Pause history import while I’m in a game** is on by default. While StarCraft II is loading or playing a match, the app holds new history parses and replay archive work. It resumes after a 20-second settling period when the game ends or returns to the menu. A newly completed game keeps its priority upload lane."
    },
    {
      "type": "heading",
      "text": "Choose an import speed",
      "anchor": "import-speed"
    },
    {
      "type": "table",
      "head": [
        "Speed",
        "Background parser workers",
        "When to choose it"
      ],
      "rows": [
        [
          "Gentle",
          "Up to 2, at idle priority",
          "A slower PC, or the lightest history import."
        ],
        [
          "Balanced",
          "Up to 4, limited by CPU count, below normal priority",
          "A normal history import while using the PC."
        ],
        [
          "Maximum",
          "Up to 12, limited by CPU count, below normal priority",
          "The fastest import when you can spare CPU and memory."
        ]
      ]
    },
    {
      "type": "paragraph",
      "text": "Save settings, then restart SC2 Tools to apply a worker-count change. The worker display shows the count for the selected speed. Existing replay files and the upload queue are kept. **Pause on battery** also holds background parsing and archiving while the PC is using battery power."
    },
    {
      "type": "heading",
      "text": "Capture and updates",
      "anchor": "capture-and-updates"
    },
    {
      "type": "paragraph",
      "text": "Automatic accurate replay capture does not begin during a live match. Updates wait until the game has been idle for at least two minutes, OBS has no active output, and no replay capture is running. **Install now** also respects these guards. See [How updates work](/help/desktop-app-updates)."
    },
    {
      "type": "paragraph",
      "text": "Match detection relies on the local StarCraft II live interface. If no events arrive for two minutes, or one match is reported for 45 minutes, the app releases the history hold so it cannot get stuck forever. Starting the app with the developer flag `--no-live` disables the match hold. If you need to stop all uploads immediately, use [Pause syncing](/help/desktop-app-tray#pause)."
    }
  ],
  "related": [
    "desktop-app-tray",
    "desktop-app-updates",
    "desktop-app-sync-range"
  ]
};

export default article;
