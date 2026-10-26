import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "glossary", title: "Glossary", summary: "Search plain definitions and measured formulas for macro, MMR, builds and statistics, or browse A to Z.",
  category: "analyzer", audience: "all", updated: "2026-10-26", order: 95,
  keywords: ["definitions", "terms", "jargon", "formula", "macro", "statistics", "builds", "overlay", "Pulse ID", "toon", "barcode", "Net MMR", "verified pairs", "MMR impact", "Group same player"],
  body: [
    { type: "paragraph", text: "Search by a term, words in its definition or its formula. Each entry links to the feature's full explanation. These definitions describe current recorded evidence, including missing-data and sample limits. Start with [Reading your stats](/help/reading-your-stats) to choose the right scope before comparing numbers." },
    { type: "widget", widget: "glossary" },
  ],
  related: ["reading-your-stats", "opponents", "opponent-dossier", "macro", "benchmarks"],
};
export default article;
