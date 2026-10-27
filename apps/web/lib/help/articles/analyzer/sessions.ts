import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "sessions",
  title: "Sessions: review a night of ladder",
  summary: "Review complete sessions, recorded account ratings and games, and choose when your session ends.",
  category: "analyzer",
  audience: "player",
  signedInOnly: true,
  order: 11,
  related: ["today", "reading-your-stats"],
  keywords: ["session", "sessions", "inactivity", "gap", "momentum", "first game", "comeback"],
  updated: "2026-10-27",
  body: [
    { type: "heading", text: "Browse session history", anchor: "history" },
    { type: "paragraph", text: "Open [Sessions](/app/sessions) from the desktop navigation or More on your phone. Your analysis filters define which games can belong to a session. An output day or window selects sessions with a recorded game end in that interval; a cross-midnight session stays complete. The selected timezone labels the dates and gives a day its actual length, including daylight-saving changes." },
    { type: "paragraph", text: "Older sessions in this window continues through complete sessions. Previous output window browses an earlier interval with the same membership filters. Refresh advances a rolling view to include newly played games. A history link keeps its selected scope; changing filters starts a new view. If a replay import or edit changes a session, open a fresh view rather than continuing an old page." },
    { type: "heading", text: "Read a session report", anchor: "report" },
    { type: "paragraph", text: "Cards show recorded game-end times, played time from available replay durations, W/L/unknown results, matchup samples and effective build labels with their planned or detected provenance. Replay-end span is the time between the first and last recorded ends; it is separate from played time. Missing durations, macro scores and ratings stay unavailable, with their sample counts shown." },
    { type: "paragraph", text: "Recorded MMR stays separate for each exact account, queued race and rating scope. Comparable changes require an identified ranked 1v1 track and compare its first and last observed values; one recorded value has no observed change. No rating before the first replay is inferred. If the rating track is not fully identified, its observations remain available without a connected ladder curve or change claim. A missing queued race stays unknown even when the replay shows the race played." },
    { type: "paragraph", text: "Load the recorded MMR chart to inspect the full bounded session for one comparable track. Gaps preserve missing values; the point table pages separately in groups of 50. Games also load a bounded page at a time, and table sorting applies only to that page. Recorded end-to-end gaps include game time and do not measure idle breaks. Chart inspection stays on the report." },
    { type: "heading", text: "Current, last and manual reset", anchor: "current" },
    { type: "paragraph", text: "Today shows This session while its latest eligible game remains inside the gap, otherwise Last session. This fixed live view uses eligible, nonfuture games from the last 14 days after the latest inclusive manual reset. It ignores the global analysis filters. An empty reset view does not bring back games before that reset. Natural session history uses the selected membership filters and does not treat your latest manual reset as a historical event log." },
    { type: "paragraph", text: "Your personal Activity calendar links a selected local day to its complete sessions. Global Activity has no private session-history link. If more context is needed, use Check with more context. A size-limit message means no partial session was presented as complete; even a smaller output window can contain an individual session beyond the supported limit." },
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
