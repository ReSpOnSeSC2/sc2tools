import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "pairing-troubleshooting",
  title: "Pairing problems",
  summary: "Find your current code, confirm the right PC, and understand connection and update badges.",
  category: "desktop-app",
  audience: "all",
  updated: "2026-10-23",
  keywords: ["pair", "code", "expired", "PC", "devices", "unpair", "offline", "online", "update"],
  body: [
    { type: "heading", anchor: "find-a-code", text: "Find the current code" },
    { type: "paragraph", text: "Use the 6-digit code shown in the SC2 Tools window on your PC. Paste it on [Devices](/devices); spaces, dashes, and other separators are removed. A code already filled in from an app link is never submitted automatically. Click **Link this PC**, check the PC details, and confirm." },
    { type: "paragraph", text: "Codes last 10 minutes. If a code has expired, use the current code from the app. An already claimed code cannot link another account. Only link a code displayed on your own PC; a different-network warning is a reminder to check the source, and is not proof that a PC is unsafe." },
    { type: "heading", anchor: "waiting-for-connection", text: "Paired but still waiting" },
    { type: "paragraph", text: "After linking, the page checks for the new app connection every few seconds for up to a minute. **Paired — waiting for the app to check in** means the account link succeeded but the app has not checked in yet. Keep SC2 Tools running and check that the PC can reach the internet." },
    { type: "heading", anchor: "device-status", text: "Online, offline, and update badges" },
    { type: "paragraph", text: "**Online** means the app contacted SC2 Tools within the last three minutes. **Offline** shows when it was last seen; the PC may be asleep or the app stopped. **Update available** appears when the reported version is older than the latest stable release. Open Download to update." },
    { type: "heading", anchor: "another-pc", text: "Another PC or an old account" },
    { type: "paragraph", text: "Each PC gets its own code and appears as its own card. An optional label can distinguish them. Choose **Unpair** on an old PC and confirm in the dialog; that PC stops syncing until linked again. Existing games stay in your account." },
  ],
  related: ["install-and-pair", "my-game-didnt-show-up"],
};
export default article;
