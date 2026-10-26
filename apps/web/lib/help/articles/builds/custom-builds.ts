import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "custom-builds",
  title: "Detected builds and your Build library",
  summary:
    "Every game gets a build label from deterministic rules that come with SC2 Tools and compatible shared preset policies. Your Build library keeps your own definitions privately, each with its own record.",
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
  updated: "2026-10-25",
  body: [
    {
      type: "paragraph",
      text: "SC2 Tools names the build in every game two ways. **Detected builds** are the labels that come with the app, like *PvZ - Stargate into Glaives*. Your **Build library** holds the builds you define yourself and save privately.",
    },
    { type: "heading", text: "Shared preset updates", anchor: "shared-preset-updates" },
    { type: "paragraph", text: "Administrators can correct preset detection through a versioned shared policy. Compatible desktop engines refresh after healthy heartbeats; browser analysis refreshes before parsing, at most once per minute. Offline engines retain their last verified policy, and older clients retain their released rules until updated. Existing game labels change only when those files are reanalysed. Your matching private custom rules keep priority, including when a private build shares a preset name. A tightened preset that no longer matches becomes Unclassified rather than falling through to its old criteria." },
    { type: "heading", text: "Detected builds" },
    {
      type: "paragraph",
      text: "The analyzer reads each replay and labels your build and your opponent's with deterministic rules. The same replay, rule version and private custom definitions produce the same label; no AI is involved. [Build definitions](/definitions) lists every label with the rule behind it, and you can search it or filter by race and matchup.",
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
    { type: "heading", text: "Your Build library" },
    {
      type: "paragraph",
      text: "A custom build is your own version of an opener: a short list of rules such as *At least 1 Stargate before 3:30* or *No Robotics Facility before 6:00*. A game matches when every rule passes, and the build's page then shows its record, matchups, maps and recent games. Builds in your library are private until you publish one. [How build rules are counted](/help/rules-explained) explains each kind of rule.",
    },
    { type: "heading", text: "Create your first build (4 ways)", anchor: "create" },
    {
      type: "steps",
      items: [
        "**From one of my games.** In [your library](/builds), choose **New build → From one of my games**, select your race and opponent race, then pick a replay. Only its build order is loaded. You can also open any game and click **Save as new build** on its build order. Click **+** on the steps that define your build.",
        "**From a detected build.** Choose a catalog label and a replay with that stored build label (including confirmed check-ins). Its name, race and matchup prefill your variant. **Make my own variant** on [Build definitions](/definitions) opens this path directly. Your private variant does not change the analyzer’s built-in rules.",
        "**Blank build.** Choose **New build → Blank build**, name it and add your rules. Search friendly unit, building and upgrade names; selecting a result stores its exact action token. Choices follow your race, and eligible buildings show **Proxy eligible**. An unknown action stays visible with an error and blocks preview and saving until corrected.",
        "**Copy a Community build.** Open a build on [Community](/community) and click **Save to my library** for a private copy you can edit. See [Publish and reuse community builds](/help/publish-community-builds).",
      ],
    },
    {
      type: "paragraph",
      text: "**From a pasted build order** previews supported time/supply formats and opens a private reference plan. See [Write or paste a build order](/help/build-order-paste). Every create and edit path uses the same rich editor, with **How rules count** and its worked-example Help link. In an action picker, use Arrow keys, Home/End and Enter to choose; Escape closes the list first, and Tab continues through the form.",
    },
    { type: "paragraph", text: "If making a detected variant asks you to sign in, the public Definitions page keeps the selected catalog label. Choose **Continue private variant** there to open your draft. Returning from sign-in never saves a build automatically." },
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
    { type: "heading", text: "Read your key timings", anchor: "key-timings" },
    { type: "paragraph", text: "Open a build's page and use **Key timings** between Performance and Army. Choose a matchup and **Your timings** or **Opponent timings**. Each row shows its median construction-start time, the middle half of observed times (p25–p75), its earlier/stable/later trend, win rate when that building was recorded, and **n**, the number of timing observations. Win rate uses only decided games; draws and unknown results remain timing observations. Winner and loser medians appear only when both have at least five observations." },
    { type: "paragraph", text: "Timing analysis reads at most the latest **25 eligible games**, using recorded build labels that agree with the build rather than check-ins that named a different detector result. Missing logs reduce the sample. Performance totals still cover every matched game. Click a timing row to inspect only its recorded sample games, including examples older than the recent-games list; **Show all recent games** clears that selection." },
    { type: "paragraph", text: "A **Community** timing and delta appear only for an exact published catalog build in the same guide era and equivalent first construction-start milestone. Private definitions with the same name, mixed or unknown eras, morph-completion milestones and later occurrences have no comparison. The guide link identifies the snapshot. Faster or slower describes a timing difference; it does not establish what caused a win or loss." },
    { type: "paragraph", text: "On an owned game's **Build orders**, a first building occurrence can show **+12s vs your median**, **−8s vs your median** or **Same as your median**. The baseline uses that exact build's cached dossier and matchup. Later repeats, unknown or deleted build identities, missing samples and failed lookups have no chip. Your opponent's column never uses your baseline. Time buttons still seek the shared replay clock." },
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
