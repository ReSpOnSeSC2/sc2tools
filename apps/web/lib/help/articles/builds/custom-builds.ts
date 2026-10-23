import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "custom-builds",
  title: "Detected builds vs custom builds",
  summary:
    "Every game gets a build label from fixed rules that come with SC2 Tools. Custom builds are your own definitions, saved privately in your library, with their own record.",
  category: "builds",
  audience: "player",
  keywords: [
    "definitions",
    "build definitions",
    "build labels",
    "detected build",
    "strategy label",
    "classifier",
    "custom build",
    "my builds",
    "build library",
    "save as new build",
    "unclassified",
    "game too short",
    "8 pool",
    "reclassify",
  ],
  updated: "2026-10-23",
  body: [
    {
      type: "paragraph",
      text: "SC2 Tools names the build in every game two ways. **Detected builds** are the labels that come with the app, like *PvZ - Stargate into Glaives*. **Custom builds** are the ones you define yourself and keep in [your library](/builds).",
    },
    { type: "heading", text: "Detected builds" },
    {
      type: "paragraph",
      text: "The analyzer reads each replay and labels your build and your opponent's with fixed rules: the same replay always gets the same label, and no AI is involved. [Build definitions](/definitions) lists every label with the rule behind it, and you can search it or filter by race and matchup.",
    },
    {
      type: "list",
      items: [
        "A label that starts with a matchup (*PvZ - …*) is only used in that matchup. One that starts with a race (*Zerg - 12 Pool*) can show up in any matchup of that race.",
        "**… Macro Transition (Unclassified)** and **… Standard Play (Unclassified)** mean the game reached the mid game without matching a more specific rule.",
        "**… Game Too Short** means the game ended in under 45 seconds, before any build developed.",
        "On patch 5.0.16, which started with 8 workers, pool-first openers use *8 Pool* names (*Zerg - 8 Pool* instead of *Zerg - 12 Pool*). The definitions page lists them under the 12 Pool entry.",
        "Each definition has a link button to share it, and a **Guide** link when a community guide for that build is published.",
      ],
    },
    { type: "heading", text: "Custom builds" },
    {
      type: "paragraph",
      text: "A custom build is your own version of an opener: a short list of rules such as *At least 1 Stargate before 3:30* or *No Robotics Facility before 6:00*. A game matches when every rule passes, and the build's page then shows its record, matchups, maps and recent games. Custom builds are private until you publish one. [How build rules are counted](/help/rules-explained) explains each kind of rule.",
    },
    { type: "heading", text: "Make a custom build" },
    {
      type: "steps",
      items: [
        "**From one of your games.** Open any game and click **Save as new build** on its build order. Click **+** on the steps that define the build, check the live match preview, name it and save.",
        "**From scratch.** In [your library](/builds), click **New build** and add its steps yourself.",
        "**From the community.** Open a build on [Community](/community) and click **Save to my library** for a private copy you can edit. See [Publish and reuse community builds](/help/publish-community-builds).",
      ],
    },
    {
      type: "paragraph",
      text: "**Save build** keeps your changes. **Save & Reclassify** also checks your past games against the new rules, so the build's record includes them. Matching a large library can take a minute.",
    },
    { type: "heading", text: "Which one to use" },
    {
      type: "list",
      items: [
        "Use the **detected builds** to see what you and your opponents played, to compare with other players and to read the community guides.",
        "Use a **custom build** to track your own version of an opener, with your own timings, and to see how it does over time.",
        "Planned a build but the replay was labelled something else? [Build check-in](/help/build-check-in) counts the game toward the build you went for.",
      ],
    },
  ],
  related: ["rules-explained", "publish-community-builds", "build-check-in"],
  order: 10,
};

export default article;
