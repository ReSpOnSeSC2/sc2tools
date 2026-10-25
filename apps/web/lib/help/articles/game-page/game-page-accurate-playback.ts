import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "game-page-accurate-playback",
  title: "Recorded vs standard map playback",
  summary:
    "Record a game with StarCraft II itself for exact positions, attacks, spells and creep in the map replay: for one game with a button, or for every new game automatically.",
  category: "game-page",
  audience: "player",
  signedInOnly: true,
  order: 3,
  keywords: [
    "accurate playback",
    "generate accurate playback",
    "recorded game playback",
    "recording replay",
    "map replay capture",
    "automatically capture map replays",
    "cpu",
    "positions",
    "attacks",
    "creep",
    "re-sync",
    "recording failed",
  ],
  updated: "2026-10-25",
  body: [
    {
      type: "paragraph",
      text: "A replay file doesn't store where every unit was at every moment, so the standard map replay fills in some positions. **Accurate playback** has the desktop app play the replay with StarCraft II on your PC and record what really happened: every position, attack, spell and creep tumor. The note on the map then reads *Recorded game playback*.",
    },
    { type: "heading", text: "What you need", anchor: "requirements" },
    {
      type: "list",
      items: [
        "The desktop app, version 0.16.11 or newer, running and linked on your PC.",
        "StarCraft II installed on that PC, and the replay still in its replay folder.",
        "Some spare CPU: recording runs StarCraft II in the background and can keep your PC busy for several minutes per game.",
      ],
    },
    { type: "heading", text: "Record one game", anchor: "one-game" },
    {
      type: "steps",
      items: [
        "Open your game page. The playback quality card shows **Standard** or **Recorded playback**, and whether the desktop app is online. Select **Upgrade playback** when a recording is needed.",
        "Keep the desktop app open. The steps show Requested, Recording in StarCraft, Uploading and Ready. The recording clock is elapsed waiting/recording time, not the replay's game clock. Open **What happens?** for the CPU note and desktop Settings → Map replay guidance.",
        "The map switches after the recording uploads. A private bell notification also links back to a website-requested upload, so you can leave this page. Previously saved recordings are reused.",
      ],
    },
    { type: "heading", text: "Record every new game", anchor: "automatic" },
    {
      type: "steps",
      items: [
        "In the desktop app, open **Settings** and tick **Automatically capture map replays (uses more CPU)** under **Map replay**. It applies straight away.",
        "Each new game is recorded after it ends, before it syncs.",
        "For games you already synced, run **Re-sync** once. Games with a saved recording aren't recorded again.",
      ],
    },
    {
      type: "callout",
      tone: "warning",
      title: "Streaming or playing on a slower PC?",
      text: "Recording uses a lot of CPU for a few minutes after each game. Leave automatic capture off while you stream or play, and use **Generate accurate playback** for the games you want to study.",
    },
    { type: "heading", text: "If it doesn't work", anchor: "troubleshooting" },
    {
      type: "list",
      items: [
        "*Recording failed. Keep the desktop agent open and try again.* The app was closed, or StarCraft II couldn't play the replay. Open the app and press the button again.",
        "*Recording is still processing.* Large games take longer. Check back in a few minutes; you can leave the page.",
        "The Recorded playback badge with no upgrade button means the saved recording is already complete. Recording actions are available on your own games; public/shared viewers cannot start a capture.",
        "Still on *Older replay data*? The game was synced by an old desktop app version. Update the app and run **Re-sync**.",
      ],
    },
    { type: "heading", text: "Streaming replay sections", anchor: "segments" },
    { type: "paragraph", text: "Recorded playback downloads small time sections as you watch, usually about one game minute each. The next section is fetched ahead, earlier sections can be reused, and decoded sections share a 24 MB browser cache. A cached transition has no loading cover. On a slow connection the last frame stays visible with a small loading status; an error offers Retry playback. Wait for the current section or seek to a section you already watched. Cast markers from decoded sections remain on the timeline when their detailed movement data leaves the cache." },
  ],
  related: ["game-page-replay", "game-page", "desktop-app-overview"],
};

export default article;
