import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "coaching",
  title: "Coaching workspace (coaches & students)",
  summary:
    "The private workspace a coach shares with their students: linking accounts, the Locker, practice plans counted from synced replays, and booking sessions.",
  category: "reviews-coaching",
  audience: "all",
  signedInOnly: true,
  // Invite-only: explained to the people who use it, not advertised.
  noindex: true,
  keywords: [
    "coach",
    "coaching",
    "student",
    "lesson",
    "locker",
    "private coaching",
    "invite",
    "practice",
    "practice plan",
    "assignment",
    "homework",
    "practice sharing",
    "booking",
    "book a session",
    "availability",
    "schedule",
    "time zone",
  ],
  updated: "2026-10-25",
  order: 20,
  body: [
    {
      type: "paragraph",
      text: "[Coaching](/coaching) is a private workspace for a coach and their students, with three tabs: **Locker** (the coach's notes, builds and materials for each student), **Practice** (practice plans) and **Sessions** (booking lessons). Practice progress is counted from synced replays with fixed rules, and the workspace never grades or scores your play: every judgement is your coach's.",
    },
    { type: "heading", anchor: "roles-and-linking", text: "Who can use it" },
    { type: "paragraph", text: "The header shows your role and your coach or students. For students, a badge on **Practice** marks sharing requests waiting for an answer. For coaches, it counts players behind their active plan's schedule pace. **Sessions** shows unread booking alerts, and a warning dot marks unpublished availability changes. Use the arrow keys, Home or End to move through the workspace tabs." },
    {
      type: "list",
      items: [
        "Coaching is **invite-only**; there's no sign-up for it. A coach adds each student in the Locker by picking the student's sc2tools.com account, found by the email the student signed up with. Coaches themselves are added by the site's admin.",
        "Everyone signs in with their normal sc2tools.com account. Students need the [desktop app](/download) for their games to sync and count; without it, games can still be sent to the coach with **Submit replays** in the Locker.",
        "**Seeing a “Private coaching” screen?** The account you're signed in with isn't attached to a coach. Check that you're signed in with the account your coach added, or send your coach the email you signed up with.",
      ],
    },
    { type: "heading", anchor: "locker", text: "The Locker" },
    {
      type: "paragraph",
      text: "Each student has a private locker that only they and their coach can see. Questions and chat stay wherever you already talk to your coach.",
    },
    {
      type: "list",
      items: [
        "**Students:** *This week* leads with one focus from your coach: one thing to do and one question to ask yourself after each game. *My builds* holds the openers your coach assigned, with build orders and benchmark timings. *My shelf* collects session notes, voice memos, videos and marked-up screenshots, newest first. Answer any waiting worksheet before your next session.",
        "**Coaches:** pick a student in the left rail, then use **Weekly focus**, **Performance**, **Worksheets**, **Builds**, **Shelf** and **Inbox**. The Inbox lists the games your student picked or sent for review. The Locker's **?** button reopens its walkthrough and its own help, including backups of the whole Locker.",
      ],
    },
    { type: "heading", anchor: "practice-sharing", text: "Practice sharing (the student's consent)" },
    {
      type: "paragraph",
      text: "Before a coach can assign practice plans or look at a student's games, the student has to agree.",
    },
    {
      type: "steps",
      items: [
        "The coach opens **Practice**, picks the student and presses **Request approval**. The student's account must be attached in the Locker first.",
        "The student opens **Practice** and sees **Review practice sharing** with the coach's name. **Allow sharing** agrees; **Not now** declines, and the coach can ask again later.",
        "With sharing on, the coach can assign plans and see the student's ranked 1v1 record in the Locker's **Performance** view. For each game that counts toward a plan, the coach sees its map, opponent, result and detected build, and can download the archived replay.",
      ],
    },
    {
      type: "paragraph",
      text: "To stop, the student presses **Revoke access** on the Practice tab, and the coach loses access right away. Allowing again later starts a new sharing period; games from the earlier plans stay private.",
    },
    { type: "heading", anchor: "practice-plans", text: "Assigning practice plans" },
    {
      type: "paragraph",
      text: "The coach sets a plan with **Assign games**. Each plan counts games from the student's synced replays with fixed rules, so nobody types in a number and nothing is self-reported.",
    },
    {
      type: "table",
      head: ["Plan", "What counts", "When"],
      rows: [
        [
          "**A specific build**",
          "Games where the replay matched that build: one of the student's custom builds, or an exact detected style name",
          "One target across the dates you pick",
        ],
        ["**Total 1v1 games**", "Every 1v1 game that qualifies", "A target per day, week or month, repeated across the dates you pick"],
      ],
    },
    {
      type: "list",
      items: [
        "**Only 1v1 replays count**, ladder or custom. Team games, FFA and resumed replays are left out automatically.",
        "**The player's time zone.** The coach picks it when assigning. Days, weeks and months start and end on the player's local calendar, so a late-night game counts on the day the player played it.",
        "**Progress** updates as the desktop app syncs each replay and shows *Starts soon*, *In progress*, *Complete* or *Window ended*. A plan asks for 1 to 1,000 games and can span up to 366 days.",
        "**Cancelling.** The coach presses **Cancel plan**. Its progress and game list stay visible, marked *Cancelled*, and new games stop counting.",
        "**Assign again** opens a new draft from any plan, including cancelled plans. It copies the student, target, build, time zone, title and note. A missing build needs a new selection. Dates start after the old window, or today in the player's zone when that window is past; repeating plans align forward to a period boundary. The inclusive number of calendar days is kept, so a copied monthly window can cross another month. Review the live summary before assigning.",
        "Use **Active**, **Upcoming**, **Ended**, **Cancelled** or **All** above a player's plans. The numbers count plans in that player's permitted history, not games or completed targets. Changing a filter returns to the newest page. Ended plans retain their recorded progress.",
        "Coaches start at **All players**. The roster covers approved practice sharing and sorts players behind schedule first. Select a player to read their full history or request approval from the Player menu. The overview uses at most the newest 100 active plans; a notice and lower-bound counts appear if more exist.",
      ],
    },
    { type: "heading", anchor: "how-progress-is-counted", text: "How progress is counted" },
    { type: "paragraph", text: "Only eligible synced 1v1 replays count, after the plan was assigned. Periods follow the player's time zone, including daylight-saving changes. The period strip marks reached targets in green, past unmet targets in red, the current period with an accent ring, and upcoming periods in a dim style. Select a period to read its recorded count. The streak counts consecutive reached periods ending with the last finished period; the current unfinished period does not add to it." },
    { type: "paragraph", text: "**Behind schedule** compares the current period's recorded games with its target multiplied by the elapsed share of that period, rounded down to a whole game. It is schedule pace, not a grade or a prediction. The roster's last qualifying game is taken from active plans, and its dates are labeled UTC. **Games and replay evidence** shows the full qualifying count and W–L across all pages; its percentage uses wins plus losses, excluding ties. Use **Retry** inside the list after a failed read." },
    { type: "heading", anchor: "sessions", text: "Booking sessions" },
    {
      type: "steps",
      items: [
        "**Coach:** in **Sessions**, choose your **Coaching timezone**, the **Session lengths** you offer (30 minutes to 8 hours) and your **Weekly hours**, then press **Publish availability** in the bar at the bottom. Sessions already booked stay booked when you change your hours later.",
        "**Coach:** **Pause new bookings** stops new bookings without touching booked sessions. **Resume bookings** opens them again.",
        "**Student:** in **Sessions**, pick a **Session length** and an open time under **Available times**. Times are shown in your local time, with your coach's time alongside. Press **Confirm booking**, and the session appears under **Your upcoming sessions**.",
        "**Either side** can press **Cancel session** on an upcoming session. The other person sees the change, and the time opens up for booking again.",
      ],
    },
    { type: "paragraph", text: "Unpublished changes are kept while you switch tabs. **Publish availability** saves them; **Reset** restores the published hours. The warning dot on Sessions stays until you publish or reset. Booked sessions always show in your saved coaching time zone, so changing the draft zone does not move existing bookings." },
  ],
  related: ["install-app", "replay-reviews"],
};

export default article;
