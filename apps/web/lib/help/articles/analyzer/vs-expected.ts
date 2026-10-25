import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "vs-expected", title: "Vs expected: results given who you played",
  summary: "Read opponent-strength-adjusted wins, replay-time rating coverage, performance ratings and win-rate uncertainty.",
  category: "analyzer", audience: "player", signedInOnly: true, order: 11,
  keywords: ["vs expected", "expected wins", "strength adjusted", "performance rating", "MMR", "Wilson", "thin sample"],
  updated: "2026-10-25",
  body: [
    { type: "paragraph", text: "**Vs expected** asks how your recorded results compare with a rating-based baseline, given who you played. Find it in [Build stats](/app/builds), [Strategies](/app/strategies) and [Battlefield](/app/maps). It describes past results; it does not forecast your next game or say that a build caused a win." },
    { type: "heading", text: "A worked example", anchor: "example" },
    { type: "paragraph", text: "Suppose four eligible replays have expected win fractions 0.50, 0.50, 0.25 and 0.25. Their expected wins add to **1.50**. If you won two of those same four games, vs expected is **2 − 1.50 = +0.5 wins**. The chip rounds to one decimal; its tooltip shows the arithmetic, paired-rating count and exclusions. Use the Vs expected control or column header to sort." },
    { type: "heading", text: "Which games count", anchor: "coverage" },
    { type: "list", items: [
      "Only decided ranked 1v1 games with recognized player races and both players' replay-time MMR contribute. Draws, team, custom, AI and resumed games do not enter the adjusted result. Hidden replay contributions are also excluded.",
      "Both ratings must explicitly come from that replay. Current SC2Pulse ratings, an owner's current rating and unproven legacy numbers cannot fill a historical gap. **Rated** is the paired-rating count; missing paired ratings and other exclusions are shown separately in the tooltip.",
      "Raw wins, losses and win rate retain their existing scope. Vs expected uses only wins from the rated subset, so missing historical ratings cannot turn into extra wins above expected. With no eligible paired ratings, the chip shows a dash.",
    ] },
    { type: "heading", text: "The baseline and its assumptions", anchor: "baseline" },
    { type: "paragraph", text: "Before enough corpus evidence is available, the baseline is the standard Elo logistic with scale **400**: 1 / (1 + 10^((opponent MMR − your MMR) / 400)). Equal ratings give 0.5; a 400-point stronger opponent gives about 0.091. These are model expectations for retrospective comparison, not a claim about an individual game's chance." },
    { type: "paragraph", text: "A daily aggregate-only calibration uses 25-MMR intervals across −600 to +600 opponent-minus-player MMR. Only original bins with at least 200 games fit a nonincreasing curve through weighted pool adjacent violators. Observations outside that range never fill edge bins. Linear interpolation joins fitted anchors; continuous Elo-shaped tails extend beyond the supported anchors." },
    { type: "paragraph", text: "Fitting assumptions are explicit: a half-win/half-loss prior avoids exact certainty from finite samples, and mirrored constraints enforce rating-swap symmetry. Mirrored constraints are not additional observations. Tooltips identify the Elo fallback or calibrated model and report the original supported-bin and game counts. Sparse or unavailable calibration falls back to Elo." },
    { type: "heading", text: "Performance rating and matchup lines", anchor: "rating" },
    { type: "paragraph", text: "Performance rating starts from average rated-opponent MMR, then finds the rating offset that matches your observed rated win fraction under the same baseline. A flat fitted interval uses its midpoint. A 0% or 100% rated sample has no finite performance estimate and shows a dash, rather than an arbitrary rating cap." },
    { type: "paragraph", text: "The [Trends](/app/trends) **Matchup rating** card uses each played matchup's latest 50 decided ranked 1v1 games in the selected filters. Sparklines run in game order, with rolling ten-game estimates; early windows are shorter. Each window excludes missing paired ratings. Null and all-win/all-loss windows interrupt the line. Inspect a window to read its estimate and rated/missing counts. A chart is historical evidence, not a rating award or a promise about future results." },
    { type: "heading", text: "Ranges and thin samples", anchor: "uncertainty" },
    { type: "paragraph", text: "The faint bar in a win-rate cell is a **95% Wilson interval**, showing uncertainty due to sample size around that displayed raw win rate. It is separate from opponent-strength adjustment. Under ten games, **thin sample** is a reminder that a few results can move the number substantially. The rating card uses its measured rated-game count for this cue." },
  ],
  related: ["builds", "strategies", "trends", "analyzer-filters", "reading-the-charts"],
};
export default article;
