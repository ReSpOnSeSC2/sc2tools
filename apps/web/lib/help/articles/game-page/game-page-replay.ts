import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "game-page-replay",
  title: "Map replay: watch a game on the map",
  summary:
    "Play a game back on its map on the game page: the controls, the production and build-order panels beside it, notable moments, and what the accuracy note means.",
  category: "game-page",
  audience: "player",
  signedInOnly: true,
  order: 2,
  keywords: [
    "map replay",
    "replay player",
    "playback",
    "play",
    "pause",
    "speed",
    "zoom",
    "full screen",
    "fullscreen",
    "production rail",
    "build order rail",
    "notable moments",
    "music",
    "limited position data",
    "older replay data",
    "estimated creep",
    "no playback data",
  ],
  updated: "2026-10-23",
  body: [
    {
      type: "paragraph",
      text: "Under the timeline on the game page, **Map replay** plays the game back on its map: both players' units and buildings, their movement, fights and spells, with both players' army, workers and supply along the top.",
    },
    { type: "heading", text: "Play it back", anchor: "controls" },
    {
      type: "list",
      items: [
        "**Play** and **Pause** start and stop it. **Skip to start** goes back to 0:00.",
        "The speed button cycles through 1×, 4×, 8× and 16×.",
        "Drag the position bar to jump anywhere in the game. The marks along it are notable moments, such as fights; click one to jump there.",
        "The music button plays a soundtrack under the replay, with its own volume.",
      ],
    },
    { type: "heading", text: "Map controls", anchor: "map-controls" },
    {
      type: "list",
      items: [
        "Use the **Zoom in** and **Zoom out** buttons, hold Ctrl (Command on Mac) while scrolling, or pinch to zoom. Plain scrolling moves the page unless the map has focus or is fullscreen. Click the map to focus it; Escape or moving the pointer off the map releases focus. Drag to pan when zoomed.",
        "Double-click the map, or press **Reset zoom**, to see the whole map again.",
        "**Full screen** fills the screen with the replay; press it again or Esc to leave.",
      ],
    },
    { type: "heading", text: "The panels beside it", anchor: "panels" },
    {
      type: "list",
      items: [
        "**Production** shows what each player is building and researching at this moment.",
        "**Build order** lists each player's build so far, following the replay.",
        "On desktop, show or hide either panel from the display settings button. On phones, play controls stay directly below the map and above the app navigation. Open Production or Build order from the bar beneath them; tablets show that shared panel expanded.",
      ],
    },
    { type: "heading", text: "The accuracy note", anchor: "accuracy" },
    {
      type: "table",
      head: ["Note on the map", "What it means"],
      rows: [
        ["Recorded game playback", "The game was recorded with StarCraft II itself: positions, attacks and spells are exact."],
        ["Limited position data", "The replay file only records some positions. Units hold their last known position in between."],
        ["Older replay data", "This game was synced by an older desktop app. Run **Re-sync** in the app for better positions."],
        ["partial recording", "The recording stopped before the end of the game."],
        ["regenerate for attacks", "This recording is older than attack tracking. Record it again to see attacks."],
        ["estimated creep", "Creep is drawn from where tumors and hatcheries were, not recorded."],
      ],
    },
    {
      type: "paragraph",
      text: "For exact playback of a game, see [Accurate map playback](/help/game-page-accurate-playback).",
    },
    { type: "heading", text: "No replay on the map?", anchor: "no-playback" },
    {
      type: "paragraph",
      text: "*No playback data for this game* means the game was synced before map playback existed, or its playback hasn't been made yet. Turn on automatic map replays in the desktop app, or press **Generate accurate playback** to record this one game: see [Accurate map playback](/help/game-page-accurate-playback).",
    },
  ],
  related: ["game-page", "game-page-accurate-playback", "desktop-app-overview"],
};

export default article;
