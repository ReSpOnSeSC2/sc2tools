import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "game-moment-alerts",
  title: "Game moment alerts",
  summary: "Choose recorded ladder achievements for the Event alerts source, preview them locally and find their timestamps in Stream Dock.",
  category: "stream-studio",
  audience: "streamer",
  signedInOnly: true,
  order: 5,
  keywords: ["ladder", "MMR", "milestone", "season peak", "league", "win streak", "revenge", "giant killer", "marathon", "clip log"],
  updated: "2026-10-25",
  body: [
    { type: "paragraph", text: "Game moments use newly recorded competitive 1v1 replays. They appear as **Ladder** cards in your existing **Event alerts** Browser Source. Subscriptions, raids and other supporter alerts play first; a delayed Ladder card expires after two minutes. Each accepted moment also appears in **Stream Dock → Clips**." },
    { type: "steps", items: [
      "Open **Settings → Overlay → Multi-platform chat** and expand **Game moments** in the event alert settings.",
      "Turn on the achievements you want. Choose each visual and optional sound. Everything starts off and silent; bot posting starts off too.",
      "Use **Test locally** beside a moment. The labelled sample appears in this browser only. It does not save choices, send an OBS event, change a replay or post chat.",
      "Choose **Save chat settings** to apply the draft. Enable Event alerts in the widget manager and copy its URL into an OBS Browser Source. Refresh an already open source once after this update.",
      "Check a newly completed eligible game after saving. Review **Stream Dock → Clips** for its timestamp. Event alert sounds and volume must also be enabled for the selected moment sound to play.",
    ] },
    { type: "table", head: ["Moment", "Recorded evidence required"], rows: [
      ["Recorded MMR milestone", "A higher replay game-start rating crosses a 100 or 250 MMR mark on the same ladder account and race."],
      ["Recorded season peak", "A cached current regional season and complete recorded season coverage, with at least one earlier replay rating on that account and race."],
      ["Confirmed league change", "Two actual Pulse league snapshots in the same season/account/race. The first snapshot establishes a baseline; MMR estimates do not count."],
      ["Five or ten wins", "Exactly five or ten consecutive recorded wins on that account and race. Ties are skipped; unknown outcomes stop the count."],
      ["Loss streak broken", "A win after at least four consecutive recorded losses on that account and race."],
      ["Revenge win", "A win whose previous recorded meeting with the exact opponent was a loss, on that account and race."],
      ["Giant-killer win", "A win against an opponent whose replay game-start MMR was at least 200 higher; both ratings need replay provenance."],
      ["Marathon win", "A win lasting at least 25 minutes."],
      ["Win against an approved streamer", "A win with an approved channel linked to the opponent's exact identity."],
    ] },
    { type: "callout", tone: "info", title: "Recorded MMR is a starting rating", text: "A replay stores the rating at the start of its game. A milestone or peak does **not** claim that this game's win awarded that rating. Missing evidence, unavailable season data or an incomplete bounded history suppresses the corresponding claim." },
    { type: "paragraph", text: "**Post moments through the configured Twitch bot** is optional and uses only your already connected bot. Turning it on does not connect a platform. Several moments from one game share one bounded chat message. Keep it off for overlay and clip-log alerts without bot posts." },
    { type: "paragraph", text: "Historical imports, resumed replays, hidden or deleted games and repeat processing do not trigger moments. Only a new replay recorded within 15 minutes of its game time is eligible. Reopening the source does not replay old moments. **Hide game widgets** suppresses Ladder cards while supporter alerts continue; skipped cards do not return when you resume." },
    { type: "settingsLink", label: "Open Overlay settings", href: "/settings?tab=overlay#chat" },
  ],
  related: ["multi-platform-chat", "viewer-engagement", "stream-dock"],
};
export default article;
