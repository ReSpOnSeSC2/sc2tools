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
    { type: "heading", text: "Sorting and finding openers", anchor: "find-openers" },
    { type: "paragraph", text: "The initial rank uses the low end of the likely win-rate range. **Find an opener** ignores case and accents. Sort by Win rate, Games, Played in (the share of games using it), or Trend (the weekly win-rate change). On phones, use **Sort by** above the cards. The original rank stays beside every opener when you sort." },
    { type: "paragraph", text: "**Only openers with a full guide** hides rows whose detailed guide has not met the publication floor. This switch is absent on the archived 8-worker view, whose rows never link to current guides. Popularity arrows show a change in how often an opener is played, measured in percentage points." },
    { type: "heading", text: "12 vs 8 starting workers", anchor: "starting-workers" },
    { type: "paragraph", text: "**12 workers** is the current game. **8 workers (patch 5.0.16)** is an archived era. Individual guide pages cover the 12-worker game, so opener names in the archived table are not linked to guides with different numbers." },
    { type: "heading", text: "Switching matchups", anchor: "matchups" },
    { type: "paragraph", text: "Use the nine matchup links beneath the breadcrumbs. Switching keeps the era and clears the opponent band. For non-mirror matchups, **See it from the other side** flips the perspective; PvZ becomes ZvP. Build pages link back to all openers and the relevant counter guides." },
    { type: "heading", text: "Your own record", anchor: "your-record" },
    { type: "paragraph", text: "Sign in from a guide to return to it afterwards. **See your record with this build** jumps to your results; if you have no matching games yet, follow the upload link. During an outage, **Try again** refreshes the guide, and Help or Report this problem offers another way forward." },
    { type: "heading", text: "Compare yourself with the guide", anchor: "compare-yourself" },
    { type: "paragraph", text: "Sign in to add a **You** column to Key timings. It uses only your own 12-worker games with this build and shows your median beside the community's. **On pace** means inside the middle half of players (p25–p75), **early** means before that range, and **late** means after it. These labels describe timing, not whether a decision was correct. A dash means you have no recorded sample for that milestone." },
    { type: "paragraph", text: "The record line compares your win rate with the community's in percentage points. Ties do not count as decided games. Small timing samples state how many of your games were captured. If your numbers fail to load, use **Retry**; **See all your builds** opens your private build library." },
    { type: "heading", text: "Counter guides and matchup groups", anchor: "counter-guides" },
    { type: "paragraph", text: "In **How to beat** lists, a number is your race's win rate against that opponent opener. **Toughest first** sorts by the top of its likely range, lowest first. Search or choose Most played or A–Z to change the list. Without a new stats run, the existing published-first order remains available. A build guide groups its opponent openers into Favoured, Too close to call, and Unfavoured; expand a group to see beyond its first five rows." },
    { type: "heading", text: "The map pool table", anchor: "map-pool" },
    { type: "paragraph", text: "On [Map guides](/guides/maps), switch **Gallery / Table** when matchup cells are available. Each cell is that row's map win rate for the race on the left of the matchup; PvZ means Protoss against Zerg. Mirrors and cells without enough players or games are omitted. Pick **I play** to show your race's two matchups, find a map by name, or sort a matchup column. Missing cells stay last. The browser remembers this view when storage is available." },
    { type: "paragraph", text: "Build guides keep their best three and toughest three maps. When more than six maps qualify, open **Show all maps** for the complete sortable list. Map names link only when their map guide is available." },
  ], related: ["custom-builds", "rules-explained"],
};
export default article;
