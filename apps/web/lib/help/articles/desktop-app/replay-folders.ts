import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "replay-folders",
  title: "Replay folders",
  summary:
    "Which folders the desktop app watches, why you may have more than one, and how to add, remove or find them again with Auto-detect.",
  category: "desktop-app",
  audience: "all",
  order: 2,
  keywords: [
    "replay folder",
    "replays folder",
    "multiplayer folder",
    "accounts folder",
    "add folder",
    "auto-detect",
    "onedrive",
    "documents",
    "region",
    "second account",
    "smurf",
    "ptr",
    "missing games",
    "folder not found",
  ],
  updated: "2026-10-23",
  body: [
    {
      type: "paragraph",
      text: "StarCraft II saves each replay under your Documents folder, in a separate folder for every region and account you play on:",
    },
    {
      type: "paragraph",
      text: "`Documents\\StarCraft II\\Accounts\\<account>\\<region and handle>\\Replays\\Multiplayer`",
    },
    {
      type: "paragraph",
      text: "The desktop app finds these folders on its own, including Documents folders moved into OneDrive, and keeps looking while it runs. A folder that appears later, for example the first time you play on another region or on the Public Test Realm, is picked up without a restart.",
    },
    { type: "heading", text: "Playing on several regions or accounts?", anchor: "several-regions" },
    {
      type: "paragraph",
      text: "Each one has its own folder, and the app watches all of them. If games from one region or account are missing, open the app's **Settings** page and press **Auto-detect** under **Replay folders**: it adds every Replays\\Multiplayer folder it can find and keeps the ones already listed.",
    },
    { type: "heading", text: "Add or remove a folder", anchor: "add-or-remove" },
    {
      type: "steps",
      items: [
        "Open the app window and go to **Settings**.",
        "Under **Replay folders**, press **Add folder…** and choose a Replays\\Multiplayer folder, for example one on another drive. **Add replay folder…** on the Dashboard page does the same.",
        "To stop watching a folder, select it and press **Remove selected**. A folder the app found by itself stays unwatched until you add it again or press **Auto-detect**.",
        "Add, Remove, and Auto-detect apply immediately. Choose **Undo** in the window if you picked the wrong folder.",
      ],
    },
    {
      type: "paragraph",
      text: "Removing a folder only stops new uploads from it. Games already synced stay in your account, and nothing is deleted from your PC.",
    },
    { type: "heading", text: "Read the folder rows", anchor: "folder-rows" },
    { type: "paragraph", text: "Each row shows the region, toon handle, replay count, and age of the newest replay, for example **EU · 2-S2-1-42 · 1,204 replays · newest 2 h ago**. Regions include NA, EU, KR, CN, SEA, and PTR; an unknown region shows a question mark. **Auto-detected** means the app found the folder; **Added by you** means you chose it. Hover for the complete path. **Open in Explorer** opens it, and Delete removes the selected row." },
    { type: "paragraph", text: "An amber **Not found (external drive?)** row means the saved path is unavailable. Reconnect the drive or add its new location. A chosen folder with no replay files asks you to **Pick another** or **Use anyway**; StarCraft II normally saves multiplayer games under Replays\\Multiplayer. The app checks Windows redirected Documents and localized OneDrive folders before falling back to the usual locations." },
    { type: "heading", text: "If no folder is found", anchor: "not-found" },
    {
      type: "list",
      items: [
        "Play one game first: StarCraft II only creates the Replays folder after it saves a replay.",
        "If your Documents folder lives somewhere unusual, use **Locate folder…** in the empty state or **Add folder…** in Settings. The empty state says **We couldn’t find StarCraft II replays**.",
      ],
    },
  ],
  related: ["desktop-app-overview", "my-game-didnt-show-up", "install-and-pair"],
};

export default article;
