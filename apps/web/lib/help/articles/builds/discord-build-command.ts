import { DISCORD_BUILD_HELP_SLUG } from "@/lib/discordBuildInstall";
import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: DISCORD_BUILD_HELP_SLUG,
  title: "Add the SC2 Tools build command to Discord",
  summary: "Use /build in a Discord server to find published ladder openers for your matchup.",
  category: "builds", audience: "all", order: 26, updated: "2026-11-13",
  keywords: ["discord", "slash command", "/build", "server install", "openers", "matchup"],
  body: [
    { type: "heading", text: "Use the command", anchor: "use-the-command" },
    { type: "steps", items: [
      "A server manager adds SC2 Tools to the server and authorizes its application commands.",
      "In that server, type **/build** and choose one of the nine matchups. The race you play comes first. **PvT** means Protoss against Terran.",
      "Open a build guide from the reply or choose **All openers** for the full matchup page. **Grade my replay** opens SC2 Tools for your own replay.",
    ] },
    { type: "heading", text: "What the reply shows", anchor: "what-the-reply-shows" },
    { type: "paragraph", text: "Only you see the reply. It shows up to five published 12-worker ladder openers, with the snapshot date, win rate, likely range and game count. If the snapshot is unavailable or the matchup has no eligible openers, you still get the matchup guide link." },
    { type: "paragraph", text: "The command uses public guide stats. You can use it without a SC2 Tools account or linking Discord to one. Read the [privacy policy](/legal/privacy#discord-build-command) for details. The same [build guides](/guides) are available on the website." },
  ],
  related: ["build-guides", "reading-guide-stats", "discord"],
};

export default article;
