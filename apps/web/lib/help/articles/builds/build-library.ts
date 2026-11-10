import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "build-library",
  title: "Organize your library",
  summary:
    "Pin builds to the top, tag them, filter by your own or opponent builds, Published and race, and act on many builds at once.",
  category: "builds",
  audience: "player",
  signedInOnly: true,
  keywords: [
    "pin", "pinned", "tags", "tag", "filter", "mine", "opponent captures", "published",
    "select", "bulk", "duplicate", "share code", "randomizer pool", "keyboard shortcut",
  ],
  updated: "2026-11-10",
  body: [
    { type: "heading", text: "Each build's ⋯ menu", anchor: "menu" },
    { type: "list", items: [
      "**Duplicate** opens a copy in the editor as “name (copy)”; it never overwrites a build.",
      "**Practice this** opens practice with the build.",
      "**Add to randomizer pool** adds the build to every [randomizer](/help/randomizer) matchup it fits.",
      "**Copy share code** copies a link anyone signed in can import from. It holds the build's rules, not your notes.",
      "**Pin to top** keeps the build first in every sort; **Unpin** releases it.",
    ] },
    { type: "heading", text: "Filter", anchor: "filters" },
    { type: "list", items: [
      "**All · Mine · Opponent captures** switches between your own builds and the ones you saved from opponents.",
      "**Published** shows only builds listed on Community.",
      "**P**, **T** and **Z** show one race's builds and open its matchups for a closer look.",
      "Tag chips (**#tag**) show builds that carry every selected tag. **Clear filters (n)** resets them all; the filters stay in the page address, so you can bookmark a view.",
    ] },
    { type: "heading", text: "Select many builds", anchor: "bulk" },
    { type: "steps", items: [
      "Choose **Select**, then tap builds to select them (or **Select all on page**).",
      "Use the bar at the bottom: **Tags…** adds or removes one tag, **Add to randomizer**, **Publish** or **Unpublish** (each build in turn, like publishing it alone), **Export**, or **Delete** with one confirmation. Deleted builds can be restored from Recently deleted.",
      "Choose **Done** to leave selection mode.",
    ] },
    { type: "heading", text: "Keyboard", anchor: "keyboard" },
    { type: "paragraph", text: "Press **/** to search and **n** to start a new build (not while typing in a field)." },
  ],
  related: ["custom-builds", "build-history", "build-import-export"],
  order: 21,
};

export default article;
