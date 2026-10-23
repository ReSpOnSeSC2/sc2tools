import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "install-and-pair",
  title: "Install and link the desktop app",
  summary:
    "Download the desktop app, get past the Windows warning, and link it to your account with the 6-digit code. After that, every game you play syncs on its own.",
  category: "getting-started",
  audience: "all",
  order: 3,
  keywords: [
    "install",
    "installer",
    "download",
    "desktop app",
    "agent",
    "windows",
    "smartscreen",
    "protected your pc",
    "run anyway",
    "pair",
    "pairing",
    "pairing code",
    "6-digit code",
    "link",
    "devices",
    "unpair",
    "second pc",
    "code expired",
    "mac",
    "linux",
  ],
  updated: "2026-10-23",
  body: [
    {
      type: "paragraph",
      text: "The desktop app is how your games reach SC2 Tools. It runs on the PC you play on, reads each replay a few seconds after the game ends and syncs the result to your account. You install it once and link it once.",
    },
    { type: "heading", text: "What you need", anchor: "requirements" },
    {
      type: "list",
      items: [
        "Windows 10 or 11, on the PC where you play StarCraft II.",
        "A free SC2 Tools account. [Sign up](/sign-up) first if you don't have one.",
        "About 220 MB of disk space for the app. Your replays stay where they are.",
      ],
    },
    { type: "heading", text: "Install it", anchor: "install" },
    {
      type: "steps",
      items: [
        "Open the [Download](/download) page on your gaming PC and click the download button.",
        "Double-click the installer in your Downloads folder.",
        "If Windows shows a blue **Windows protected your PC** message, click **More info**, then **Run anyway**. The installer isn't code-signed yet, so Windows warns about it; the warning doesn't mean anything is wrong.",
        "Click **Next**, then **Install**. The defaults are fine, and no administrator password is needed.",
      ],
    },
    { type: "heading", text: "Link it to your account", anchor: "pair" },
    {
      type: "steps",
      items: [
        "The app opens on its own and shows a 6-digit code under **Pair this device**.",
        "Click **Open pairing page**. Your browser opens [Devices](/devices); sign in if it asks. Newer apps fill in the code for you; otherwise enter the code shown in the SC2 Tools window on your PC.",
        "Click **Link this PC**, check the displayed PC details, and confirm. A prefilled code never links automatically. The page then checks for the app's connection.",
      ],
    },
    {
      type: "paragraph",
      text: "The code works for 10 minutes. Use the current code shown by the app. If an older app still shows an expired code, close and reopen it. See [Pairing problems](/help/pairing-troubleshooting) if the app is linked but has not checked in.",
    },
    { type: "heading", text: "After that", anchor: "after-pairing" },
    {
      type: "list",
      items: [
        "The app keeps running in the system tray, next to the clock. Closing its window doesn't stop it.",
        "New games sync a few seconds after they end. Your older replays already on the PC are uploaded too, newest first.",
        "It starts with Windows and updates itself, so there's nothing else to do. See [The desktop app](/help/desktop-app-overview) for its window, tray menu and settings.",
      ],
    },
    { type: "heading", text: "More than one PC", anchor: "more-than-one-pc" },
    {
      type: "paragraph",
      text: "Install the app on each PC you play on and pair each one with its own code. They all sync to the same account, and the same game is never counted twice. [Devices](/devices) lists every paired PC with when it was last seen.",
    },
    { type: "heading", text: "Unpair a PC", anchor: "unpair" },
    {
      type: "paragraph",
      text: "On [Devices](/devices), press **Unpair** next to the PC, read the dialog and confirm. It stops syncing; your games already synced stay in your account. To use it again, open the app on that PC and pair it with a new code.",
    },
    {
      type: "callout",
      tone: "info",
      title: "On a Mac, Chromebook or iPad?",
      text: "The desktop app is built for Windows. When browser import is available for your account, you can add replays from any computer instead: see [Import replays in your browser](/help/browser-import).",
    },
  ],
  related: ["getting-started", "desktop-app-overview", "replay-folders", "my-game-didnt-show-up"],
};

export default article;
