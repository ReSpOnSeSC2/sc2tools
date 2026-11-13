import { BALANCE_LEAGUES, BALANCE_MATCHUPS, type BalanceBundle, type BalanceCohort, type BalanceTier } from "./bundle";

const SAME_TIER: BalanceCohort = { games: 1_000, wins: 515, winRate: 0.515, interval: { low: 0.484, high: 0.546 } };
const CROSS_TIER: BalanceCohort = { games: 200, wins: 81, winRate: 0.405, interval: { low: 0.339, high: 0.474 } };
const NO_GAMES: BalanceCohort = { games: 0, wins: 0, winRate: null, interval: null };

export function balanceBundleFixture(): BalanceBundle {
  const tiers: BalanceTier[] = BALANCE_LEAGUES.flatMap(league => {
    const divisions: BalanceTier["division"][] = league === "grandmaster" ? [null] : [1, 2, 3];
    return divisions.map(division => ({
      league, division, matchups: BALANCE_MATCHUPS.map(matchup => ({
        matchup,
        sameTier: { ...(league === "grandmaster" ? NO_GAMES : SAME_TIER) },
        crossTier: { ...CROSS_TIER },
      })),
    }));
  });
  return { season: 68, asOf: "2026-11-12", tiers };
}
