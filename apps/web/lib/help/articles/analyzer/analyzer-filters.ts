import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "analyzer-filters",
  title: "Filters: date, matchup, region and more",
  summary:
    "The filter bar at the top of the analyzer decides which of your games filtered views count. See the defaults, pick a matchup, and find and clear every active filter.",
  category: "analyzer",
  audience: "player",
  signedInOnly: true,
  keywords: [
    "filter",
    "filters",
    "filter bar",
    "date range",
    "season",
    "patch",
    "matchup",
    "vs zerg",
    "vs terran",
    "vs protoss",
    "my race",
    "off-race",
    "region",
    "ladder",
    "custom games",
    "1v1",
    "team games",
    "game length",
    "too short",
    "active filters",
    "chips",
    "reset",
    "clear filters",
    "missing games",
    "games missing",
    "no data",
    "wrong numbers",
  ],
  updated: "2026-10-22",
  body: [
    {
      type: "paragraph",
      text: "The filter bar sits at the top of the analyzer. Opponents and each opponent's page, Strategies, Trends, Macro, Maps, Builds and Replays use these filters. Today includes cards with their own scope, listed below. Arcade and the page for a single game ignore the filter bar.",
    },
    { type: "heading", text: "The defaults" },
    {
      type: "paragraph",
      text: "A new visit counts your **ranked 1v1 ladder games on the current 12-worker patch**, from every region, of any length, with **too-short games hidden**. Too-short games are replays under 45 seconds: disconnects and instant leaves where no build order happened.",
    },
    {
      type: "table",
      head: ["Filter", "Default", "What it does"],
      rows: [
        ["Date range", "After 5.0.17 · 12 workers", "A patch, a ladder season, a quick range such as Last 30 days, or your own dates."],
        ["Matchup", "All", "Only games against one race. **My race** appears when you have games as more than one race."],
        ["Region", "All six on", "Tap a region to hide its games. PTR is the Public Test Realm."],
        ["Maps", "Ladder", "Ranked ladder games, custom and unranked games, or All."],
        ["Players", "1v1", "1v1 games, team games, or All."],
        ["Length", "All", "Games under 10 minutes, 10 to 20, 20 and over, or a custom range."],
        ["Hide too-short", "On", "Leaves out games under 45 seconds."],
      ],
    },
    {
      type: "paragraph",
      text: "Your choices are remembered on this device, so the next visit opens the way you left it.",
    },
    { type: "heading", text: "Pick a matchup" },
    {
      type: "steps",
      items: [
        "In the filter bar, find **Matchup** and choose **vs P**, **vs T** or **vs Z**. Filtered views now count only games against that race.",
        "If you play more than one race, use **My race** next to it to pick yours, for example Zerg and vs P for ZvP.",
        "Choose **All** to see every matchup again.",
      ],
    },
    {
      type: "paragraph",
      text: "With a keyboard, Tab to the matchup and use the arrow keys to move between the choices.",
    },
    { type: "heading", text: "See and clear active filters" },
    {
      type: "paragraph",
      text: "Whenever a filter differs from the defaults, the **Active filters** row under the filter bar shows it as a chip, such as *Opponent race: Zerg* or *Regions: NA, EU*. Views may also have their own search or Min games control. If a number looks too low, check both this row and the controls beside that view.",
    },
    {
      type: "list",
      items: [
        "Select a chip to remove that one filter. It goes back to its default.",
        "Select **Reset to defaults** to put everything back, the date range included, and to clear any picks made in Strategies.",
      ],
    },
    {
      type: "callout",
      tone: "warning",
      title: "Filters picked in Strategies follow you across filtered views",
      text: "When you pick **My build** or **Opp strategy** in Strategies, that filter applies to filtered analyzer views (including Games in range, Opponents, Trends, Maps and Builds) until you clear it. Its chip says *set in Strategies*. These two reset when you reload the page; everything else in the filter bar is remembered.",
    },
    { type: "heading", text: "On a phone" },
    {
      type: "paragraph",
      text: "The date range stays at the top. The other filters sit behind the **Filters** button, which counts the filters other than the date range that differ from the defaults, for example *Filters · 2 active*. Tap it to open them, make your changes (they apply right away) and tap **Done**. The Active filters row works the same as on a computer.",
    },
    { type: "heading", text: "Cards with their own scope" },
    {
      type: "list",
      items: [
        "**Games in range** on Today follows every filter. When filters other than the date apply, its note says how many, for example *12-worker patch · 2 more filters*.",
        "**Win rate** on Today has its own timeframe: pick it from the menu next to its title. It ignores the date range, region, matchup and Strategies picks, and keeps the Maps, Players, Length and Hide too-short filters.",
        "**Games today** and **Active streak** look at today and your latest games, with the same Maps, Players, Length and Hide too-short filters.",
        "**MMR** shows your current ladder rating and ignores filters.",
        "**Daily Pulse** and **Ladder Pulse** use their own recent-game windows and ignore the global filters. **Arcade** also uses its own analysis corpus, without the filter bar.",
      ],
    },
    { type: "settingsLink", label: "Open Strategies", href: "/app/strategies" },
  ],
  related: ["dashboard-and-analyzer"],
};

export default article;
