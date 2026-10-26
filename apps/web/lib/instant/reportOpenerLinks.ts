import type { ReportGame } from "./reportGames";
import type { ReportGuideLink } from "./reportGuideTypes";

/** Generic labels may span matchups: only link matchups present in these replays. */
export function openerGuideLinks(name: string, kind: "build" | "counter", games: ReadonlyArray<ReportGame>, links: ReadonlyArray<ReportGuideLink>): ReportGuideLink[] {
  const key = name.toLowerCase();
  const matchups = new Set(games.filter((game) => (kind === "build" ? game.payload.myBuild : game.payload.opponent?.strategy)?.toLowerCase() === key).map((game) => game.matchup));
  return links.filter((link) => link.kind === kind && link.name.toLowerCase() === key && matchups.has(link.matchup));
}
