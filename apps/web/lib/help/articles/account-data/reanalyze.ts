import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "reanalyze",
  title: "Re-analyze old games after an update",
  summary: "When an analysis update changes build labels, re-analyze the games an older engine labelled, in managed batches, without a full Re-sync.",
  category: "account-data",
  audience: "player",
  signedInOnly: true,
  keywords: ["re-analyze", "reanalyze", "re-parse", "engine update", "old labels", "wrong build", "Blink", "Charge", "Oracle", "Widow Mine Drop", "macro score", "re-sync"],
  updated: "2026-11-10",
  order: 26,
  body: [
    { type: "paragraph", text: "Some desktop agent updates change how games are labelled. Analysis engine 1.6.10 changed PvT Blink and Charge openings, and 1.6.11 changed Oracle-first openings and TvP Widow Mine Drop. Games you uploaded before an update keep the labels the older engine gave them until they are analyzed again." },
    { type: "settingsLink", label: "Open Re-analyze games", href: "/settings?tab=backups#reanalyze" },
    { type: "heading", text: "Choose which games to re-analyze", anchor: "choose" },
    { type: "table", head: ["Group", "What it contains"], rows: [
      ["Analyzed before engine X", "Games in the affected matchups that an older engine labelled. Each group says what changed in that release."],
      ["Missing a macro score", "Games saved without a macro score, for example when it could not be computed at the time."],
      ["Engine version unknown", "Games uploaded before the desktop agent reported its engine version, so their labels may be older."],
    ] },
    { type: "paragraph", text: "A game can appear in more than one group; the counts overlap. Each game page also shows the engine that analyzed it, with a **Re-analyze** link back to this card." },
    { type: "heading", text: "Run it", anchor: "run" },
    { type: "steps", items: [
      "Keep the SC2 Tools desktop agent open and signed in on the PC that has your replays.",
      "In [Settings → Backups & data](/settings?tab=backups#reanalyze), choose a group and select **Start re-analysis**.",
      "The agent re-reads 100 games at a time. It uses the replay on this PC when it is still there, otherwise the copy in your Cloud Replay Archive, and uploads the fresh analysis the same way as a new game.",
      "Watch the progress and time left on the card. Use **Pause** while you play and **Resume** later. **Cancel re-analysis** stops it; games already updated keep their new labels.",
      "Your notification bell tells you when it finishes.",
    ] },
    { type: "callout", tone: "info", title: "Historical stats will change", text: "Re-analyzed games get the current engine's build and opponent-strategy labels, so win rates by build, matchup trends and opponent records include the corrected labels." },
    { type: "heading", text: "If it waits or skips games", anchor: "waiting" },
    { type: "list", items: [
      "**Waiting for your desktop agent**: the agent is closed or offline. The re-analysis continues when it connects again.",
      "**Update your desktop agent**: the connected agent is too old to re-analyze. Install the latest version from the download page.",
      "**No replay file**: the replay is no longer on this PC and is not in your replay archive, so that game cannot be re-analyzed. It keeps its current analysis.",
      "**Failed**: the replay could not be read or uploaded. You can start the same group again later.",
    ] },
    { type: "paragraph", text: "Re-analysis never runs a full Re-sync and never records StarCraft II. Downloaded archive copies are deleted from the PC as soon as they have been read." },
  ],
  related: ["repair-my-data", "backups-and-export", "stay-up-to-date"],
};
export default article;
