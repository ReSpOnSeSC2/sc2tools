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
      text: "**Save build** keeps your changes. **Save & re-match** also checks your past games against the new rules for that build, so its record includes matching replays.",
    },
    { type: "heading", text: "Private notes vs public description", anchor: "private-notes" },
    { type: "paragraph", text: "Use **Edit** on any build to change its rules and metadata in the rich editor. **Personal notes (private)** are only for you: scouting tells, timings to remember and reminders. They are never published. The **Description** can appear on your Community listing. The notes link in a dossier opens the editor directly at your notes." },
    { type: "paragraph", text: "Closing either editor with unsaved changes asks first. **Keep editing** returns to your draft; **Discard** closes it. Saving keeps your changes, and a failed save leaves the draft available to fix or retry." },
    { type: "heading", text: "Strategy notes and skill level", anchor: "strategy-notes" },
    { type: "paragraph", text: "The **Build definition** card beside Personal notes shows your match rules, **Wins by**, **Loses to**, **Transitions into** and **Skill level**. Empty rows stay hidden. Its pencil opens the editor. Older signature builds keep matching by their signature until you add rules from their timeline." },
    { type: "heading", text: "Reading a build's page", anchor: "reading-a-build" },
    { type: "paragraph", text: "The full page's **Overview**, **Army**, **Matchups & maps** and **Games** links jump between its sections. Overview shows your record and average macro; Army shows your compositions and transitions; Matchups & maps compares the opponents and maps you faced. **Recent form** shows your latest results from oldest to newest and a rolling 10-game win rate once enough games exist. Private notes and your definition stay at the top." },
    { type: "paragraph", text: "A new build can show **No games matched this build yet** until matching finishes. Use **Re-match replays** to check your saved replays, **Edit rules** to review the definition, or **Review check-ins** when games await your input. Matching runs in the background; its completion refreshes the page." },
    { type: "paragraph", text: "With fewer than five games, percentages are early signals: **Low sample** on a card and the caution on the page mark that small sample. The games list shows the latest 50; every stat above still uses all matched games. Use the result and race filters, sortable table headings, the date disclosure for a build order, or **Open game** for its full analysis. Replay-resume tests stay in a separate optional group and never count in stats." },
    { type: "paragraph", text: "Click any strategy label to see the rule that produced it, or browse [Build definitions](/definitions). The catalog groups rules by race and matchup; search and filter links keep their selections, and a link to a specific rule reveals and focuses that entry." },
    { type: "heading", text: "Make a variant with Duplicate", anchor: "duplicate" },
    { type: "paragraph", text: "Open a build's **⋯** menu and choose **Duplicate**. A new private draft keeps the original's rules, strategy notes, private notes and source replay. Its name ends in **(copy)**; change it before saving if you like. Saving creates a separate build with its own record. If that name already exists, choose another name and save again; the original is preserved." },
    { type: "heading", text: "Publish, update and unpublish a Community listing", anchor: "community-listing" },
    { type: "paragraph", text: "Choose **Publish…** for a private build or **Update listing** for one already shared. The **⋯** menu has **View on Community**, **Copy public link** and **Unpublish** for a public build. Unpublish removes its Community listing while keeping your private copy, stats and notes. **Delete** removes the private build and its Community listing. See [Publish and reuse community builds](/help/publish-community-builds)." },
    { type: "heading", text: "Re-match replays" },
    {
      type: "paragraph",
      text: "Use **Re-match replays** in your library to check every saved replay against your current build rules again. It runs in the cloud, so you can leave the page while it works. The progress line shows replays checked, and the completion message tells you how many games matched and how many old matches were removed.",
    },
    {
      type: "paragraph",
      text: "Some games may wait for replay data. Their existing matches stay safe: re-sync the desktop app to repair missing analysis, then try re-matching again. A stopped job has a **Try again** button; an Error ID helps support find the failure.",
    },
    {
      type: "paragraph",
      text: "Search and matchup filters stay in the page URL. **Clear filters** widens the list, while keeping your chosen sort. Returning from a build restores the library page when its saved cursor is still valid; an expired cursor starts safely at page one.",
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
