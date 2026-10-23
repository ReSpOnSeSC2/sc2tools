import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "how-analysis-works",
  title: "How SC2 Tools analyses your games",
  summary: "Replay events, fixed build rules, and statistics explain where your numbers come from.",
  category: "analyzer",
  audience: "all",
  updated: "2026-10-23",
  keywords: ["analysis", "rules", "statistics", "AI", "model", "replay", "classification"],
  body: [
    { type: "heading", anchor: "from-your-replay", text: "From your replay" },
    { type: "paragraph", text: "SC2 Tools reads the events recorded in your StarCraft II replay. Build orders, unit timings, actions, spending, and map positions come from those events. A replay can only show what the game recorded, so unavailable fields stay unavailable." },
    { type: "heading", anchor: "fixed-rules", text: "Fixed rules and statistics" },
    { type: "paragraph", text: "Build labels use explicit timing and unit rules. Macro scores use defined measurements. Aggregates count games, and guide ranges describe uncertainty in the sample. These numbers use fixed rules and statistics, never AI or AI API calls." },
    { type: "paragraph", text: "A label can be unclassified when the events do not match a rule. A small sample can change sharply after another game; compare the sample size and filter scope before drawing a conclusion." },
    { type: "heading", anchor: "retired-model-tools", text: "Retired model tools" },
    { type: "paragraph", text: "The unused server model-training and prediction endpoints have been retired. They are not needed to analyse replays, track your builds, or display statistical guides." },
  ],
  related: ["rules-explained", "dashboard-and-analyzer", "something-went-wrong"],
};

export default article;
