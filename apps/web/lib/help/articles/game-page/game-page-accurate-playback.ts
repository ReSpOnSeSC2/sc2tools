import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "game-page-accurate-playback",
  title: "Accurate map playback",
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
  updated: "2026-10-23",
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
        "Open the game page and find **Generate accurate playback** above the map replay. It shows whenever the game's playback isn't fully recorded yet.",
        "Press it and keep the desktop app open. The button reads *Recording replay…* while it works.",
        "When the recording is done it uploads, and the map replay switches to the recorded playback. A recording that's already been made is reused, so pressing it again later is quick.",
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
        "No button at all: the game is already fully recorded. The button only shows on your own game pages.",
        "Still on *Older replay data*? The game was synced by an old desktop app version. Update the app and run **Re-sync**.",
      ],
    },
  ],
  related: ["game-page-replay", "game-page", "desktop-app-overview"],
};

export default article;
