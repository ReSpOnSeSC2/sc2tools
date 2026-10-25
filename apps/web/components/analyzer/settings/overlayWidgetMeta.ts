export interface WidgetMeta {
  id: string;
  label: string;
  hint: string;
  /**
   * The widget is armed by its own URL param instead of the server's
   * enabledWidgets list (which predates it — the toggle endpoint would
   * 400 on the unknown id). The row renders an "always on" badge in
   * place of the server toggle; Test still works.
   */
  urlArmed?: boolean;
  /**
   * The widget is fully self-driven (opens its own data connections)
   * — a synthetic game payload can't exercise it, so the row hides
   * the Test button. Live status is visible in the widget itself.
   */
  noTest?: boolean;
}

export const WIDGETS: ReadonlyArray<WidgetMeta> = [
  { id: "opponent", label: "Opponent identity", hint: "Pre-game dossier — race, MMR, head-to-head" },
  { id: "match-result", label: "Match result", hint: "Victory / Defeat card after the game" },
  { id: "post-game", label: "Post-game build", hint: "Build summary at end of game" },
  { id: "mmr-delta", label: "MMR delta", hint: "± MMR change from this game" },
  { id: "streak", label: "Streak", hint: "Active 3+ win/loss run" },
  { id: "cheese", label: "Cheese alert", hint: "When 40%+ of their recent games vs you opened with cheese" },
  { id: "rematch", label: "Rematch", hint: "Flags when you've played this opponent recently" },
  { id: "rival", label: "Rival", hint: "Frequent-opponent context" },
  { id: "rank", label: "Rank", hint: "Player's league / tier / MMR" },
  { id: "meta", label: "Meta snapshot", hint: "Top openings opponents bring in this matchup" },
  { id: "topbuilds", label: "Top builds", hint: "Your best builds vs this matchup" },
  { id: "fav-opening", label: "Favourite opening", hint: "Their most-used opening vs you in this matchup" },
  { id: "best-answer", label: "Best answer", hint: "Your best counter vs that opening" },
  { id: "scouting", label: "Scouting tells", hint: "Game-start briefing: record, last games, best answer, cheese" },
  { id: "session", label: "Session record", hint: "Today's W-L + your current MMR" },
  { id: "randomizer", label: "Build randomizer", hint: "Spins a weighted random build for each new matchup" },
  {
    id: "ghost-build",
    label: "Ghost Build coach",
    hint: "Tonight's homework — the armed build's next steps synced to the live game, with a drift chip",
    urlArmed: true,
  },
  {
    id: "multichat",
    label: "Multi-platform chat",
    hint: "Twitch + Kick + YouTube + TikTok chat in one feed — set your channels and styling in the Multi-platform chat section below. Test plays a demo chat stream.",
  },
  {
    id: "chat-highlight",
    label: "Chat highlight",
    hint: "Pins a chat message on stream — pick the message from the Stream Dock. Test shows a sample highlight.",
  },
  {
    id: "chat-poll",
    label: "Chat poll",
    hint: "Live viewer poll with !1 / !2 chat voting — start and close polls from the Stream Dock. Test runs a sample poll.",
  },
  {
    id: "chat-alerts",
    label: "Event alerts",
    hint: "Subs, raids, gifts and superchats as an alert toaster — feed and moderation run through the Stream Dock. Test plays sample alerts.",
  },
  {
    id: "stream-goals",
    label: "Stream goals",
    hint: "Animated goal progress bars — set and update goals from the Stream Dock. Test shows sample goals.",
  },
  {
    id: "build-profile",
    label: "Build profile",
    hint: "Five-point build ratings, edited and shown/hidden from the Stream Dock or Build profile section below. Enable here, then add its dedicated Browser Source at 720 × 900.",
    noTest: true,
  },
  {
    id: "series",
    label: "Series scoreboard",
    hint: "Opt in for cups or showmatches. Start Bo1/3/5/7 in the Dock, count matching replays and correct scores manually. Test is a silent sample and never changes your series.",
  },
  {
    id: "session-recap",
    label: "Session recap card",
    hint: "A W-L + net-MMR recap card you fire on demand from the Stream Dock. Test fires a sample recap.",
  },
  {
    id: "countdown-timer",
    label: "Countdown timer",
    hint: "A standalone on-stream countdown you set from the Stream Dock (label + minutes) — pulses TIME! at zero until cleared. Test shows a demo timer.",
  },
  {
    id: "stats-ticker",
    label: "Stats ticker",
    hint: "Always-on scrolling bottom line: session record, latest result, rank, goals, live prediction call, top supporters. Test shows a demo strip.",
  },
  {
    id: "lower-third",
    label: "Broadcast lower third",
    hint: "Esports-caster bar after each game: result, MMR delta, opponent head-to-head, session record. Test fires a sample game.",
  },
  {
    id: "chat-oracle",
    label: "Crystal Ball predictions",
    hint: "Chat calls !win / !loss before each game; the verified result scores oracle points and shows a reveal + leaderboard. Test plays a demo round.",
  },
  {
    id: "supporter-wall",
    label: "Supporter wall",
    hint: "Cross-platform loyalty XP: top supporters with Protoss ranks (Probe → Mothership) and level-up toasts. Test shows sample supporters.",
  },
  {
    id: "clip-flag",
    label: "Clip-moment flag",
    hint: "A small CLIP THAT! pulse when chat spikes or a big game moment lands — the full log lives in the Stream Dock. Test shows the pulse.",
  },
  {
    id: "stream-scene",
    label: "BRB / Starting Soon scene",
    hint: "Full-screen scene with countdown — switch between Live, BRB, and Starting Soon from the Stream Dock. Test shows a Starting Soon demo.",
  },
];
