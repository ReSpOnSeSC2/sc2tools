import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "year-in-review",
  title: "Make your StarCraft II year in review",
  summary: "Turn the 2026 ladder replays on your device into a private recap and an aggregate share card.",
  category: "getting-started",
  audience: "player",
  signedInOnly: false,
  order: 8,
  keywords: ["year in review", "2026", "recap", "replays", "ladder", "share card", "browser"],
  updated: "2026-11-11",
  related: ["instant-analysis", "browser-import", "getting-started"],
  body: [
    { type: "steps", items: [
      "Open [Your 2026 in StarCraft II](/wrapped). Drop your StarCraft II folder or choose a folder or replay files.",
      "Wait for the browser to read the replay headers. Use **Cancel** to stop. Download any cloud-only replays to your device if they are slow to open.",
      "If the replays are outside an account folder, choose which player is you. Open **View recap** to see your results.",
      "On the last slide, choose **Share card** to share or save an image of your aggregate results.",
    ] },
    { type: "heading", text: "Which games count", anchor: "games" },
    { type: "paragraph", text: "The recap reads replay files last modified in 2026, then counts the one-versus-one ladder games dated in 2026 (UTC). A replay copied with a new modification date can be missed. Games resumed from a replay can be included." },
    { type: "heading", text: "What stays on your device", anchor: "privacy" },
    { type: "paragraph", text: "The browser reads the replays locally. No account or upload is required. Your card contains aggregate stats and a link to the tool. Use **Clear replays** or close the page to remove the current recap." },
  ],
};

export default article;
