import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  "slug": "desktop-app-updates",
  "title": "How updates work",
  "summary": "Review release notes, install a ready version, or postpone it without interrupting a game.",
  "category": "desktop-app",
  "audience": "all",
  "order": 5,
  "updated": "2026-10-23",
  "keywords": [
    "updates",
    "installer",
    "version",
    "release notes",
    "what is new",
    "later",
    "snooze",
    "retry",
    "automatic"
  ],
  "body": [
    {
      "type": "paragraph",
      "text": "The desktop app checks the SC2 Tools release feed. When a version is ready, its separate update card shows **Version X is ready**, **What’s new**, **Install now**, and **Later**. Expand **What’s new** to read the release notes. Replay-capture and connection messages use a separate transient line, so they do not erase this card."
    },
    {
      "type": "heading",
      "text": "Install or postpone",
      "anchor": "buttons"
    },
    {
      "type": "paragraph",
      "text": "**Install now** works even when automatic updates are turned off. Installation waits until no match has been active for at least two minutes, no OBS output is live, and no replay capture is running. During the hold, the card says **Will install after this match**. The tray also offers **Install update vX**."
    },
    {
      "type": "paragraph",
      "text": "**Later** postpones a normal automatic update for 24 hours. A required update can be postponed for at most 24 hours after the app first discovers it; it still waits for a safe moment. Your choice is remembered after a restart. Turning automatic updates off keeps optional versions ready for you to install."
    },
    {
      "type": "heading",
      "text": "If an update fails",
      "anchor": "failed"
    },
    {
      "type": "paragraph",
      "text": "The card shows **Update failed** with the reason. Choose **Retry** to try again, or **Download installer** to open the website download page. Keep the existing installation until the replacement is ready. Source installations use the download/manual update path rather than automatically replacing a developer checkout."
    },
    {
      "type": "heading",
      "text": "After restarting",
      "anchor": "after-restart"
    },
    {
      "type": "paragraph",
      "text": "After the installed version changes, the app shows **Updated to vX**. **What’s new** on the Dashboard opens release notes, including bundled notes if the network is unavailable. Pairing, replay folders, queued uploads, and replay history stay on the PC through an update. **Check for updates** in the window or tray reports whether a version is available or the check failed."
    }
  ],
  "related": [
    "desktop-app-performance",
    "desktop-app-tray",
    "desktop-app-activity-log"
  ]
};

export default article;
