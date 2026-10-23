import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "randomizer",
  title: "Build randomizer: let a draw pick your build",
  summary:
    "Choose a pool for each matchup and let the desktop Companion draw one saved build for your next game. OBS reveals are optional.",
  category: "builds",
  audience: "player",
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
    { type: "callout", tone: "info", title: "Native Companion preview", text: "The native workspace steps below require the Companion 0.21.0 preview, which is not included in the current stable download. Website settings and optional OBS setup remain separate. See [Companion preview availability](/help/desktop-companion)." },
    {
      type: "paragraph",
      text: "The build randomizer picks from your selected pool for the current matchup. Open **Companion → Randomizer** in the Windows app to use it without OBS. Its enable switch and pool use the same account settings as the website, and each real game keeps one saved pick.",
    },
    { type: "heading", text: "Set it up", anchor: "setup" },
    {
      type: "steps",
      items: [
        "Open **Companion → Randomizer** and choose a matchup. Your current concrete matchup is selected when a game arrives.",
        "Turn on **Enable randomizer for this matchup**.",
        "Check the eligible builds and press **Save selected pool**. Turn the matchup switch on or off whenever you want; these changes are saved to your account.",
        "Keep **Game assistance enabled** on in Companion when you want automatic game assistance. Its master switch stops native draws while preserving the matchup choices.",
        "For custom weights, search and the animated preview, open [Settings → Randomizer](/settings?tab=randomizer). Leave **Use custom weights** off for equal odds or adjust each weight, then press **Save changes**.",
        "An OBS reveal is optional. To show draws on stream, use the **Build randomizer** Browser Source from [Settings → Overlay](/settings?tab=overlay).",
      ],
    },
    {
      type: "paragraph",
      text: "Terran and Zerg matchups need your own builds: the catalog covers Protoss for now. Make them in your [build library](/builds) (**Build library** in the menu) with the right race and opponent race.",
    },
    { type: "heading", text: "Opening Gateway draw (Protoss)", anchor: "gateway-draw" },
    {
      type: "paragraph",
      text: "The optional OBS widget can follow a 1 Gate or 2 Gate build reveal with one opening unit (1 Gate) or two (2 Gate). Each build keeps its own unit odds. The native Companion currently shows the saved build pick; the animated opening-unit sequence belongs to the OBS widget and website preview.",
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
        "The native randomizer waits for the loading check-in, then draws when the game starts. **Roll now** in Companion draws immediately and releases that wait.",
        "A build you declared yourself takes priority. A retry, refresh or second connected display reuses the first saved pick for the game. A native roll suppresses a duplicate OBS reveal, and Companion shows an OBS pick if OBS saved it first.",
        "The drawn build is marked **Rolled** and is suggested as your plan after the game. It only counts toward a build's record once you confirm the check-in.",
      ],
    },
    { type: "heading", text: "If it doesn't spin", anchor: "troubleshooting" },
    {
      type: "list",
      items: [
        "Check that game assistance is on, this exact matchup is enabled, and its saved pool contains at least one eligible build.",
        "The matchup must be concrete. Random or unresolved races wait; finished games, replays, team games and games against the computer do not start native draws.",
        "The desktop app must be running: the draw starts when it reports the new game.",
      ],
    },
    { type: "settingsLink", label: "Open Settings → Randomizer", href: "/settings?tab=randomizer" },
  ],
  related: ["desktop-companion", "build-check-in", "practice-ghost-build", "obs-overlay-setup", "custom-builds"],
};

export default article;
