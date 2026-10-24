import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "randomizer",
  title: "Build randomizer: let a draw pick your build",
  summary:
    "Configure a shared build pool in Companion or on the website. The Randomizer widget performs the draw, animation, sounds and spoken result; native check-ins only show its saved pick.",
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
    { type: "callout", tone: "info", title: "Widget-only Randomizer", text: "The Companion configuration steps below cover the Companion 0.23.0 verification preview, which is not included in the current stable download. Website settings and the Randomizer widget remain separate. See [Companion preview availability](/help/desktop-companion)." },
    {
      type: "paragraph",
      text: "The Randomizer widget picks from your selected pool for the current matchup. **Companion → Randomizer** silently configures the shared account settings and shows an existing saved pick; it does not draw. Current-game animation, sound effects and spoken results belong only to the widget, opened in a browser or OBS Browser Source. Native scouting voice is a separate feature and remains available.",
    },
    { type: "heading", text: "Set it up", anchor: "setup" },
    {
      type: "steps",
      items: [
        "Open **Companion → Randomizer** and choose a matchup. Your current concrete matchup is selected when a game arrives.",
        "Turn on **Enable randomizer for this matchup**.",
        "Check the eligible builds and press **Save selected pool**. Turn the matchup switch on or off whenever you want; these changes are saved to your account.",
        "Open the **Build randomizer** widget from [Settings → Overlay](/settings?tab=overlay) in a browser or OBS Browser Source. The widget must be open to perform its current-game roll; Companion has no native current-game Randomizer popup or draw engine.",
        "For custom weights, search and the animated preview, open [Settings → Randomizer](/settings?tab=randomizer). Leave **Use custom weights** off for equal odds or adjust each weight, then press **Save changes**.",
        "Use the widget's controls for Randomizer visuals, sound effects and spoken results. Companion's Randomizer configuration page is silent; its scouting voice setting does not enable Randomizer speech.",
      ],
    },
    {
      type: "paragraph",
      text: "Terran and Zerg matchups need your own builds: the catalog covers Protoss for now. Make them in your [build library](/builds) (**Build library** in the menu) with the right race and opponent race.",
    },
    { type: "heading", text: "Opening Gateway draw (Protoss)", anchor: "gateway-draw" },
    {
      type: "paragraph",
      text: "The Randomizer widget can follow a 1 Gate or 2 Gate build reveal with one opening unit (1 Gate) or two (2 Gate). Each build keeps its own unit odds. Companion only shows the saved build pick; the animated opening-unit sequence belongs to the widget and website preview.",
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
        "The widget respects the loading check-in's decision hold when configured. If a check-in card offers **Roll in widget**, that only releases the widget's wait; it does not roll in the native app.",
        "A build you declared yourself takes priority. A retry, refresh or second connected display reuses the first saved pick for the game. Native check-in cards show the widget's already selected result, without drawing or playing another reveal.",
        "The drawn build is marked **Rolled** and is suggested as your plan after the game. It only counts toward a build's record once you confirm the check-in.",
      ],
    },
    { type: "heading", text: "If it doesn't spin", anchor: "troubleshooting" },
    {
      type: "list",
      items: [
        "Check that the Randomizer widget is open, this exact matchup is enabled, and its saved pool contains at least one eligible build.",
        "The matchup must be concrete. Random or unresolved races wait; finished games, replays, team games and games against the computer do not trigger a current-game widget draw.",
        "The paired desktop agent must be running and reporting the current game. Opening Companion's configuration page alone does not perform a roll, and there is no native fallback when the widget is closed.",
      ],
    },
    { type: "settingsLink", label: "Open Settings → Randomizer", href: "/settings?tab=randomizer" },
  ],
  related: ["desktop-companion", "build-check-in", "practice-ghost-build", "obs-overlay-setup", "custom-builds"],
};

export default article;
