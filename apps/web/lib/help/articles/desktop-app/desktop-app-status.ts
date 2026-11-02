import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  "slug": "desktop-app-status",
  "title": "What the status lights mean",
  "summary": "Read the same status in the Dashboard, sidebar, and tray, and find the next useful action.",
  "category": "desktop-app",
  "audience": "all",
  "order": 6,
  "updated": "2026-11-01",
  "keywords": [
    "status",
    "badge",
    "lights",
    "dot",
    "watching",
    "syncing",
    "attention",
    "error",
    "unlinked",
    "connecting"
  ],
  "body": [
    {
      "type": "paragraph",
      "text": "The Dashboard card, sidebar, and tray share one status. Read the cause below the headline and use its action. A sync-range label such as **Season 67 only** stays beside the headline. Full replay folder paths are available on hover; manage them in Settings."
    },
    {
      "type": "table",
      "head": [
        "Badge",
        "What it means",
        "What to click"
      ],
      "rows": [
        [
          "Starting",
          "SC2 Tools is starting. No tray dot yet.",
          "Wait for startup."
        ],
        [
          "Connecting",
          "The app is connecting to SC2 Tools. No tray dot yet.",
          "Wait; a connection problem will show its own action."
        ],
        [
          "Link this PC",
          "The PC needs an account link. Amber dot.",
          "Use the pairing code below the card."
        ],
        [
          "Unlinked",
          "The website confirmed this PC was unlinked. Amber dot.",
          "Link again; queued replays are kept."
        ],
        [
          "Watching",
          "The listed replay folders are watched. Green dot, or blue if an update is ready.",
          "Manage opens Settings."
        ],
        [
          "Syncing",
          "Replays are being synced in the background. Cyan dot.",
          "Leave the app running."
        ],
        [
          "Paused",
          "New replays wait until you resume, or until the displayed time. Grey dot.",
          "Resume."
        ],
        [
          "Needs attention",
          "The app is offline, the service is busy, three uploads failed recently, or no replay folder was found. Amber dot.",
          "Retry now, View failed uploads, or Open Settings, as shown."
        ],
        [
          "Error",
          "Startup or the replay analyzer failed. Red dot.",
          "Open log, then Copy details for a support report."
        ]
      ]
    },
    {
      "type": "heading",
      "text": "Connection and replay failures",
      "anchor": "failures"
    },
    {
      "type": "paragraph",
      "text": "A connection hold shows the number of waiting replays and the next retry countdown in this same card. Temporary failures stay queued. Three or more terminal upload failures within ten minutes show **Needs attention**; the count expires after ten minutes and successful uploads do not erase it early. Open **Recent uploads** to inspect the final replay outcomes."
    },
    {
      "type": "paragraph",
      "text": "An error takes priority over a normal “watching” message. **Copy details** includes the app version, status, startup exception or analyzer diagnostic, and the last 20 ERROR log lines. Review copied details before sharing them. Pairing or unlinked states hide upload totals and disable Pause, Re-sync, and Add folder until the link is restored."
    },
    {
      "type": "paragraph",
      "text": "Time-limited service notices appear in a separate area and expire automatically. Their information link stays on the SC2 Tools website. The update card remains separate from this status. An amber or red tray dot keeps priority over the blue update dot. Read [How updates work](/help/desktop-app-updates) and [Sync problems](/help/desktop-app-sync-problems) for the next steps."
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
