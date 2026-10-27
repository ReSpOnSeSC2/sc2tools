import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "sessions",
  title: "How sessions are grouped",
  summary: "Choose when a play session ends and understand the same definition in your live session record, session quizzes and personal Trends.",
  category: "analyzer",
  audience: "player",
  signedInOnly: true,
  order: 11,
  related: ["today", "reading-your-stats"],
  keywords: ["session", "sessions", "inactivity", "gap", "momentum", "first game", "comeback"],
  updated: "2026-10-27",
  body: [
    { type: "heading", text: "What counts as one session", anchor: "definition" },
    { type: "paragraph", text: "A session ends after **more than** your selected number of minutes without another game. An exact gap stays connected. Midnight, timezones and daylight-saving changes label the same instants; they do not split a continuous session. Games without a decided result can connect the games on either side, while win rates still count only wins and losses." },
    { type: "paragraph", text: "Gaps compare the recorded replay end timestamps. Game length is not subtracted. Your own accounts can contribute to the same session; global charts keep separate player contexts." },
    { type: "heading", text: "Choose the gap", anchor: "setting" },
    { type: "paragraph", text: "In [Settings → Profile](/settings?tab=profile), set **A session ends after N minutes without a game** to a whole number from 15 to 480, or clear it for **Auto**. Auto uses 240 minutes when your account has an overlay token, including a revoked token, and 90 minutes otherwise. Revoking or rotating an existing token does not change that default. An explicit saved preference wins." },
    { type: "heading", text: "Read the same definition in each view", anchor: "views" },
    { type: "paragraph", text: "Your live session record, personal Trends Session patterns and the First game/Comeback session quizzes use the selected gap. Personal Trends can still use an explicit analysis override for that request. Global cohort charts keep their own 90-minute or explicit analysis gap. The chart or quiz shows the gap it used." },
    { type: "paragraph", text: "The views keep their own data scope: the live record uses its recent eligible games and manual reset anchor; personal Trends uses the selected filters; Arcade uses your existing complete-history corpus up to its 20,000-game limit. Their totals can differ even with the same gap. Session win-rate differences describe recorded play and do not establish tilt, confidence or a benefit from continuing." },
    { type: "paragraph", text: "If session settings cannot be loaded, retry them from the session quiz. Other Arcade modes can still use their data. Save an updated preference in Profile to refresh the shared definition." },
  ],
};

export default article;
