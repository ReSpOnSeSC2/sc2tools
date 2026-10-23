import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "strategies",
  title: "Strategies: your builds against their openings",
  summary:
    "Which openings you beat and which beat you, how each of your builds does against each of theirs, and how those results change with MMR.",
  category: "analyzer",
  audience: "player",
  signedInOnly: true,
  order: 4,
  keywords: [
    "strategies",
    "opponent strategy",
    "opener",
    "opening",
    "build vs strategy",
    "matchup matrix",
    "heatmap",
    "best vs",
    "worst vs",
    "my build",
    "opp strategy",
    "win rate by mmr",
    "cheese",
  ],
  updated: "2026-10-23",
  body: [
    {
      type: "paragraph",
      text: "[Strategies](/app/strategies) answers two questions: which of my opponents' openings do I struggle against, and which of my builds is the right answer to each one. Openings are named from the replay with fixed rules, the same names as [Build definitions](/definitions).",
    },
    { type: "heading", text: "Two views", anchor: "views" },
    {
      type: "list",
      items: [
        "**Build vs strategy** (the default): your build on one side, their opening on the other, with your record for each pairing. Show it as a **table** or a **heatmap**; greener cells are better for you.",
        "**By opponent strategy**: one card per opening you've faced, with your win rate and record against it. The cards at the top name the opening you've seen most, and your best and worst results.",
      ],
    },
    { type: "heading", text: "Drill in", anchor: "drill-in" },
    { type: "paragraph", text: "Click any linked strategy label to see the rule that produced it, or browse [Build definitions](/definitions). Definitions are grouped by race and matchup; filters stay in the URL, and a direct link reveals the selected rule even if your filters hid it." },
    {
      type: "list",
      items: [
        "Click a card, cell or row to see the games behind it. For a build and opening pair you also get a side-by-side of what you typically do and what they typically do. Press **back to strategies** to return.",
        "Use **My race**, **My build**, **Opp race** and **Opp strategy** at the top to narrow the whole analyzer to those games.",
      ],
    },
    {
      type: "callout",
      tone: "warning",
      title: "These picks apply everywhere",
      text: "**My build** and **Opp strategy** filter every section, not just this one, until you clear them. Their chips in the Active filters row say *set in Strategies*. See [Filters](/help/analyzer-filters).",
    },
    { type: "heading", text: "Results by MMR", anchor: "by-mmr" },
    {
      type: "paragraph",
      text: "**Win rate by MMR — opponent strategies** draws one line per opening, with the opponent's MMR along the bottom and the 50% line marking a coin flip. **Build × Strategy heatmap by MMR** shows your build and opening pairings within one MMR range at a time.",
    },
    { type: "heading", text: "How much data it needs", anchor: "sample-size" },
    {
      type: "list",
      items: [
        "**Min games** (3 by default) hides openings and pairings you've seen fewer times. Lower it to 1 to see everything, but treat 1 or 2 games as a hint, not a result.",
        "**Best vs** and **Worst vs** only consider openings that reach the Min games number. *Not enough data* means none do yet.",
        "In the MMR charts, MMR ranges with fewer games than Min games are skipped instead of drawn from a tiny sample.",
      ],
    },
    {
      type: "paragraph",
      text: "Want to track your own version of a build? Make it a [custom build](/help/custom-builds). Planned a build but the replay named it differently? Use [Build check-in](/help/build-check-in).",
    },
  ],
  related: ["builds", "custom-builds", "analyzer-filters", "reading-the-charts"],
};

export default article;
