import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "randomizer",
  title: "Build randomizer: let a draw pick your build",
  summary:
    "Choose which builds can come up in each matchup and how likely each one is, and an animated draw picks your build on stream when a new game loads.",
  category: "builds",
  audience: "streamer",
  signedInOnly: true,
  order: 50,
  keywords: [
    "randomizer",
    "build randomizer",
    "build roulette",
    "random build",
    "spin",
    "roll",
    "weights",
    "custom weights",
    "opening gateway draw",
    "1 gate",
    "2 gate",
    "sound effects",
    "live preview",
    "roll now",
  ],
  updated: "2026-10-23",
  body: [
    {
      type: "paragraph",
      text: "The build randomizer is an overlay widget that draws a build for you, and your viewers, at the start of each new game. You decide which builds can come up in each matchup and how often.",
    },
    { type: "heading", text: "Set it up", anchor: "setup" },
    {
      type: "steps",
      items: [
        "Open [Settings → Randomizer](/settings?tab=randomizer) and pick a matchup.",
        "Turn on **Enable randomizer for this matchup**.",
        "Tick the builds it may draw: **Catalog builds** that come with SC2 Tools, and **Your custom builds** that fit the matchup. Search to find one.",
        "Leave **Use custom weights** off for an equal chance per build, or turn it on and use the sliders to make some builds come up more often.",
        "Press **Save changes**. Repeat for every matchup you want drawn.",
        "In [Settings → Overlay](/settings?tab=overlay), copy the **Build randomizer** URL into an OBS Browser Source, or use the all-in-one overlay that already includes it.",
      ],
    },
    {
      type: "paragraph",
      text: "Terran and Zerg matchups need your own builds: the catalog covers Protoss for now. Make them in your [build library](/builds) (**Build library** in the menu) with the right race and opponent race.",
    },
    { type: "heading", text: "Opening Gateway draw (Protoss)", anchor: "gateway-draw" },
    {
      type: "paragraph",
      text: "After a 1 Gate or 2 Gate build wins the draw and its reveal clears, the widget can draw one opening unit (1 Gate) or two (2 Gate). Each build keeps its own unit odds.",
    },
    { type: "heading", text: "Try it before you go live", anchor: "preview" },
    {
      type: "list",
      items: [
        "**Live preview** at the bottom of the page plays the full sequence for the selected matchup, exactly as it will look in OBS.",
        "**Sound effects** adds wheel ticks and a winner fanfare to the reveal, with its own volume. They play in OBS and in the preview.",
        "The **Test** button next to the widget in Settings → Overlay plays a sample draw in OBS.",
      ],
    },
    { type: "heading", text: "During a game", anchor: "during-a-game" },
    {
      type: "list",
      items: [
        "When the desktop app reports a new game in a matchup you've set up, the widget draws a build and reveals it, then clears for the game.",
        "With [Build check-in](/help/build-check-in) asking at the loading screen, the card reads *Randomizer will roll*. Pick a build yourself and the draw is skipped for that game; press **Roll now** to draw right away, or wait a few seconds.",
        "The drawn build is marked **Rolled** and is suggested as your plan after the game. It only counts toward a build's record once you confirm the check-in.",
      ],
    },
    { type: "heading", text: "If it doesn't spin", anchor: "troubleshooting" },
    {
      type: "list",
      items: [
        "Check that you pressed **Save changes** and that this exact matchup is enabled with at least one build ticked.",
        "Games against Random have no known matchup at the start, so there's no draw.",
        "The desktop app must be running: the draw starts when it reports the new game.",
      ],
    },
    { type: "settingsLink", label: "Open Settings → Randomizer", href: "/settings?tab=randomizer" },
  ],
  related: ["build-check-in", "practice-ghost-build", "obs-overlay-setup", "custom-builds"],
};

export default article;
