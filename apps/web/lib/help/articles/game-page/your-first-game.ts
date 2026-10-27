import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "your-first-game", title: "Your first game breakdown", category: "game-page", audience: "player", signedInOnly: true,
  summary: "Open a recorded game and connect its replay, macro timeline and build orders.",
  keywords: ["first game", "breakdown", "replay", "macro", "build order", "tour"], updated: "2026-10-26", order: 1,
  body: [
    { type: "paragraph", text: "Open one of your games from [Replays](/app/replays). The header identifies the players, map, result and game length. Section links keep the same game loaded while you explore its report." },
    { type: "steps", items: [
      "Start with the battle report and mechanics summary. They point to moments supported by the replay data; an unavailable metric is not a zero score.",
      "Use **Map replay** and the game clock to inspect a moment. Playback coverage depends on the recorded game; older uploads may show an explanation instead of full playback.",
      "Inspect the **Macro** chart and economy breakdown. Selecting a point on the chart keeps you at the chart. Use an explicit replay link when you want to move to the map.",
      "Compare both players' **Builds**. Recorded build steps and detected labels describe the replay. A planned build or opponent correction is a separate choice you can review through **Change build**.",
    ] },
    { type: "paragraph", text: "The game tour explains the controls without changing your build, sending an overlay test or starting an integration. It waits for active check-in work and dialogs to close. [Take a tour](/help/take-a-tour) lets you replay it later." },
    { type: "settingsLink", label: "Full game-page guide", href: "/help/game-page" },
  ],
  related: ["game-page", "battle-reports", "build-check-in", "reading-your-stats", "take-a-tour"],
};
export default article;
