import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "instant-analysis",
  title: "Analyze in your browser",
  summary: "Try a private replay report, see a real example, follow opener guides and choose what to include in a shareable image.",
  category: "getting-started", audience: "all", order: 5,
  keywords: ["try", "instant analysis", "share report", "sample report", "PNG", "no download", "guide", "browser"],
  updated: "2026-11-11",
  body: [
    { type: "paragraph", text: "When Instant Analysis is available, open [Analyze your replays](/try). Pick replay files, a zip or a folder. The analyzer scans the selection and analyzes up to 25 1v1 games, newest first. A game resumed from a replay can use an analysis slot before it is skipped. Choose your player when asked. Keep the tab open while the report is prepared. Your replay files stay on this device." },
    { type: "heading", text: "The home-page build editor demo", anchor: "home-demo" },
    { type: "paragraph", text: "When the private home-page demo is available, it shows the selected replay's name and size while preparing and reading it. Nonempty small files keep a readable size in B or KB; larger files use MB. If analysis fails, **Try again** retries that replay, while **Choose another replay** opens the file picker. **Cancel** returns to the demo. A browser-analyzer loading failure also offers **Retry analyzer**. The private demo does not upload your replay." },
    { type: "paragraph", text: "If the home-page demo is unavailable, choose **Get the desktop app** to sync and review your replays. If your browser cannot run the analyzer, try a current Chrome or Edge browser or use the desktop app. There is no server-upload fallback for the home-page demo." },
    { type: "heading", text: "See an example first", anchor: "sample" },
    { type: "paragraph", text: "Press **See a sample report** on /try, or the mobile home-page demo, when the button is available. The labelled frame contains real fixture games with names and account identities removed. Missing measurements stay missing. It does not add games to your local history or account. A sample from an older engine is refused; retry or analyze your own files." },
    { type: "heading", text: "Filter your report", anchor: "filter" },
    { type: "paragraph", text: "Filter by opponent race, wins or losses, or recency. Choose the latest 10 or 25 matching games, the last 90 days, or all dates. Every report card and the game list follow the filters. Select a race in **Record by matchup** to filter by that race, or choose **Clear filters** to see every game again." },
    { type: "paragraph", text: "Highlights appear when your games support them. You may see your longest win streak, biggest upset, favorite map or a recurring opponent. The map and game-length cards show where and when you win most often." },
    { type: "heading", text: "Watch a game", anchor: "watch" },
    { type: "paragraph", text: "Select a game in your report and choose **Watch this game** when playback is available. Use **Play** or the position slider. The map draws units and buildings from the positions recorded in your replay. Some movement may be missing. Watching a game does not upload it." },
    { type: "heading", text: "Export your report", anchor: "export" },
    { type: "paragraph", text: "Open **Export**, then choose **Download games (CSV)** or **Copy summary**. The CSV contains your currently visible games and includes opponent names. The shareable summary uses the same filters and omits opponent names." },
    { type: "heading", text: "Share selected report rows", anchor: "share" },
    { type: "steps", items: ["In your report, press **Share report**. Nothing is published by opening the preview.", "Untick any totals, matchup records, best-opener or macro rows you want to omit. The preview and copied text use the same selection.", "Use **Share PNG** if your browser supports sharing image files. Otherwise press **Download PNG** or **Copy text**. The image is 1200 × 630 and includes a link back to /try."] },
    { type: "paragraph", text: "The share card excludes player names, accounts, individual game IDs, maps and replay files. Best opener uses decided win rate among recognized catalog openers with at least three games, breaking ties by sample size and name. It is omitted when unsupported. Win/loss bars use decided games; missing macro scores are omitted. These fixed summaries do not grade your decisions." },
    { type: "heading", text: "Move between your report and guides", anchor: "guides" },
    { type: "paragraph", text: "An opener name links only when its build or counter guide is published for a matchup present in your own replays. A build spanning matchups can have several labelled guide links. Signed out on a guide, choose **analyze your replays in your browser — no download**. The explicit focus link highlights and reveals that opener only when a matching game exists in your report. Ordinary report loading does not trigger this scroll." },
    { type: "heading", text: "Keep or clear the report", anchor: "local-data" },
    { type: "paragraph", text: "Your parsed games stay on this device for seven days when browser storage is available. **Clear local data** removes them. Only the separate **Save these games** action uploads parsed games to your account. Sharing the summary does not upload replays. See [Import replays in your browser](/help/browser-import) for account import and folder sync." },
  ],
  related: ["browser-import", "getting-started", "custom-builds"],
};
export default article;
