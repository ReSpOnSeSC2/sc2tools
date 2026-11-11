import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "randomizer",
  title: "Build randomizer: let a draw pick your build",
  summary:
    "Set a pool for each matchup, roll from the desktop card without OBS, and track your private Randomizer challenge.",
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
  updated: "2026-11-11",
  body: [
    { type: "callout", tone: "info", title: "Agent 0.24.1 and later", text: "Update the [Windows agent](/download) for the check-in Randomize control. The separate widget handles animated reveals and audio. See [Desktop Companion](/help/desktop-companion)." },
    {
      type: "paragraph",
      text: "**Companion → Randomizer** silently configures the shared account settings and shows the saved pick. In the loading check-in, **Randomize** selects and saves one build even without an open widget. The widget uses that same result for animation, sound effects and speech. Native scouting voice is a separate feature and remains available.",
    },
    { type: "heading", text: "Set it up", anchor: "setup" },
    {
      type: "steps",
      items: [
        "Open **Companion → Randomizer** and choose a matchup. Your current concrete matchup is selected when a game arrives.",
        "Turn on **Enable randomizer for this matchup**.",
        "Check the eligible builds and press **Save selected pool**. Turn the matchup switch on or off whenever you want; these changes are saved to your account.",
        "Click **Randomize** in the loading check-in to select a build. Open the **Build randomizer** widget from [Settings → Overlay](/settings?tab=overlay) if you want its animated reveal and audio; the check-in button works when the widget is closed.",
        "For custom weights, search and the animated preview, open [Settings → Randomizer](/settings?tab=randomizer). Leave **Use custom weights** off for equal odds or adjust each weight, then press **Save changes**.",
        "Use the widget's controls for Randomizer visuals, sound effects and spoken results. Companion's Randomizer configuration page is silent; its scouting voice setting does not enable Randomizer speech.",
      ],
    },
    {
      type: "paragraph",
      text: "Terran and Zerg matchups need your own builds: the catalog covers Protoss for now. Make them in your [build library](/builds) (**Build library** in the menu) with the right race and opponent race.",
    },
    { type: "heading", text: "Roll without OBS", anchor: "desktop-roll" },
    {
      type: "steps",
      items: [
        "Turn on **Roll on the desktop card when I'm not streaming** in Companion → Randomizer or [Settings → Randomizer](/settings?tab=randomizer). Leave the Companion's loading card and randomizer assistance enabled.",
        "In a current human 1v1 with an enabled pool and no connected randomizer source, the desktop card shows the saved draw. If you have a loading check-in to answer, your declaration takes priority and the automatic draw waits until play starts.",
        "Choose **Play it** to declare the build, **Reroll** to use the game's one alternate draw, or **Not now** to dismiss the card.",
      ],
    },
    { type: "heading", text: "Randomizer challenge", anchor: "challenge" },
    { type: "paragraph", text: "Open [Practice](/practice#randomizer-challenge) or Settings → Randomizer for each pool's rolls, matching confirmed check-ins, record and progress. **Reset challenge** starts counting from that time and keeps your replays and pools. See [Randomize your practice](/builds/learn#randomize-your-practice)." },
    { type: "heading", text: "Opening Gateway draw (Protoss)", anchor: "gateway-draw" },
    {
      type: "paragraph",
      text: "The Randomizer widget can follow a 1 Gate or 2 Gate build reveal with one opening unit (1 Gate) or two (2 Gate). Each build keeps its own unit odds. Companion only shows the saved build pick; the animated opening-unit sequence belongs to the widget and website preview.",
    },
    { type: "heading", text: "Try it before you go live", anchor: "preview" },
    { type: "paragraph", text: "Reveals respect your device's Reduce motion setting and announce the chosen build to screen readers." },
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
        "The widget respects the loading check-in's decision hold when configured. **Randomize** selects and saves a build directly and releases that hold. The native app does not open a Randomizer animation window or play Randomizer audio.",
        "A build you declared yourself takes priority. A retry, refresh or second connected display reuses the first saved pick for the game. The widget reveals the saved selection instead of choosing a second build.",
        "The drawn build is marked **Rolled** and is suggested as your plan after the game. It only counts toward a build's record once you confirm the check-in.",
        "Every eligible build keeps its configured chance in the draw. Sprite-based reveals animate up to 12 contenders so large pools stay manageable while you play; the saved result and its opening-unit draw remain unchanged.",
      ],
    },
    { type: "heading", text: "If it doesn't spin", anchor: "troubleshooting" },
    {
      type: "list",
      items: [
        "Enable this exact matchup and save at least one eligible build. Unavailable entries are skipped without deleting your preferences. If selection fails, check the message and press **Randomize** again after correcting the pool or connection.",
        "The matchup must be concrete. Random or unresolved races wait; finished games, replays, team games and games against the computer do not trigger a current-game widget draw.",
        "The paired desktop agent must be running and reporting the current game. Opening the configuration page alone does not select a build. Use **Randomize** in check-in; open the separate widget only for its visuals and audio.",
      ],
    },
    { type: "settingsLink", label: "Open Settings → Randomizer", href: "/settings?tab=randomizer" },
  ],
  related: ["desktop-companion", "build-check-in", "practice-ghost-build", "obs-overlay-setup", "custom-builds"],
};

export default article;
