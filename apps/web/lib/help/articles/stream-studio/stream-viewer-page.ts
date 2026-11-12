import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "stream-viewer-page", title: "Stream viewer page",
  summary: "Share delayed results from your current Stream Dock session with viewers.",
  category: "stream-studio", audience: "streamer", signedInOnly: true, order: 14, updated: "2026-11-12",
  keywords: ["stream viewer page", "live results", "broadcast delay", "dock", "browser source"],
  body: [
    { type: "heading", text: "Share the page", anchor: "share" },
    { type: "steps", items: [
      "In [Settings → Profile](/settings?tab=profile), turn on your public player page and save.",
      "Open **Stream viewer page**, turn on sharing, and choose the Browser Source you use for the Stream Dock.",
      "Set the results delay to match or exceed your broadcast delay. The minimum is five minutes.",
      "Save the viewer page, copy its link, and use **Start new session** in that source's [Stream Dock](/help/stream-dock).",
    ] },
    { type: "paragraph", text: "Viewers can see recent wins and losses, opponent races, and known ladder maps. Results appear after the delay, counted from the end of each completed game. The page shows no player names or replay links." },
    { type: "heading", text: "Stop sharing", anchor: "stop-sharing" },
    { type: "paragraph", text: "Clear **Share my stream viewer page** and save. Turning off your public player page or replacing the selected Browser Source also closes the link. To share after replacing a source, choose the new one in Settings and start a session from its Dock." },
  ],
  related: ["stream-dock", "stream-reports", "obs-overlay-setup", "overlay-url-leaked"],
};

export default article;
