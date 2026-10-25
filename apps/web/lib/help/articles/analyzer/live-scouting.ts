import type { HelpArticle } from "@/lib/help/types";
const article: HelpArticle = {
  slug: "live-scouting", title: "Live scouting on a second screen", category: "analyzer", audience: "all", signedInOnly: true,
  summary: "Read your opponent history during loading, keep a large brief on another screen, and use the stream-safe Dock view.",
  keywords: ["scouting", "second screen", "live", "loading", "opponent", "wake lock", "Scout"], updated: "2026-10-25",
  related: ["today", "opponent-scouting", "desktop-scouting", "stream-dock"],
  body: [
    { type: "heading", text: "Read a loading-screen brief", anchor: "today" },
    { type: "steps", items: ["Keep your paired desktop app running while SC2 loads a human 1v1. Open [Today](/app).", "The live brief expands during loading and the match start. It shows the opponent's available league/MMR, your confirmed record, recorded openings and an existing note. During a game it becomes a one-line bar; press **Brief** to expand it.", "On a wider screen the last five result chips and last three meeting rows show map, length and your build versus their opener. Open a row to review that replay."] },
    { type: "heading", text: "Use another screen", anchor: "second-screen" },
    { type: "paragraph", text: "Choose **Second screen** or open [Live scouting](/app/live). The larger brief stays expanded. **Keep screen awake** requests a browser screen lock while the page is visible. Browser or battery rules can decline it; scouting still works. Turn the button off to let the screen sleep normally." },
    { type: "heading", text: "Interpret the evidence", anchor: "evidence" },
    { type: "list", items: ["**Hatch first · 5 of 7 games** means five games in your existing bounded matchup sample had that label. Unlabelled eligible games stay in the denominator. The top three are recorded frequencies; the cheese warning is a separate recency-weighted share.", "**First meeting** requires a confirmed zero record. An unresolved identity or failed enrichment is shown as pending or unavailable, with Retry; it does not become a zero.", "The card hides after 30 seconds without a fresh update and clears when the match ends. A desktop app, API or network interruption can cause this. Replays and menus do not show a live brief."] },
    { type: "heading", text: "Notes and stream privacy", anchor: "notes" },
    { type: "paragraph", text: "**Open dossier** and **Add note** require an owned record for the exact current opponent account; a new account unlocks these after its first replay syncs. A name-only barcode match cannot unlock another account's note. Text saves atomically preserve the current stored read-aloud choice, including changes made on another screen. A failed or newer draft stays while you edit, including the transition into the game. Notes can appear on your existing scouting Browser Source, so keep them suitable for that use." },
    { type: "paragraph", text: "Stream Dock → **Scout** shows only the stream-safe identity, record and aggregate opening facts already available to overlays. It omits the private note, opponent account identifier, replay rows and editing/dossier links. Use the signed-in Today or second-screen page for those actions." },
  ],
};
export default article;
