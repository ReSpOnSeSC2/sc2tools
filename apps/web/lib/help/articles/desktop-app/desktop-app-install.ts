import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  "slug": "desktop-app-install",
  "title": "Install, start-up and uninstall",
  "summary": "Choose desktop shortcuts and Windows start-up, keep your settings on uninstall, and check an installer’s signature.",
  "category": "desktop-app",
  "audience": "all",
  "order": 7,
  "updated": "2026-10-23",
  "keywords": [
    "install",
    "installer",
    "startup",
    "start-up",
    "windows",
    "uninstall",
    "shortcut",
    "signature",
    "publisher"
  ],
  "body": [
    {
      "type": "paragraph",
      "text": "Download the Windows installer from [Download](/download). Run it for your own Windows account; it installs under your local application data folder by default. The Installation options page offers **Start SC2 Tools when Windows starts** and **Create desktop shortcut**, both on for a first installation. The Finish page has **Launch SC2 Tools now**."
    },
    {
      "type": "heading",
      "text": "One Windows start-up switch",
      "anchor": "startup"
    },
    {
      "type": "paragraph",
      "text": "Change **Run on Windows startup** later in the desktop app’s Settings. The installer and app share one per-user Windows Run entry. Starting with Windows opens SC2 Tools quietly in the tray. Older Startup-folder shortcuts are recognized and migrated, so the setting reflects whether the app actually starts. Silent automatic updates keep your existing start-up and desktop-shortcut choices."
    },
    {
      "type": "paragraph",
      "text": "Closing the window keeps the app syncing. To stop it fully, choose **Quit SC2 Tools** in the window or **Quit** in the tray. Read [Window and tray](/help/desktop-app-tray) for pausing and reopening it."
    },
    {
      "type": "heading",
      "text": "Uninstall without losing your setup",
      "anchor": "uninstall"
    },
    {
      "type": "steps",
      "items": [
        "Quit SC2 Tools, then find **SC2 Tools Agent** in Windows Settings → Apps → Installed apps and choose Uninstall.",
        "Leave **Delete local settings, pairing, logs and cached SC2 Tools data** unchecked to keep the link and preferences for a later reinstall.",
        "Check that option only to remove local agent.json, player_handle.json, logs, data, streaming and replay-observations from the default SC2 Tools application-data folder. Your original StarCraft II replay folders and cloud games are kept."
      ]
    },
    {
      "type": "paragraph",
      "text": "Uninstall always removes the Windows start-up entry and app shortcuts. A silent uninstall keeps local settings. A developer who set a custom state directory manages that directory separately; the uninstaller does not follow replay folder settings or delete arbitrary paths."
    },
    {
      "type": "heading",
      "text": "Check the download",
      "anchor": "verify"
    },
    {
      "type": "paragraph",
      "text": "The Download card shows the installer’s SHA-256. Compare it with the file you downloaded. For a signed build, open the file’s **Properties → Digital Signatures** and check that Windows reports a valid publisher signature. A checksum confirms file integrity; it does not by itself prove the publisher. SC2 Tools does not describe an unsigned verification build as signed."
    }
  ],
  "related": [
    "install-and-pair",
    "desktop-app-tray",
    "desktop-app-updates"
  ]
};

export default article;
