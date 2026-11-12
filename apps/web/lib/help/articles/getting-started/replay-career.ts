import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "replay-career",
  title: "Read your StarCraft II replay record",
  summary: "See time played, race choices, maps by year, expansion eras and gaps in the ladder replays you choose.",
  category: "getting-started",
  audience: "player",
  signedInOnly: false,
  order: 9,
  keywords: ["career", "replay record", "ladder", "maps", "races", "time played", "replays"],
  updated: "2026-11-12",
  related: ["year-in-review", "instant-analysis", "browser-import"],
  body: [
    { type: "steps", items: [
      "Open [Your StarCraft II career](/career). Drop your replay folder on the page, or choose a folder or replay files.",
      "If you selected files outside an account folder, choose which player is you when prompted.",
      "Choose the same folder again after adding replays. The browser checks which files changed and reuses the summaries of unchanged files.",
    ] },
    { type: "heading", text: "What the record covers", anchor: "coverage" },
    { type: "paragraph", text: "The record counts readable human one-versus-one ladder replays from your selection. Its earliest date and gaps describe those files. Dates and weekdays use UTC. An unsupported old replay, a missing ladder flag or a file you didn’t select can leave a game out. Games resumed from a replay can be included." },
    { type: "heading", text: "What the browser saves", anchor: "storage" },
    { type: "paragraph", text: "Replay files and results stay in this browser. Browser storage holds replay headers and file fingerprints for the last completed scan so a rescan can skip parsing unchanged files. Select **Clear saved replay summaries** to remove this copy. The original files stay in their folders." },
  ],
};

export default article;
