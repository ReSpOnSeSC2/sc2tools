import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "practice-links",
  title: "Practice a build from a Practice Link",
  summary: "Follow a creator’s video, drill the timed steps or grade one replay locally.",
  category: "getting-started",
  audience: "all",
  order: 10,
  updated: "2026-11-11",
  keywords: ["build order", "practice", "drill", "voice", "replay grade"],
  related: ["instant-analysis", "report-card-links"],
  body: [
    { type: "heading", text: "Watch and Drill", anchor: "watch-drill" },
    { type: "paragraph", text: "Open the creator’s Practice Link. Choose **Play video** to load YouTube. The step list follows playback, and selecting a timed step jumps to that point in the video. In **Drill**, choose **Start drill** to hear the steps a few seconds early. Use the one-second controls to line up the drill with your game clock." },
    { type: "heading", text: "Grade one replay", anchor: "grade" },
    { type: "paragraph", text: "On desktop Chrome or Edge, choose **Grade**, then select one one-on-one replay against a human. Pick your side if asked. Eligible builds have at least six timed structure or upgrade steps from a recorded game. A replay that matches fewer than half the steps gets a build mismatch message. Otherwise you receive a grade from S to D and the first major slip, when one was detected." },
    { type: "paragraph", text: "Check the patch-era warning before comparing timings. Your replay and grade stay on this device. If you choose to share the image, it includes the grade, the public build credit and the Practice Link." },
  ],
};

export default article;
