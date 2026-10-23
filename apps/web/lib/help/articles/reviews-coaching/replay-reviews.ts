import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "replay-reviews",
  title: "Replay reviews: ask about a moment, answer with pinned comments",
  summary:
    "Post one of your 1v1 games with a question and get answers pinned to exact moments on the replay and the map, from players whose league is checked against their own games. Anyone can read reviews; asking and answering need a free account.",
  category: "reviews-coaching",
  audience: "all",
  keywords: [
    "review",
    "feedback",
    "coach me",
    "karma",
    "verified",
    "league",
    "replay review",
    "review exchange",
    "review board",
    "ask for a review",
    "best review",
    "helpful",
    "upvote",
    "leaderboard",
    "digest",
    "block reviewer",
    "report comment",
    "my reviews",
    "unverified",
  ],
  updated: "2026-10-23",
  order: 10,
  body: [
    {
      type: "callout",
      tone: "info",
      title: "Availability",
      text: "If you don't see **Reviews** in the menu, the Review Exchange isn't available for your account yet. This guide explains how it works when it is available.",
    },
    {
      type: "paragraph",
      text: "The [review board](/reviews) is where players help each other with real games. You post one of your games with a question. Reviewers watch it right on the site and answer with comments pinned to the exact moment, and to a spot on the map when the game has map playback. Anyone can read reviews. Asking and answering need a free account.",
    },
    { type: "heading", anchor: "how-it-works", text: "How it works" },
    {
      type: "steps",
      items: [
        "**Ask about a moment.** Open one of your synced 1v1 games and ask a specific question, like *Why did my push at 7:30 fail?*",
        "**Get answers on the replay.** Reviewers comment at an exact time or over a short range, and can pin a spot on the map. A time written in a comment, like 5:40, jumps the replay there.",
        "**Know who is answering.** Every reviewer shows a league checked against their own ranked games, never typed in by hand. Mark the reviews that helped you, and pick the best one.",
      ],
    },
    { type: "heading", anchor: "asking-for-a-review", text: "Ask for a review" },
    {
      type: "steps",
      items: [
        "On the [review board](/reviews) or in [My reviews](/reviews/mine), press **Ask about one of your games**. Search the game picker, load more if needed, then choose a synced 1v1 game to open the question form here. You can also open a game from [Replays](/app/replays), its own page or an opponent's games and press **Ask for a review**.",
        "Write **your question**, 20 to 500 characters. Name the moment and what you tried: *Why did my blink all-in fail? I hit at 6:00 but the roaches were already out* gets better answers than *What did I do wrong?*",
        "Optionally pick **Focus** tags (build order, macro, scouting, army control, decision making, micro, specific timing) and a **Time range of interest**, like 5:00 to 6:30.",
        "Choose **Who should review**: **Anyone**, **My league or higher** or **Masters+**. *My league or higher* is checked against each reviewer's league, verified from their own ranked games, and compared with the league you played at in this game. Anyone who can review may still reply under a review.",
        "Choose the **Visibility**. **Public board** lists your request on the board. **Link only (not listed)** keeps it off the board and out of search engines, so only people you send the link to can find it.",
        "Choose how you appear. You post as *Anonymous* and your race unless you tick **Show my display name** (set it in [Settings → Profile](/settings?tab=profile) first). Your opponent is never named: they appear as their race and approximate MMR.",
        "Press **Post request**. You land on the request's page, and the bell in the header tells you when reviews arrive.",
      ],
    },
    {
      type: "callout",
      tone: "warning",
      title: "Sharing the replay file",
      text: "**Let reviewers download the replay file** is off by default. The .SC2Replay file contains both players' in-game names and all of the game's chat, yours included, even when you post anonymously. Turn it on only if you're fine with that. You can turn it off later on the request's page, which stops new downloads.",
    },
    {
      type: "list",
      items: [
        "You can post your own 1v1 games only. The game needs its macro breakdown; if the form says it has none yet, resync the game with the desktop app and try again.",
        "You can have up to **3 open requests** at a time and post up to 3 new ones a day, one per game.",
      ],
    },
    { type: "heading", anchor: "finding-requests", text: "Find requests you can answer" },
    {
      type: "list",
      items: [
        "The [review board](/reviews) filters are shareable links. **Race (asker race)** selects the player's side of the matchup; **Matchup** narrows it to one opponent race. **League** filters the asker's league and **Focus** picks a topic. **Unanswered** keeps requests with no reviews.",
        "**Hot** balances recent activity and interest, **New** shows the newest requests first, and **Top** favors requests with helpful answers. Remove an active filter using its chip, or **Clear all** to keep your sort and reset the filters.",
        "**Older requests** moves through the filtered results. **Newest** returns to the start with those same filters. An empty filtered view offers **Clear filters**; it does not mean the whole board is empty.",
        "When signed in, **Requests you can help with** lists games in your verified race's matchups at or below your league. On phones, open the panel above the board; this browser remembers whether you left it open. **See all … requests** opens that race's unanswered board. Until your league is verified, sync ranked games with the [desktop app](/download).",
        "If the game picker has no synced games, install the desktop app and [pair a device](/devices). It offers 1v1 games only. A failed load has a retry action, and asking about a game you already posted explains where its existing request is.",
      ],
    },
    { type: "heading", anchor: "writing-a-review", text: "Write a review" },
    {
      type: "steps",
      items: [
        "Open a request from the [review board](/reviews), or from the board's **Requests you can help with** list. Play or scrub the replay to the moment you want to talk about.",
        "Press **Comment at 5:12** (the button shows the replay's current time). The moment is saved when you start: **Use current time** moves it to where the replay is now, and **End range here** turns it into a range, like 5:12 to 5:40. A range can be up to 5 minutes long.",
        "When the game has map playback, press **Pin a spot on the map** and click the map. The pin shows as a number on the map and next to your comment.",
        "Say what happened and what to do instead, in 10 to 2,000 characters with up to 5 links. **Bold**, *italic*, lists and links work; the comment box shows how. A time like 5:40 becomes a link that jumps the replay there.",
        "Press **Comment at …** to post it. You can **Edit** your comment for 15 minutes after posting, and **Delete** it at any time (deleting also takes back the karma it earned).",
      ],
    },
    {
      type: "paragraph",
      text: "Replies go one level deep: press **Reply** under a review to answer it. The asker's own notes and replies are marked **Asker**.",
    },
    { type: "heading", anchor: "who-can-review", text: "Who can review" },
    {
      type: "list",
      items: [
        "**Reading** is open to everyone, signed in or not.",
        "**Commenting** needs a free account, signed in on the website, and at least **20 games synced** with the [desktop app](/download). Synced games show you really play, and they're what your league is verified from. The asker can always comment on their own request.",
        "**Your league** is verified from your own ranked 1v1 games this season and last. A race needs at least 10 of them, and one lucky game can't lift you a league. Your comments then show it, like *Diamond Zerg (EU)*. Until then they show **Unverified**.",
        "**Requests that ask for a level.** When the asker chose *My league or higher* or *Masters+*, only reviewers whose verified league qualifies can start a review. Everyone who can comment may still reply under one.",
        "**Requests you can help with**, on the board page, lists open requests in your verified race's matchups at or below your league.",
      ],
    },
    { type: "heading", anchor: "karma-and-badges", text: "Karma, badges and the leaderboard" },
    {
      type: "paragraph",
      text: "Reviews earn karma when they help. There are no downvotes: if a review is wrong, say why in a reply, and report it only if it breaks the rules.",
    },
    {
      type: "table",
      head: ["What happens", "Karma"],
      rows: [
        ["The asker marks your review **Helpful**", "+5"],
        ["The asker picks it as the **Best review** (one per request; the request shows as *Answered*)", "+15"],
        ["Another player upvotes it", "+1 each, up to +10 per comment"],
        ["A moderator removes it", "−20, and the karma it earned is taken back"],
      ],
    },
    {
      type: "list",
      items: [
        "**Badges:** *First Review* after your first review, *Helpful ×10* and *Mentor* at 10 and 50 helpful marks, *Best Answer ×10* at 10 best reviews. Your flair combines your verified league with your top title, like *Masters Mentor*.",
        "**This week's top reviewers** on the board ranks the karma earned this week (Monday to Sunday, UTC). You're listed only if you tick **Show my name on the leaderboard** under it. Your karma counts toward your badges either way.",
        "**Weekly digest of open requests in my matchups** sends one notification each Monday listing open requests you could answer. It's on by default once your league is verified; untick it under the leaderboard to stop it. Notifications arrive in the bell in the header; there's no email.",
      ],
    },
    { type: "heading", anchor: "closing-and-sharing", text: "Close a request, stop sharing" },
    {
      type: "list",
      items: [
        "Press **Close request** at the top of your request when you're done. Closing stops new comments and stops sharing your game's analysis (the build order, macro breakdown and map playback reviewers watch). The question and every comment stay readable.",
        "A closed request can't be reopened. To get more answers, ask about the same game again with a new request.",
        "Removing the game from your history closes its request on its own.",
        "To stop sharing the replay file without closing, untick **Let reviewers download my replay file** on the request. New downloads stop right away; files people already downloaded stay with them.",
      ],
    },
    { type: "heading", anchor: "blocking-and-reporting", text: "Block or report" },
    {
      type: "list",
      items: [
        "Every comment has a **⋯** menu (**More actions**). **Report…** sends it to a moderator with a reason: spam, abusive or hateful, off-topic, reveals someone's identity, or other. When three different people report the same comment or request, it's hidden until a moderator looks at it.",
        "Report anything that names or links to the opponent. Reviews must never reveal who they were. A disagreement about strategy isn't a reason to report: reply, or upvote the review you agree with.",
        "**Block reviewer** hides that person's comments from you everywhere and stops notifications about them. They can't reply to your comments or comment on requests you post under your name.",
        "To undo a block, open [My reviews](/reviews/mine), find **Blocked reviewers** and press **Unblock**.",
      ],
    },
  ],
  related: ["install-app", "coaching", "getting-started"],
};

export default article;
