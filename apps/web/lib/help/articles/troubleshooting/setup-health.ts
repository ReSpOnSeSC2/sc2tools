import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "setup-health", title: "Check your setup", summary: "Understand the checks on your Account tab and recover one source at a time.", category: "troubleshooting", audience: "player", signedInOnly: true,
  keywords: ["setup", "health", "profile", "online", "offline", "update", "diagnostics", "archive", "checklist"], updated: "2026-10-23",
  body: [
    { type: "paragraph", text: "Open [Settings → Foundation](/settings?tab=foundation) for Setup health. Green checks mean that source reports a working setup. Amber rows need attention; grey rows are optional or still waiting for information. A failed check offers Retry without hiding the other checks." },
    { type: "steps", items: [
      "**SC2 identity:** Set up your player profile if it is missing. This tells the parser which player is you.",
      "**Desktop app:** Online means your paired PC checked in during the last three minutes. If it is offline, open SC2 Tools on that PC. Pair a first or replacement PC from [Devices](/devices).",
      "**Up to date:** Compare the PC's reported version with the latest release. If checking the release server fails, Retry checks again; it does not mean your app is out of date.",
      "**Games synced:** See your game count and latest game time. [Import](/settings?tab=import) an existing library or play a game to populate it.",
      "**Overlay:** A previously seen, active overlay counts as configured. Streaming is optional; this row is hidden when your setup goals exclude it.",
      "**Replay archive:** Follow the warning's action if older games are missing their original replay files. A new check may appear as the service learns to diagnose more problems.",
    ] },
    { type: "paragraph", text: "Use **Copy user ID** to copy your complete cloud identifier. **Copy diagnostics** includes that ID, app version and status, browser/OS, viewport, game count, warning IDs, site version and check time. It leaves out emails, overlay URLs and tokens. If clipboard access is blocked, select and copy the displayed text yourself." },
    { type: "paragraph", text: "The dashboard checklist shows your setup progress and lets you pair inline. Dismiss offers Undo for five seconds. To bring it back later, open [Settings → Misc](/settings?tab=misc) and choose **Show the setup checklist again**. A completed setup may already have no checklist to show." },
  ], related: ["getting-started", "pairing-troubleshooting", "importing-replay-history", "report-a-problem"],
};
export default article;
