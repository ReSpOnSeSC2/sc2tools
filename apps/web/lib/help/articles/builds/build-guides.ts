import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "build-guides", title: "Build guides: find an opener for your matchup",
  summary: "Compare openers using ladder results, filter by opponent league or MMR, and switch between matchups and starting-worker eras.",
  category: "builds", audience: "all", keywords: ["guides", "openers", "band", "league", "mmr", "8 workers"], updated: "2026-10-23",
  body: [
    { type: "paragraph", text: "[Build guides](/guides) use fixed rules and recorded ladder games. A high win rate from a small sample is less reliable; rankings use the low end of the likely win-rate range." },
    { type: "heading", text: "Filtering by opponent", anchor: "opponent-filters" },
    { type: "steps", items: ["Open a matchup, then find **Opponents** above its opener table.", "Choose **By league** or **By MMR**. These are alternatives: selecting a band replaces the other band. Only bands with enough games appear.", "Use **All opponents** to clear the band while keeping your starting-worker era. The summary above the table always states which opponents and era it counts."] },
    { type: "paragraph", text: "While a filter loads, the table dims and announces the requested openers. If no opener clears the sample floor, choose **Show all opponents**." },
    { type: "heading", text: "12 vs 8 starting workers", anchor: "starting-workers" },
    { type: "paragraph", text: "**12 workers** is the current game. **8 workers (patch 5.0.16)** is an archived era. Individual guide pages cover the 12-worker game, so opener names in the archived table are not linked to guides with different numbers." },
    { type: "heading", text: "Switching matchups", anchor: "matchups" },
    { type: "paragraph", text: "Use the nine matchup links beneath the breadcrumbs. Switching keeps the era and clears the opponent band. For non-mirror matchups, **See it from the other side** flips the perspective; PvZ becomes ZvP. Build pages link back to all openers and the relevant counter guides." },
    { type: "heading", text: "Your own record", anchor: "your-record" },
    { type: "paragraph", text: "Sign in from a guide to return to it afterwards. **See your record with this build** jumps to your results; if you have no matching games yet, follow the upload link. During an outage, **Try again** refreshes the guide, and Help or Report this problem offers another way forward." },
  ], related: ["custom-builds", "rules-explained"],
};
export default article;
