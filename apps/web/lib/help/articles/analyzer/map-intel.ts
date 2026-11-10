import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "map-intel",
  title: "Map intel heatmaps",
  summary:
    "See where opponents proxy, where your fights happen, where you lose units and where you build on each map, from your own analyzed games.",
  category: "analyzer",
  audience: "player",
  signedInOnly: true,
  order: 8,
  keywords: [
    "map intel",
    "heatmap",
    "proxy",
    "proxies",
    "fights",
    "battles",
    "where i lose units",
    "death zone",
    "buildings",
    "hot zones",
    "spatial",
    "map positions",
  ],
  updated: "2026-11-10",
  body: [
    {
      type: "paragraph",
      text: "Map intel draws positions from your own games over the map's top-down layout. Open it with **Map intel** on any map row in [Maps](/app/maps), or with **Where they proxy / fight on this map** under a map in an opponent's [dossier](/help/opponent-dossier). It is private: only you see your games, and an opponent's view uses only the games you played against them.",
    },
    { type: "heading", text: "The layers", anchor: "layers" },
    {
      type: "list",
      items: [
        "**Their proxies**: structures your opponent built far from their main base, such as a hidden Gateway or a forward Barracks. A normal third base is not a proxy.",
        "**Fights**: the centre of each large army engagement.",
        "**Where you lose units**: fights where you lost more army value than your opponent, placed where your army died.",
        "**Your buildings**: where you placed your own structures, useful for checking walls and pylon spots.",
      ],
    },
    {
      type: "paragraph",
      text: "One layer shows at a time. Brighter, more solid heat means more positions there. The legend reads fewer to more, and the numbered rings on the map match the **Top hot zones** list under it. Each hot zone is named by the nearest base (main, natural or third, found from where you placed your town halls) and the part of the map it is in, with its share of the layer and how many games it appeared in. Use **Heat opacity** to see the terrain underneath. On Maps you can also narrow the view to one opponent race.",
    },
    { type: "heading", text: "How much data it needs", anchor: "sample-size" },
    {
      type: "list",
      items: [
        "The caption says what the heat is made of, for example *Fights in 12 of 37 analysed games*. It reads at most your latest 300 games with map data on that map and says so when there are more.",
        "A map-wide layer needs at least 3 games with positions before it shows a pattern; below that you see the count instead. An opponent's view shows every game you have against them, even one, because one game is still a fact about that player.",
        "Your analyzer filters apply, so a date range or patch filter changes the sample. Edition variants of a map are combined, as in the rest of Maps.",
      ],
    },
    { type: "heading", text: "Why some maps are empty", anchor: "empty-maps" },
    {
      type: "paragraph",
      text: "Positions come from replays the desktop app analyzed. A map shows *No spatial data for this map yet* when none of your games on it carry positions: games uploaded before the desktop app recorded positions, games imported without the desktop app, or a map you have not played yet. Fights and lost fights also need games long enough to have a real engagement.",
    },
    { type: "heading", text: "How to re-analyze", anchor: "re-analyze" },
    {
      type: "steps",
      items: [
        "Update the [Windows agent](/download) to the latest version.",
        "In the desktop app, re-sync your replay history (see [Fix sync problems](/help/desktop-app-sync-problems)). Each re-uploaded game brings its map positions.",
        "Reopen Map intel. New games appear within a few minutes of upload.",
      ],
    },
    {
      type: "paragraph",
      text: "Everything here is counted from your replays with fixed rules, never AI.",
    },
  ],
  related: ["maps", "opponent-dossier", "desktop-app-sync-problems"],
};

export default article;
