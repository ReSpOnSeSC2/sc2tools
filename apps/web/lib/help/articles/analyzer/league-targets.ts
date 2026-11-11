import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "league-targets",
  title: "League targets",
  summary: "See where your SQ, macro score, APM, game length and build timings sit against your league and the next one, and estimate the games a season goal could take.",
  category: "analyzer",
  audience: "player",
  signedInOnly: true,
  order: 13,
  related: ["macro", "goals", "glossary"],
  keywords: ["targets", "next league", "percentile", "decile", "league median", "master", "diamond", "timing", "natural", "season goal", "estimate"],
  updated: "2026-11-10",
  body: [
    { type: "paragraph", text: "The **Targets** card sits at the top of the [Macro](/app/macro) tab, with a compact strip on [Today](/app). It compares the median of your last 20 ranked 1v1 games in one matchup with the league tables built from every player's uploads, using fixed rules, never AI." },
    { type: "heading", text: "What the bars mean", anchor: "bars" },
    { type: "list", items: [
      "The shaded band is your league's 10th to 90th percentile for that matchup; the thin tick is its median.",
      "The accent tick is the next league's median, and the dot is your own median.",
      "A row such as \"Diamond PvZ p38 → Master median needs +6 SQ\" places your median at the 38th percentile of Diamond PvZ and gives the step to the Master median.",
      "Game length is a profile, not a score: it shows where your games end without saying longer or shorter is better.",
      "**Games below target** lists your ranked games in the matchup under that median, within your current filters.",
    ] },
    { type: "heading", text: "Which league and matchup", anchor: "league" },
    { type: "paragraph", text: "Your league comes from your latest replay-recorded MMR, or from SC2Pulse when your replays carry none. Choose a league under **Compare with** to override it. The matchup follows the filter bar when it names your race and your opponent's race; otherwise the card uses the matchup you played most in your last 100 ranked games, with a picker for the others." },
    { type: "heading", text: "The opponent-league proxy", anchor: "proxy" },
    { type: "paragraph", text: "Replays record your opponent's league, not yours, so the tables group games by the opponent's league. Ladder matchmaking pairs players of similar rating, so the opponent's league is a close stand-in for the bracket a game was played in." },
    { type: "heading", text: "The 50-game floor", anchor: "floor" },
    { type: "paragraph", text: "A league table is shown only when at least 50 games, from at least 5 different players, are behind it, and the same floor applies to each metric and timing. Below it the card says, for example, \"Not enough Master PvZ games yet\" and still shows your own numbers. No table contains any player's identity." },
    { type: "heading", text: "Timing gaps", anchor: "timings" },
    { type: "paragraph", text: "Natural and third base are when your second and third town hall started; first upgrade is the earliest finished upgrade among the race's tracked upgrades; key tech is the first tech step (Protoss: Twilight Council, Stargate or Robotics Facility; Terran: Factory; Zerg: Lair finished). Your times come from the build orders of your last 20 ranked games in the matchup, using only games from the latest replay's patch era. The league's times come from guide builds in the same era and use the same milestone definitions." },
    { type: "heading", text: "The season estimate", anchor: "season" },
    { type: "paragraph", text: "Pick a target league or MMR under **Season goal**. MMR to go is the target minus your current MMR. Your average net MMR per game uses consecutive replay-recorded ratings from your last 30 games on the same account and race, skipping swings over 150 and changes that disagree with the result. Estimated games is MMR to go divided by that average, rounded up; per week divides those games by the weeks left before the season ends. It is plain arithmetic on your recent pace, labelled as an estimate, and it shows nothing while your average is flat or falling." },
  ],
};

export default article;
