import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "community-builds", title: "Browse, vote on and report community builds", category: "builds", audience: "all", updated: "2026-10-23",
  summary: "Understand vote scores, choose a useful sort, and report a build to the moderators.", keywords: ["community", "vote", "undo", "report", "controversial", "sort"], related: ["publish-community-builds", "rules-explained"],
  body: [
    { type: "paragraph", text: "Browse [Community builds](/community) without an account. Sign in to vote, report a build or save a private copy to your library." },
    { type: "heading", text: "Voting", anchor: "voting" },
    { type: "paragraph", text: "Each account has one vote per build: up, down or no vote. Click the active vote again, or choose **Undo**, to remove it. Switching from an upvote to a downvote moves the net score by two. Your active vote is filled in, and the score updates from the server after saving." },
    { type: "heading", text: "Sorting", anchor: "sorting" },
    { type: "list", items: ["**Top** puts the highest net score first: upvotes minus downvotes.", "**New** sorts by publish date, newest first.", "**Controversial** favors a close split of up and down votes with at least four votes. A popular build with only upvotes does not count as divided."] },
    { type: "heading", text: "Reporting", anchor: "reporting" },
    { type: "steps", items: ["Choose **Report**, then pick **Spam or advertising**, **Offensive or abusive**, **Broken or wrong steps**, or **Copied without credit**.", "Optionally add up to 280 characters of details, then choose **Submit report**.", "A moderator reviews the report in the moderation queue. There is one open report per account and build; if you already reported it, the confirmation says so."] },
  ],
};
export default article;
