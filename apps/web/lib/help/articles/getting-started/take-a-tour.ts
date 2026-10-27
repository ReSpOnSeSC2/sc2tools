import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "take-a-tour", title: "Take a tour", category: "getting-started", audience: "all", signedInOnly: true,
  summary: "Take a short tour of Today, a game breakdown or Overlay settings. Replay one whenever you need it.",
  keywords: ["tour", "walkthrough", "getting started", "Today", "game breakdown", "Overlay", "skip", "replay tour"], updated: "2026-10-26", order: 3,
  body: [
    { type: "widget", widget: "guided-tours" },
    { type: "paragraph", text: "Use **Next** and **Back** to explore the visible parts of a page. On a phone, the explanation appears in a bottom sheet. Keyboard focus stays in the tour controls; **Escape** has the same effect as **Skip tour**." },
    { type: "paragraph", text: "Finishing or skipping saves that tour's current version to your account after the server confirms it. If saving fails, retry from the tour. Replaying does not clear your progress. A redesigned tour can be offered once again after its version changes." },
    { type: "paragraph", text: "Tours wait while a dialog or active build check-in is open. A step whose target is unavailable is skipped. If most of a tour's targets are missing, that tour stays closed and is removed from this list for the current layout. Analyzer tables on phones use their Help drawer instead of a tour." },
    { type: "settingsLink", label: "Read your stats", href: "/help/reading-your-stats" },
    { type: "settingsLink", label: "Your first game breakdown", href: "/help/your-first-game" },
    { type: "settingsLink", label: "Stream Studio crash course", href: "/stream-studio/learn#crash-course" },
  ],
  related: ["your-first-week", "reading-your-stats", "your-first-game", "obs-overlay-setup"],
};
export default article;
