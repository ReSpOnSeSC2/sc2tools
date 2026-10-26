import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "glossary", title: "Glossary", summary: "Search plain definitions of player identity and verified MMR terms, or browse A to Z.",
  category: "analyzer", audience: "all", updated: "2026-10-26", order: 95,
  keywords: ["definitions", "terms", "jargon", "Pulse ID", "toon", "barcode", "Net MMR", "verified pairs", "MMR impact", "Group same player"],
  body: [
    { type: "paragraph", text: "Search by a term or words in its definition. Each entry links to the feature's full explanation. These definitions describe the current replay and account rules." },
    { type: "widget", widget: "glossary" },
  ],
  related: ["opponents", "opponent-dossier"],
};
export default article;
