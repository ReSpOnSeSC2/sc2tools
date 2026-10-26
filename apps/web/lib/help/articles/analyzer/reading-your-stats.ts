import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "reading-your-stats",
  title: "Reading your stats",
  summary: "Check which games and measurements a number uses, distinguish missing from zero, and read macro, opponent and build results with their sample limits.",
  category: "analyzer",
  audience: "all",
  order: 94,
  updated: "2026-10-26",
  keywords: ["stats", "statistics", "scope", "denominator", "sample size", "missing", "zero", "win rate", "spending quotient", "APM", "planned", "corrected", "check-ins"],
  body: [
    { type: "paragraph", text: "Start with the games behind a number. A timeframe, matchup, account, result rule or missing measurement can change its sample. These statistics come from your replays with fixed rules, never AI. The [glossary](/help/glossary) lists formulas and limits; an About button beside a statistic opens its short definition." },
    { type: "heading", text: "Today: read each card's own scope", anchor: "today" },
    { type: "paragraph", text: "[Today](/help/today) names its own timeframe and coverage. Its Today's session record uses **local calendar today**. That differs from the overlay's [Session record](/help/glossary#overlay-session), which uses a four-hour inactivity gap and a manual reset anchor. Midnight does not itself reset the overlay session." },
    { type: "paragraph", text: "Today's current MMR card can use your current SC2Pulse rating and ignores the shared game filters. Games in range uses the global cohort named by that card. Do not apply an opponent's [Last MMR](/help/glossary#last-mmr) or an overlay session definition to those cards. The [filter guide](/help/analyzer-filters) explains which shared filters a page uses." },
    { type: "heading", text: "Opponents: check identity, results and rating evidence", anchor: "opponents" },
    { type: "list", items: [
      "A [Pulse ID](/help/glossary#pulse-id) identifies a public ladder player; a replay's [toon](/help/glossary#toon) identifies an account. Grouping linked accounts combines their measured sums and counts; it does not average account averages equally.",
      "[Opponent win rate](/help/glossary#opponent-win-rate) is wins divided by wins plus losses. Games can also contain undecided rows, so it is a different denominator. With no decided results the current table shows 0%; that does not mean those rows were losses.",
      "[Net MMR](/help/glossary#net-mmr), [MMR won](/help/glossary#mmr-won) and [MMR lost](/help/glossary#mmr-lost) use verified pairs of ranked games. Missing pair coverage is not a measured zero change. Last MMR can use stored or current fallbacks; it does not prove replay-time rating evidence.",
      "Look for the [sample size](/help/glossary#sample-size). Each [measured average](/help/glossary#measured-average) has its own usable count: missing or invalid values are excluded, and valid zeros remain. Latest known build order means indexed evidence with possibly incomplete coverage, not a guarantee that the replay is currently available.",
    ] },
    { type: "paragraph", text: "See [Opponent columns](/help/opponents#columns) for the exact displayed states. [Vs expected](/help/vs-expected#coverage) uses only eligible games with replay-sourced ratings for both players; a current rating cannot fill a missing historical one. Its rated sample differs from the raw recorded win-rate sample." },
    { type: "heading", text: "Macro: measurements, estimates and missing telemetry", anchor: "macro" },
    { type: "list", items: [
      "[Spending Quotient](/help/glossary#spending-quotient) uses arithmetic sample means from 1:00 onward, flooring each recorded bank to 50. It is not a bounded 0–100 score. Sparse samples can give a neutral fallback of 75; SQ pace tiers are not your ladder rank.",
      "[Macro score](/help/glossary#macro-score) clamps its SQ-based starting value, then subtracts recorded penalties and rounds/clamps the final result to 0–100. Penalty points and estimated mineral costs are separate quantities.",
      "[Supply blocked](/help/glossary#supply-blocked) estimates sampled near-cap time below 200 supply, with at most four seconds credited per qualifying sample. [Float spikes](/help/glossary#float-spikes) counts samples strictly above 800 minerals from 4:00 onward. Neither proves continuous production downtime or separate sustained episodes.",
      "[APM](/help/glossary#apm) needs supported trusted telemetry. Missing APM stays unavailable; use Recompute or Re-sync with a current desktop app to add it where supported. A measured numeric zero in SQ, supply time or float samples remains zero. Higher APM alone does not establish better play.",
    ] },
    { type: "paragraph", text: "[Macro](/help/macro#progress) shows a separate measured-game count for each metric. A league reference needs at least 50 usable measurements for its metric and describes the opponent's recorded league bracket. Your usual, private build timing and league comparisons have different eligibility and minimum samples; the [benchmark guide](/help/benchmarks) explains them. A p25–p75 range describes spread, while a Wilson interval describes win-rate uncertainty." },
    { type: "heading", text: "Builds: distinguish the detected build from your plan", anchor: "builds" },
    { type: "list", items: [
      "[Planned](/help/glossary#planned-build) means your label comes from an applied confirmed check-in, even when the detector agrees. [Corrected](/help/glossary#corrected-build) marks an applied opponent correction. The marker's explanation keeps detector evidence visible.",
      "[Build W–L](/help/glossary#build-record) counts decided wins and losses. [Build stats WR](/help/glossary#build-stats-win-rate) instead divides wins by all matching records, including tied or unknown results. Do not reuse the Opponents denominator for it.",
      "[Counted check-ins](/help/glossary#counted-checkins) counts games assigned only because a confirmed applied check-in changed the detected name or custom-build identity. It does not mean every confirmed plan. Private owner views can apply plans; public build aggregates keep detector-only labels.",
    ] },
    { type: "paragraph", text: "Use [Build check-in](/help/build-check-in) to understand label sources and [Build stats](/help/builds#table) for its cohort. Historical rates, a higher pace or a comparison with expected wins do not establish what caused an outcome or promise future wins. Open the games behind a sample before treating a change as progress." },
  ],
  related: ["glossary", "today", "analyzer-filters", "opponents", "macro", "builds", "build-check-in", "benchmarks", "vs-expected"],
};

export default article;
