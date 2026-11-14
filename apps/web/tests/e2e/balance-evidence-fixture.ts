import { BALANCE_LEAGUES, BALANCE_MATCHUPS } from "../../lib/balance/bundle";
import type { BalanceEvidence, EvidenceTier } from "../../lib/balance/evidence";

export const BALANCE_EVIDENCE_ROUTE = "**/v1/ladder/balance/evidence*";
export const BALANCE_EVIDENCE_HEADERS = { "access-control-allow-origin": "*" };

export function balanceEvidenceFixture(asOf = "2026-11-13"): BalanceEvidence {
  return {
    season: 68,
    asOf,
    maps: [{ id: 5, name: "Test map" }],
    tiers: BALANCE_LEAGUES.flatMap(league => {
      const divisions: EvidenceTier["division"][] = league === "grandmaster" ? [null] : [1, 2, 3];
      return divisions.map(division => ({
        league, division, bounds: [],
        matchups: BALANCE_MATCHUPS.map(matchup => ({ matchup, games: 1_000, wins: 530 })),
        mapMatchups: BALANCE_MATCHUPS.map(matchup => ({ matchup, mapId: 5, games: 500, wins: 300 })),
      }));
    }),
  };
}
