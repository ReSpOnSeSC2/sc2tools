import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "maps",
  title: "Maps & the veto planner",
  summary:
    "Compare your record on the current ladder pool, choose vetoes with sample-aware Wilson rankings, and inspect the games behind every map and matchup.",
  category: "analyzer",
  audience: "player",
  signedInOnly: true,
  order: 7,
  keywords: [
    "maps",
    "map stats",
    "map win rate",
    "matchups",
    "pvz",
    "tvz",
    "zvp",
    "map pool",
    "veto",
    "best map",
    "worst map",
    "recent form",
    "map preview",
  ],
  updated: "2026-10-25",
  body: [
    {
      type: "paragraph",
      text: "[Maps](/app/maps) compares your matchups and maps, with a current-pool veto planner above your detailed records. Your stats come from your own synced games. Community comparisons reuse the published map-guide snapshot.",
    },
    { type: "heading", text: "Matchups", anchor: "matchups" },
    {
      type: "paragraph",
      text: "One row per matchup, such as *vs Z*, with your wins, losses, games and win rate. The squares on the right are your last few results in that matchup, oldest to newest: green for a win, red for a loss.",
    },
    { type: "heading", text: "Win rate by map by matchup", anchor: "by-map" },
    {
      type: "list",
      items: [
        "One block per map with your overall record on it, then a row for each matchup you've played there. Edition aliases are combined; numbered maps such as Sanctuary II and Sanctuary III stay distinct.",
        "Sort the maps by **Win rate**, **Games**, **Wins** or **Losses**, and flip the direction with the button next to it.",
        "Click a map name or matchup to inspect its games. Preview map opens a larger map picture.",
        "Current ladder pool only starts on when the pool source and age are fresh. When pool data is fallback, missing or over eight days old, it starts off and warns you. You can still show every historical map.",
        "Your map sort is remembered on this device. A map deep link highlights its row and opens its games, even when its edition suffix differs.",
      ],
    },
    { type: "heading", text: "Using it to pick vetoes", anchor: "vetoes" },
    {
      type: "paragraph",
      text: "The Current ladder pool card ranks maps by the lower end of their 95% Wilson interval. The bottom one to three maps receive Suggested veto. A map needs at least five decided games in the ranking matchup; low-sample maps are never vetoed, even at 0% win rate. Ties and other undecided results do not count in the win-rate denominator or this five-game minimum.",
    },
    { type: "list", items: [
      "Ranking matchup defaults to your most-played opponent race in the sample; a Random race filter defaults to All matchups. This control changes the recommendation while all matchup columns stay visible. The planner compares every opponent race, independently of an opponent-race filter above it.",
      "Choose Filter range, Last 90 days or Current season. Current season needs a measured season start. Other global filters still apply. Set your own race in the filter bar to compare the matching side of the community matchup; mixed-race and unpublished community cells stay unavailable.",
      "Each cell shows wins, losses, the decided sample n and the likely range. Recent form dots refer to the ranking matchup, oldest to newest; form is unavailable when edition variants cannot be ordered reliably. Community numbers show their snapshot date and worker era; their sample window can differ from yours, so a delta is context rather than a controlled comparison.",
      "The pool source, fetch date and age are shown. Stale, missing or fallback pool data disables suggestions and copying until a fresh pool is available. A failed sample refresh also pauses recommendations and offers Retry.",
      "Copy veto list copies only eligible suggestions. If clipboard access is unavailable, a selectable text field appears.",
    ] },
    { type: "heading", text: "Inspect games and compare a map guide", anchor: "map-games" },
    { type: "paragraph", text: "Every pool map and matchup cell, and every detailed map row, opens the latest 100 matching games. The selected sample filters and observed edition aliases are preserved, including when moving between games. The footer's Filter everything to this map applies that exact map cohort to all analyzer sections; clear its Map chip to remove it. Public map guides also offer You on this map: sign in to load your own current-worker-era ranked 1v1 record, choose your race for community comparisons, and open the planner from there." },
    { type: "heading", text: "How much data it needs", anchor: "sample-size" },
    {
      type: "list",
      items: [
        "**Min games** (3 by default) hides matchups and map rows with fewer games. A map shows when at least one of its matchups reaches it, and its overall record still counts every game on it.",
        "The veto table colors samples from five decided games and always shows uncertainty. The detailed historical list retains its own Min games setting; lowering that setting does not weaken the planner's five-decided-game rule.",
      ],
    },
    {
      type: "paragraph",
      text: "Everything here is counted from your replays with fixed rules, never AI. For one opponent's maps, open their [dossier](/help/opponent-dossier).",
    },
  ],
  related: ["trends", "reading-the-charts", "analyzer-filters", "opponent-dossier"],
};

export default article;
