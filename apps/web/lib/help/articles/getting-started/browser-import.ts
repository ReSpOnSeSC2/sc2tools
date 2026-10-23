import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "browser-import",
  title: "Import replays in your browser",
  summary:
    "Add replays to your account without the desktop app, from Windows, Mac, Chromebook or iPad: pick files or a folder, and in Chrome or Edge keep a folder in sync.",
  category: "getting-started",
  audience: "player",
  signedInOnly: true,
  order: 4,
  keywords: [
    "import",
    "browser import",
    "upload replays",
    "no agent",
    "without the app",
    "mac",
    "macos",
    "chromebook",
    "ipad",
    "zip",
    "folder sync",
    "sync a replay folder",
    "sc2replay",
    "which player are you",
    "back up original replay files",
  ],
  updated: "2026-10-23",
  body: [
    {
      type: "paragraph",
      text: "Browser import reads your replays right in the browser tab, with the same analysis as the desktop app, then uploads the results to your account. It is being rolled out: when it's on for your account, Settings has an **Import** tab, and a new account with no games sees it next to the desktop app on [Today](/app).",
    },
    { type: "heading", text: "Import replays", anchor: "import" },
    {
      type: "steps",
      items: [
        "Open **Settings → Import**.",
        "Press **Choose replays** and pick .SC2Replay files or a .zip of them, or **Choose a folder** for a whole folder. You can also drag files or a folder onto the box.",
        "Pick **Replays from**: **Last 90 days** (the default) or **All time**. Up to 500 replays go in one run, newest first; run it again for older ones.",
        "Press **Analyze and upload**. The first run downloads the analyzer (about 8 MB) once. Keep the tab open until it says your games are uploaded.",
      ],
    },
    {
      type: "list",
      items: [
        "If the replays don't make clear which player is you, you're asked **Which player are you?** Pick your name once; it's remembered.",
        "Games already in your account are skipped, so importing the same folder twice is safe.",
        "If the upload stops, press **Try again**. Games that made it are not uploaded twice.",
      ],
    },
    { type: "heading", text: "Keep a folder in sync (Chrome and Edge)", anchor: "folder-sync" },
    {
      type: "paragraph",
      text: "In Chrome or Edge, **Folder Sync** remembers your StarCraft II folder. Press **Choose your StarCraft II folder** under Folder Sync (or **Sync a replay folder** in the import box) and pick it once. From then on, each time you open SC2 Tools (at most every 10 minutes), new ladder replays in that folder are analyzed and uploaded. Nothing is ever written to the folder.",
    },
    {
      type: "list",
      items: [
        "Press **Sync now** to check right away. After the browser restarts it asks for your OK again: press **Resume sync**.",
        "**Stop syncing** makes this browser forget the folder. Games already in your account stay.",
        "Other browsers can't remember a folder. Use **Import a replay folder** to import a whole folder at once; replays imported from it before are skipped next time.",
      ],
    },
    { type: "heading", text: "Where is my replay folder?", anchor: "where-are-my-replays" },
    {
      type: "table",
      head: ["Computer", "Folder"],
      rows: [
        ["Windows", "`Documents\\StarCraft II\\Accounts`"],
        ["Mac", "`~/Library/Application Support/Blizzard/StarCraft II/Accounts`"],
      ],
    },
    {
      type: "paragraph",
      text: "Pick the **Accounts** folder to include every region and account you play on. On an iPad or phone, copy the replays onto the device first, for example as a .zip in Files.",
    },
    { type: "heading", text: "Original replay files", anchor: "backups" },
    {
      type: "paragraph",
      text: "When the import box offers **Also back up original replay files**, it starts ticked: a private copy of each .SC2Replay is kept in your account so you can download it later from the game page. Untick it and the files stay only on your device. Your stats are the same either way.",
    },
    { type: "heading", text: "Browser import or the desktop app?", anchor: "browser-or-desktop-app" },
    {
      type: "list",
      items: [
        "Both give the same stats in every analyzer section.",
        "Only the desktop app syncs games while you play with no tab open, and only it feeds live overlays, pre-game scouting, OBS scene switching and accurate map playback, because those need StarCraft II running on the same PC.",
        "Browser import works on a Mac, Chromebook or iPad and needs nothing installed.",
      ],
    },
    {
      type: "paragraph",
      text: "On Windows, the desktop app is the easier choice: see [Install and link the desktop app](/help/install-and-pair).",
    },
  ],
  related: ["install-and-pair", "getting-started", "my-game-didnt-show-up"],
};

export default article;
