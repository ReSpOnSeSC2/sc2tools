import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "community-builds", title: "Browse, vote on and report community builds", category: "builds", audience: "all", updated: "2026-10-26",
  summary: "Find builds by race, opponent and skill level, understand vote scores, choose a useful sort, and report a build to the moderators.", keywords: ["community", "vote", "undo", "report", "controversial", "sort", "race", "skill level", "search"], related: ["publish-community-builds", "rules-explained"],
  body: [
    { type: "paragraph", text: "Copy build order puts a plain-text version on your clipboard for notes or a second monitor. Choose the build's **⋯** menu beside Share; see [Reading and exporting build orders](/help/build-orders-export) for every format." },
    { type: "paragraph", text: "**Share link** copies the public build's address. If automatic copying is unavailable or takes too long, **Copy link manually** shows the selected address on the page. Press Ctrl+C or ⌘C, or use your browser's Copy command. **Done** or Escape returns to Share link; the address can also be retried there." },
    { type: "paragraph", text: "Browse [Community builds](/community) without an account. Sign in to vote, report a build or save a private copy to your library." },
    { type: "heading", text: "Find builds", anchor: "finding-builds" },
    { type: "list", items: ["**My race** chooses the race you want to play; **vs** chooses the opponent's race. A build marked **vs Any** appears under every opponent race, because it was published for all of them.", "**Skill level** narrows the list to the author's chosen league. **Any level** also includes builds without a skill label.", "Search matches the build's title, description or public author name. The list shows that it is updating while a filter change loads; your search stays in sync when you clear filters or use Back and Forward.", "The active-filter chips below the controls show what is narrowing the list. Remove one chip, or **Clear all** to keep the chosen sort and reset the filters.", "**Recently updated** puts the most recently revised public builds first. Use the page controls to browse the same filtered list. If an old page link is past the end, **Back to page 1** keeps your filters.", "Filtered URLs can be bookmarked or shared. An old matchup link such as **PvZ** still selects Protoss against Zerg."] },
    { type: "heading", text: "Voting", anchor: "voting" },
    { type: "paragraph", text: "Each account has one vote per build: up, down or no vote. Click the active vote again, or choose **Undo**, to remove it. Switching from an upvote to a downvote moves the net score by two. Your active vote is filled in, and the score updates from the server after saving." },
    { type: "heading", text: "Sorting", anchor: "sorting" },
    { type: "list", items: ["**Top** puts the highest net score first: upvotes minus downvotes.", "**New** sorts by publish date, newest first.", "**Recently updated** puts the latest public revision first, with publication date breaking ties.", "**Controversial** favors a close split of up and down votes with at least four votes. A popular build with only upvotes does not count as divided."] },
    { type: "heading", text: "Reporting", anchor: "reporting" },
    { type: "steps", items: ["Choose **Report**, then pick **Spam or advertising**, **Offensive or abusive**, **Broken or wrong steps**, or **Copied without credit**.", "Optionally add up to 280 characters of details, then choose **Submit report**.", "A moderator reviews the report in the moderation queue. There is one open report per account and build; if you already reported it, the confirmation says so."] },
  ],
};
export default article;
