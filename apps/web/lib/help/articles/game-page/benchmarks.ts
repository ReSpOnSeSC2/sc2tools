import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "benchmarks",
  title: "Benchmarks: your usual and your league",
  summary: "Compare a replay with your earlier ranked matchup games and a cached league distribution, with visible sample sizes.",
  category: "game-page",
  audience: "player",
  signedInOnly: true,
  updated: "2026-10-25",
  keywords: ["percentile", "middle half", "median", "APM", "macro", "spending quotient", "natural", "league", "sample"],
  body: [
    { type: "steps", items: ["Open a game from your replay history.", "Under Mechanics, find Your usual and your league.", "Read each measurement alongside its own sample size. Use Help to check what the band describes."] },
    { type: "heading", text: "Your earlier games", anchor: "your-usual" },
    { type: "paragraph", text: "Your median and middle half use up to 50 of your most recent ranked 1v1 games in the same concrete matchup, strictly before this replay. The current game and later games are excluded. A median is the middle value; the middle half runs from the 25th to the 75th percentile. Missing measurements have their own smaller n and are never treated as zero. These approximate summaries can refresh after a few minutes." },
    { type: "heading", text: "The league band", anchor: "league-band" },
    { type: "paragraph", text: "League distributions are cached tables rebuilt nightly. The bracket comes from the opponent's league recorded on the game: matchmaking makes it a useful proxy, but it is not a claim about your own current league. The row shows the matchup, n and update date. Each strip's band marks that league distribution's middle half; the dot marks this game's percentile." },
    { type: "paragraph", text: "A 62nd percentile means this value sits around 62% of that distribution. Values between stored deciles are interpolated. Below the 10th or above the 90th reads <10th or >90th because the table does not measure the tails precisely. Equal stored values use the midpoint of the tied interval. The 50-game privacy floor applies both to the whole bracket and to every measurement. When the table is missing or below that floor, your personal comparison still appears." },
    { type: "callout", tone: "info", text: "Length is descriptive context. Longer games, higher APM or a higher percentile do not automatically mean better play. The card describes these distributions and does not prescribe a target." },
    { type: "heading", text: "Expansion comparisons", anchor: "expansions" },
    { type: "paragraph", text: "The loss analysis can compare the natural's construction start with your usual timing for the effective build: a confirmed check-in takes priority over the detected label. It uses up to 25 earlier ranked 1v1 games with that build and matchup, skips the starting base, and needs at least five usable natural timings. Missing details or a smaller sample leave this cause unavailable. Other loss-analysis rules still work. Detailed natural, first-gas and first-tech seekable scorecard rows belong to the build execution scorecard." },
  ],
  related: ["game-page", "build-check-in"],
};

export default article;
