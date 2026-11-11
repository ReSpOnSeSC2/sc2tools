import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "compare-games",
  title: "Compare two games",
  summary:
    "Put two of your games side by side on one game clock: workers, army, income and supply, the build-order difference step by step, and mechanics.",
  category: "game-page",
  audience: "player",
  signedInOnly: true,
  order: 5,
  keywords: [
    "compare",
    "compare games",
    "side by side",
    "two games",
    "build order diff",
    "build difference",
    "best win",
    "same build",
    "same opponent",
    "same matchup",
    "where did it go wrong",
    "timeline overlay",
  ],
  updated: "2026-11-10",
  body: [
    {
      type: "steps",
      items: [
        "On a game page, press **Compare…** and pick the second game: the best recent win with this build, the previous game against this opponent, the last game in this matchup, or any recent game you search for.",
        "Or, in [Replays](/app/replays), press **Select replays**, tick exactly two and press **Compare 2 games**. The first one you ticked is game A.",
        "The page's address reopens the same pair. It only opens for you, signed in to your account.",
      ],
    },
    { type: "heading", text: "Reading the comparison", anchor: "reading" },
    {
      type: "list",
      items: [
        "Game A is drawn solid and game B dashed. Every Δ is A minus B. **Swap A and B** flips them.",
        "**Timelines**: drag across any chart, or use the slider, to move one cursor through workers, army value, income and supply at once. The numbers beside each chart are both games and their difference at that moment. **View as table** lists every 30 seconds.",
        "**Build-order diff**: steps are paired by name and by how many times they happened, so the second Gateway lines up with the second Gateway. Red means game A got there later, green earlier, and within 5 seconds counts as the same time. **A only** and **B only** mark a step the other game never made. Worker production is left out.",
        "**Mechanics**: macro score, spending quotient (SQ), supply-blocked time, your race mechanic (injects, chronos or MULEs) and APM for both games.",
      ],
    },
    { type: "heading", text: "When something is missing", anchor: "missing" },
    {
      type: "paragraph",
      text: "Each game loads on its own, with its own retry. A game synced without a macro breakdown has no timeline line and shows dashes in Mechanics; a game without a build order leaves its column empty. Nothing missing is ever counted as zero. Run **Re-sync** in the desktop app to read an older game's details again.",
    },
    {
      type: "paragraph",
      text: "Every number comes from the two replays with fixed rules, never AI. The comparison runs in your browser from the same data as each game page.",
    },
  ],
  related: ["game-page", "game-page-replay", "macro"],
};

export default article;
