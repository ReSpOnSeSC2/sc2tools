import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "series-mode", title: "Series mode for cups and showmatches",
  summary: "Start a best-of scoreboard, count matching replay results and correct the score from Stream Dock.",
  category: "stream-studio", audience: "streamer", order: 52, updated: "2026-10-25",
  keywords: ["series", "best of", "Bo3", "Bo5", "showmatch", "cup", "scoreboard", "maps", "H2H"],
  body: [
    { type: "paragraph", text: "Series is separate from your ladder session record. Each overlay token has its own series. Opening the Dock does not start one or enable a provider." },
    { type: "heading", text: "Start a series", anchor: "start" },
    { type: "steps", items: [
      "In **Settings → Overlay → Widgets**, enable **Series scoreboard** for the token you use. Keep its All-in-one source loaded, or Copy its dedicated URL into a **640 × 420** OBS Browser Source.",
      "Open **Stream Dock → Series**. The opponent can be filled from the live or last game. Check the name, or type it yourself, then choose **Best of 1, 3, 5 or 7**.",
      "Optionally enter one map per line in playing order. **Use current map pool** fills the existing season catalog; reorder it for your match. Up to 20 names of 100 characters are accepted.",
      "Press **Start series**. Replacing an existing series asks for confirmation and resets only this token's score and replay receipts.",
    ] },
    { type: "heading", text: "Which replays count?", anchor: "matching" },
    { type: "paragraph", text: "Automatic scoring uses a replay's exact recorded **start time**, strictly after you pressed Start. A game already underway when you started the series does not count just because it ends afterward. Replay dates are end times, and game-clock length cannot safely reconstruct wall-clock start at every game speed. Older replays without an exact start stay manual-only." },
    { type: "paragraph", text: "A known account handle takes priority. Two known, different accounts never match just because their names are the same. Otherwise names match exactly ignoring case. A typed-name series pins the first matching replay's recorded account. Ladder and custom games both count. Hidden, deleted, resumed-from-replay and synthetic test games do not." },
    { type: "paragraph", text: "Each game counts once, including across reconnects or token rotation. Ties record a played map without adding a win. At 80 retained replay receipts, automatic scoring pauses rather than forgetting duplicates; use manual correction, then End or start a new series." },
    { type: "heading", text: "Correct and finish", anchor: "controls" },
    { type: "steps", items: [
      "Use **+1** or **−1** beside either score to correct it. Removing a mistaken winning point can reopen a completed series without making an already-counted replay count again.",
      "The first side to the required wins completes the series and shows **Series won/lost**, with one advisory clip moment. Series does not automatically post an announcement or enable chat integrations.",
      "Press **End series** to stop automatic scoring explicitly. The Dock keeps the final score; the overlay hides it. A new Start begins fresh.",
      "If a save cannot be confirmed, check **Refresh series** before trying again. A stale tab cannot overwrite a newer score silently.",
    ] },
    { type: "heading", text: "Read the scoreboard", anchor: "scoreboard" },
    { type: "paragraph", text: "Race icons appear when a counted replay supplies them. Current and next maps follow your chosen map order; a completed series shows its last recorded map. A manually completed score with no replay does not claim a map was played. Recorded lifetime H2H uses your visible local replay history for an exact account, cached briefly; it stays unavailable for a name-only or failed lookup." },
    { type: "paragraph", text: "The optional **!series** chat command uses the shared chat-command settings and cooldowns. It describes the current score and next map; it does not control the series or choose another token." },
    { type: "callout", tone: "info", title: "Preview safely", text: "Preview and Test display a silent sample for about 20 seconds and then restore the real scoreboard. They never start, score, correct or end your real series. During a live game, the existing on-stream Test confirmation still applies." },
  ],
  related: ["stream-dock", "obs-overlay-setup", "multi-platform-chat"],
};
export default article;
