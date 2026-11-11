import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "practice-hud",
  title: "Practice in-game with the desktop HUD",
  summary: "Follow a build from the desktop app while playing, with optional voice cues and no OBS setup.",
  category: "builds",
  audience: "player",
  order: 41,
  keywords: ["desktop", "practice HUD", "Ghost", "voice", "capture", "fullscreen"],
  related: ["practice-ghost-build", "build-check-in"],
  updated: "2026-11-11",
  body: [
    { type: "steps", items: [
      "Open **Companion → Build Order Ghost**. Assign a target for your matchup and turn on **Show Build Order Ghost during matching games**.",
      "Use **Preview Practice HUD** between games. Select **Move Practice HUD**, drag the header, then press **Finish moving** to pass clicks through to the game again. The Windows tray's **Move Practice HUD** action also toggles move mode.",
      "Turn on **Read upcoming steps aloud** if you want a Windows voice cue. You can adjust the lead time, opacity, and size.",
    ] },
    { type: "paragraph", text: "For a 1v1 game the HUD prefers the reference replay for your loading-screen declaration, then your desktop matchup target, then a synced website target. It stays hidden when either player chose Random. Manual team targets are available through the existing Ghost panel." },
    { type: "paragraph", text: "The HUD shows the previous target, the current target and the next two. The countdown follows StarCraft II's game clock. A passed time records where you are on the target schedule. Use the replay after the game to check what you built." },
    { type: "paragraph", text: "The HUD is hidden from Windows screen capture by default. If you want to stream it, turn off **Hide from screen capture** and check your preview. In StarCraft II, use **Windowed Fullscreen** if exclusive Fullscreen covers the HUD." },
  ],
};

export default article;
