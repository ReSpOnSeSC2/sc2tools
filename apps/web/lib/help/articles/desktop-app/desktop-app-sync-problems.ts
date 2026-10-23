import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "desktop-app-sync-problems",
  title: "Why isn't my game syncing?",
  summary: "Understand the desktop retry banner, find a rejected replay's details, and resume safely.",
  category: "desktop-app",
  audience: "all",
  updated: "2026-10-23",
  keywords: ["sync", "offline", "server busy", "retry", "rejected", "upload", "connection", "rate limit"],
  body: [
    { type: "heading", anchor: "offline", text: "Offline" },
    { type: "paragraph", text: "**Offline: 312 replays waiting, retrying in 30 s** means the desktop app cannot reach SC2 Tools. Your queued replays are kept. Check the PC's internet connection and leave the app running. **Retry now** skips the current pause; otherwise the retry pauses grow up to five minutes. A successful connection check wakes the waiting uploads automatically. Newly completed games keep their priority lane." },
    { type: "heading", anchor: "server-busy", text: "SC2 Tools is busy" },
    { type: "paragraph", text: "The service may be processing other replays or temporarily unavailable. The app keeps the batch and retries with longer pauses. This is a connection state, not a failed replay, so it does not fill Recent uploads with duplicate errors. Pause and Resume still follow your chosen sync range." },
    { type: "heading", anchor: "rate-limited", text: "Sync is taking a short break" },
    { type: "paragraph", text: "The service asked the app to slow down. Leave it open and it will resume automatically. Repeatedly clicking Retry now does not make a rate limit end sooner." },
    { type: "heading", anchor: "signed-out", text: "This PC needs to be linked again" },
    { type: "paragraph", text: "If the PC was unpaired on the website, the desktop window offers **Link again** once it confirms the unlink. Queued uploads wait without being discarded. Follow [Pairing problems](/help/pairing-troubleshooting#this-pc-was-unlinked) to link the PC again. A single failed request never erases your saved link." },
    { type: "heading", anchor: "rejected", text: "A replay could not be accepted" },
    { type: "paragraph", text: "A permanent outcome appears once in **Recent uploads**, with a readable title. Hover over its status for the technical detail, or choose **Copy details** to include it in a support report. **Help** opens this explanation. An oversized or unsupported replay cannot be fixed by repeatedly retrying it. A replay marked **Outside your selected sync range** was intentionally excluded; change the range in Settings if you want to import it." },
    { type: "heading", anchor: "file", text: "Waiting for a replay file" },
    { type: "paragraph", text: "StarCraft II may still be writing the file, or the folder may be temporarily inaccessible. Wait for the game to finish saving and check that the watched folder is readable. Keep the original replay on the PC. The app retains the pending upload while the file is unavailable." },
    { type: "heading", anchor: "unknown", text: "Sync could not finish yet" },
    { type: "paragraph", text: "Open **Activity log**, select **Errors only**, and copy the relevant lines. Include the app version and what you clicked when reporting a problem. Temporary failures remain queued; the app only adds a Recent uploads row when a replay reaches a final outcome." },
    { type: "paragraph", text: "After ten minutes with a connection problem and waiting replays, the tray can show one reminder. When the waiting uploads clear, **Back online** reports how many replays synced during recovery." },
  ],
  related: ["pairing-troubleshooting", "my-game-didnt-show-up", "desktop-app-activity-log", "desktop-app-sync-range"],
};
export default article;
