import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "desktop-app-activity-log",
  title: "Find and copy an error from the desktop app",
  summary: "Search the Activity log, keep a traceback together, and copy the useful part when reporting a problem.",
  category: "desktop-app",
  audience: "all",
  keywords: ["activity log", "traceback", "errors", "copy log", "search log", "follow new lines", "support"],
  updated: "2026-10-23",
  order: 30,
  body: [
    { type: "heading", text: "Find the error", anchor: "find-error" },
    { type: "steps", items: [
      "Open **Activity log** in the desktop app and choose **Errors only**. An error keeps its full traceback, including the lines below its timestamp.",
      "Use **Search log** to find a filename or phrase. **Ctrl+F** opens the log and focuses search from any window page. **Enter** or **F3** moves to the next match; add **Shift** to go back. **Esc** clears search.",
      "Select the useful text, then choose **Copy → Copy selection**, or choose **Copy → Copy last 200 lines** for the current filtered view. The button confirms **Copied ✓**.",
      "[Report a problem](/help/report-a-problem) with that text and the time the problem happened. Review the copied text for anything you don't want to share.",
    ] },
    { type: "heading", text: "Read while syncing", anchor: "follow" },
    { type: "paragraph", text: "New entries arrive without replacing the text you are reading. Selecting text or scrolling up pauses **Follow new lines**. The new-lines button jumps to the latest entry and resumes following; reaching the bottom also resumes it. You can turn following off yourself." },
    { type: "heading", text: "Find older entries", anchor: "older-entries" },
    { type: "paragraph", text: "The window keeps a recent, bounded tail so a large log stays responsive. **Open log folder** opens `%LOCALAPPDATA%\\sc2tools\\logs`; the complete log files remain there. A note in the window tells you when older entries were skipped while opening a large file or catching up after sleep." },
  ],
  related: ["desktop-app-overview", "my-game-didnt-show-up", "report-a-problem"],
};

export default article;
