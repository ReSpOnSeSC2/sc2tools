import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "build-orders-export", title: "Reading and exporting build orders", category: "builds", audience: "all", updated: "2026-10-23",
  summary: "Compare both players' steps, read approximate supply, and copy, print or download replay data.",
  keywords: ["build order", "supply", "export", "copy", "SALT", "CSV", "JSON", "print", "Markdown"],
  related: ["game-page", "community-builds", "practice-ghost-build", "custom-builds"],
  body: [
    { type: "heading", text: "Read the two build orders", anchor: "reading" },
    { type: "paragraph", text: "Open a game and choose **Builds**. Each row shows time, supply and a step. Choose a step to pause and jump to that moment in the replay. On a wider screen, the two lists align by time and scroll together. **Follow current step** scrolls the list as the replay moves; it starts off." },
    { type: "paragraph", text: "**≈16** means approximately 16 supply, using the last recorded player-stat sample at or before the step. Samples are intermittent, so this is a guide, not exact production supply. **—** means no earlier sample was available. An exact supply value supplied with a step takes precedence." },
    { type: "paragraph", text: "Workers start hidden and supply buildings start visible. Change **Show workers**, **Supply buildings** or **Filter steps** to narrow both lists. The build-column exports copy the visible steps; turn workers on and clear the filter for a complete order. An empty filtered list does not mean the replay has no build events." },
    { type: "heading", text: "Copy or print a build", anchor: "formats" },
    { type: "list", items: [
      "Choose the **⋯** button beside either build. **Copy build order** writes one `[m:ss] supply Name` line per step. **Copy as supply build** puts supply first, with the time at the end.",
      "**Copy Markdown** creates a table for notes. Copied text includes the build title, matchup, author (or Anonymous) and the absolute source link. If clipboard access is blocked, select and copy the text box shown below the menu.",
      "**Copy SALT** encodes supported steps for the SALT StarCraft II arcade map's build-order import. Paste the copied code into the map's import control. Unsupported names and values outside the format's limits appear in an inline skipped-step list; they are never silently clamped. The SALT string carries its own title, author and source fields.",
      "**Print cheat sheet** opens the browser's print dialog with the first 60 steps in a compact sheet. Copy a text format when you need every step of a longer game. The print view hides navigation, sidebar actions and page controls.",
      "**Use as Ghost Build target** uses the existing replacement confirmation and Undo. **Save as new build** opens the build editor, where you can review and save the captured order.",
    ] },
    { type: "heading", text: "Custom and Community definitions", anchor: "saved-builds" },
    { type: "paragraph", text: "The same **⋯** export control appears on custom and Community builds. A rule-only build copies the same condition sentences shown on the page, including exclusions; it does not invent timed production steps. SALT and supply-first copy require timed steps. Older signature definitions include counts and identify their times as deadlines, rather than recorded production times." },
    { type: "heading", text: "Download replay data", anchor: "replay-data" },
    { type: "list", items: [
      "The game header's **Export** menu downloads available data on your device. Missing analysis disables the affected CSV choice; use **Recompute analysis** and retry after the desktop agent finishes.",
      "**Stats CSV** contains time, player side, used/cap supply, workers, banked minerals/gas, mineral/gas income and army value. Missing measurements stay blank, including older replays without army value.",
      "**Casualties CSV** contains the recorded death time, owner, killer, category and name, with additional counts/costs only when present. An empty casualty list produces a header-only CSV; unavailable death data disables the download.",
      "**Full JSON** has `schemaVersion: 1`, the game summary, available build orders and macro breakdown. Filenames include the date, matchup and map. Exports are created in your browser and do not upload a copy elsewhere.",
    ] },
  ],
};
export default article;
