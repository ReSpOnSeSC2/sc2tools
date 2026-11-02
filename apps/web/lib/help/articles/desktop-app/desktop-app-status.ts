import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  "slug": "desktop-app-status",
  "title": "What the status lights mean",
  "summary": "Read the status card's headline and rows, use each row's button, and match the tray dot.",
  "category": "desktop-app",
  "audience": "all",
  "order": 6,
  "updated": "2026-11-01",
  "keywords": [
    "status",
    "headline",
    "lights",
    "dot",
    "attention",
    "error",
    "restart",
    "paused",
    "grey",
    "unlinked"
  ],
  "body": [
    {
      "type": "paragraph",
      "text": "The status card at the top of the Dashboard has a headline and one row for each part of SC2 Tools. The sidebar and the tray show the same headline, so they always agree."
    },
    {
      "type": "heading",
      "text": "The headline",
      "anchor": "headline"
    },
    {
      "type": "list",
      "items": [
        "**Starting SC2 Tools…** shows while the app starts and connects.",
        "**Everything's working** means no row needs you.",
        "**1 thing needs attention** counts the rows with an amber or red dot.",
        "If SC2 Tools can't start, the headline names the cause, such as **SC2 Tools couldn't reach sc2tools.com**."
      ]
    },
    {
      "type": "heading",
      "text": "The rows",
      "anchor": "rows"
    },
    {
      "type": "paragraph",
      "text": "Each row is one sentence with a dot. Red is an error, amber needs you, cyan is for your information and green is fine. Rows that need you come first. A row has at most one button."
    },
    {
      "type": "table",
      "head": [
        "Row",
        "Example",
        "Button"
      ],
      "rows": [
        [
          "Account link",
          "Link this PC to your account to start syncing.",
          "Link PC"
        ],
        [
          "Pause",
          "Sync is paused until 14:30.",
          "Resume"
        ],
        [
          "Connection",
          "Can't reach sc2tools.com, so 312 replays are waiting.",
          "Retry now"
        ],
        [
          "Failed uploads",
          "5 uploads failed in the last 10 minutes.",
          "Open log"
        ],
        [
          "Replay folders",
          "No replay folder found; add your StarCraft II Replays folder.",
          "Add folder"
        ],
        [
          "Player name",
          "12 games from the last week were skipped because SC2 Tools couldn't tell which player was you.",
          "Set player name"
        ],
        [
          "Replay analyzer",
          "The replay analyzer didn't load, so new replays can't be read.",
          "Open log"
        ],
        [
          "Updates",
          "Version 0.25.0 is ready to install.",
          "Install update"
        ],
        [
          "OBS",
          "OBS rejected the saved password.",
          "Open OBS settings"
        ]
      ]
    },
    {
      "type": "paragraph",
      "text": "**Open log** opens the Activity log with errors only. **Set player name** and **Open OBS settings** open Settings at that setting. Some rows only inform you, such as **Uploading 12 replays** or **Only games from Season 67 sync**. Hover over the replay folders row to see the full folder paths."
    },
    {
      "type": "paragraph",
      "text": "Some rows have their own **?** button. It opens [Sync problems](/help/desktop-app-sync-problems) for a connection problem, and [Why didn't my game show up?](/help/my-game-didnt-show-up) for the player name and upload rows."
    },
    {
      "type": "paragraph",
      "text": "Features that are off are listed in grey below the rows, such as **Live game features are off** or **Automatic updates are off**. They never count as a problem."
    },
    {
      "type": "heading",
      "text": "Connection and replay failures",
      "anchor": "failures"
    },
    {
      "type": "paragraph",
      "text": "When sc2tools.com can't be reached, your replays wait safely in the queue. The connection row shows how many. **Retry now** tries again at once. If the website signed this PC out, **Retry now** checks that too. Once the unlink is confirmed, the account link row offers **Link PC**. Three or more failed uploads within ten minutes add a row with **Open log**. The row clears once those failures are ten minutes old."
    },
    {
      "type": "heading",
      "text": "If SC2 Tools can't start",
      "anchor": "startup"
    },
    {
      "type": "paragraph",
      "text": "A startup failure shows one red row with the cause and **Restart agent**. SC2 Tools asks first, then closes and starts again with its window open. **Copy details** appears with any error. It copies the app version, the headline, every row, the error and the last 20 ERROR log lines. Check what you copied before you share it."
    },
    {
      "type": "heading",
      "text": "Tray dots",
      "anchor": "tray"
    },
    {
      "type": "table",
      "head": [
        "Dot",
        "What it means"
      ],
      "rows": [
        [
          "Green",
          "Nothing needs you. Uploads and a ready update stay green."
        ],
        [
          "Amber",
          "Something needs you, such as linking this PC or a connection problem."
        ],
        [
          "Red",
          "An error, such as a startup failure or a replay analyzer that didn't load."
        ],
        [
          "Grey",
          "Sync is paused. An error still shows red, and a PC that needs linking still shows amber."
        ]
      ]
    },
    {
      "type": "paragraph",
      "text": "The tray has no dot while SC2 Tools starts, unless something already needs you. Hover over or right-click the tray icon to read the headline. Open the window to see the rows. Read [How updates work](/help/desktop-app-updates) for the update card."
    }
  ],
  "related": [
    "desktop-app-tray",
    "desktop-app-sync-problems",
    "pairing-troubleshooting",
    "desktop-app-activity-log"
  ]
};

export default article;
