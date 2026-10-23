import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "rules-explained",
  title: "How build rules are counted",
  summary:
    "A custom build is a list of rules, and a game matches only when every rule passes. What At least, Exactly, At most and None count, why times are deadlines, and how proxy rules work.",
  category: "builds",
  audience: "player",
  keywords: [
    "rules",
    "build rules",
    "at least",
    "exactly",
    "at most",
    "none",
    "at most 0",
    "not before",
    "before",
    "deadline",
    "timing",
    "proxy",
    "proxied",
    "must have",
    "must not have",
    "limits",
    "how rules count",
  ],
  updated: "2026-10-23",
  body: [
    {
      type: "paragraph",
      text: "Each rule names one unit, building or upgrade, how many, and a time. A game matches the build only when **every** rule passes. Each number counts everything of that kind started before the rule's time.",
    },
    { type: "heading", text: "The four kinds of rule" },
    {
      type: "table",
      head: ["Rule", "Passes when", "Listed under"],
      rows: [
        [
          "At least 2 Gateways before 3:00",
          "2 or more Gateways were started before 3:00. *At least 1* means one is enough.",
          "Must have",
        ],
        [
          "Exactly 2 Stargates before 5:00",
          "Exactly 2 were started before 5:00. 1 or 3 fails.",
          "Must have",
        ],
        [
          "At most 1 Stargate before 6:00",
          "0 or 1 was started before 6:00, so games with none pass too.",
          "Limits",
        ],
        [
          "No Robotics Facility before 4:00",
          "None was started before 4:00. One at 4:00 or later, or never, is fine.",
          "Must not have",
        ],
      ],
    },
    {
      type: "paragraph",
      text: "The editor reads every rule back in a sentence as you change it. Community build pages and your build's page list the rules under **Must have**, **Must not have** and **Limits**, with **How rules count** as a quick reminder.",
    },
    { type: "heading", text: "Times are deadlines" },
    {
      type: "paragraph",
      text: "*before 4:20* counts what starts before 4:20 on the game clock: when a building is placed, a unit starts or research begins, not when it finishes. It is a deadline, not the time to build it. A Stargate placed at 3:10 passes *At least 1 Stargate before 4:20*; one placed at 4:30 doesn't.",
    },
    { type: "heading", text: "A 0 means none" },
    {
      type: "paragraph",
      text: "*At most 0* and *Exactly 0* work the same as **None**. *At most 0 Robotics Facilities before 4:20* passes only when no Robotics Facility was started before 4:20, so build pages list it under **Must not have** as *No Robotics Facility before 4:20*, never as something to build.",
    },
    {
      type: "callout",
      tone: "warning",
      title: "Rules that only cap or forbid",
      text: "If every rule is *At most* or *None*, a game where none of it was built still matches, so the build can match almost any game. Add at least one *At least* or *Exactly* rule for something the build must have.",
    },
    { type: "heading", text: "Proxy rules" },
    {
      type: "paragraph",
      text: "Tick **Only count proxied** on a building rule to count only buildings placed away from your main: more than 50 world units from it (80 for town halls, gas and Spine or Spore Crawlers). Build pages mark these rules with a **Proxy** badge.",
    },
    {
      type: "list",
      items: [
        "*At least 2 Gateways before 1:45*, proxied, matches a proxy 2-Gate. Without the tick, two Gateways in your main pass too.",
        "*No Gateway before 4:00*, proxied, rules out a proxy Gateway but still allows Gateways at home.",
        "Only buildings can be proxied. Units and upgrades have no proxy option.",
      ],
    },
    { type: "heading", text: "Several rules for the same thing" },
    {
      type: "paragraph",
      text: "Rules for the same unit or building each count from the start of the game. *At least 1 Stargate before 3:30* plus *At least 2 Stargates before 5:00* means the first Stargate by 3:30 and a second by 5:00. *At least 2 Stargates before 5:00* plus *At most 2 Stargates before 8:00* means two early and no third before 8:00.",
    },
    { type: "heading", text: "Research" },
    {
      type: "paragraph",
      text: "Research starts once per game, so a research rule is either *Blink research before 6:00* (At least 1) or *No Blink research before 6:00* (None). Asking for 2 or more almost never passes.",
    },
  ],
  related: ["custom-builds", "publish-community-builds", "build-check-in"],
  order: 20,
};

export default article;
