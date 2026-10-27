import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "your-first-week",
  title: "Your first week",
  summary: "Try a few useful features after your first games arrive. Today suggests steps for your playing and streaming goals.",
  category: "getting-started",
  audience: "all",
  signedInOnly: true,
  order: 2,
  keywords: ["next steps", "suggestions", "checklist", "progress", "goals", "identity", "first game", "first week", "dismiss"],
  updated: "2026-10-26",
  body: [
    { type: "paragraph", text: "Once your first games arrive and initial setup is complete, [Today](/app) shows **Get more out of SC2 Tools**. It suggests four steps for Improve my play, four for Upgrade my stream, or six when you chose both or have not selected a goal. All features remain available whichever goals you chose." },
    { type: "steps", items: [
      "**Add your SC2 identity.** Open [Profile](/settings?tab=profile) and add a SC2Pulse profile or BattleTag. This helps connect your replays with player profiles; the check mark does not certify that a profile is verified.",
      "**Open a recorded game.** Browse [Replays](/app/replays) and open one of your games. Explore its build, replay timeline and macro breakdown. Loading or previewing a link alone does not complete this step.",
      "**Try a build and check-in.** For Improve my play, create a definition in [Builds](/builds), then use [Build check-in](/settings?tab=checkin) to choose your plan for a game. Check-in completes after that plan is confirmed against a recorded game; a draft alone does not count.",
      "**Try Overlay and Chat & alerts.** For Upgrade my stream, open a private link from [Overlay](/settings?tab=overlay) in your stream setup and enable a platform in [Chat & alerts](/settings?tab=chat#platforms). An overlay check mark means a link has connected at least once, including a preview. An enabled-chat check mark describes your saved setting, not a currently connected or broadcasting channel.",
    ] },
    { type: "paragraph", text: "Each step has a shortcut and a **How it works** Help link. Progress refreshes periodically while Today is visible and follows your saved account state, so deleting your only custom build or disabling your chat platforms can make a step available again. This card does not turn on integrations or create overlay links for you." },
    { type: "paragraph", text: "When the suggested steps are complete, the expanded card becomes **You're all set — see What's new**. A completion message appears only when Today observes you finish the remaining steps. Returning with everything already complete does not show another message." },
    { type: "paragraph", text: "Use **Dismiss suggestions** to hide this card for your account. It waits for confirmation from the server; if that fails, the card stays visible with a retry. This dismissal is separate from the first-import setup checklist. Your games, goals and other preferences stay available." },
  ],
  related: ["getting-started", "setup-health", "game-page", "custom-builds", "build-check-in", "obs-overlay-setup", "multi-platform-chat"],
};

export default article;
