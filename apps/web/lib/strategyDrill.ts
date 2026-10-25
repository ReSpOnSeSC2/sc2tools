import { filtersToQuery, type AnalyzerFilters } from "./filterContext";

export type StrategyDrillFilter = { opp_strategy: string; build?: string; opp_race?: string };
export function strategyDrillFilters(filters: AnalyzerFilters, drill: StrategyDrillFilter): AnalyzerFilters {
  return { ...filters, opp_strategy: drill.opp_strategy || filters.opp_strategy, build: drill.build ?? filters.build,
    opp_race: filters.opp_race || drill.opp_race };
}
/** One merged parameter object avoids duplicate query keys. A global matchup
 * remains authoritative; an otherwise local matrix matchup follows its cell. */
export function strategyGamesPath(filters: AnalyzerFilters, drill: StrategyDrillFilter, dbRev: number): string {
  return `/v1/games-list${filtersToQuery({ ...strategyDrillFilters(filters, drill), sort: "date_desc", limit: 5000 })}#${dbRev}`;
}
