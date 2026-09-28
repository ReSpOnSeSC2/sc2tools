/**
 * Payload → analyzer `ArcadeGame` row, so the /try report can reuse the
 * season recap's pure aggregations (totals, matchup splits, MMR
 * journeys) instead of forking them. Kept apart from `report.ts` so the
 * report's helper modules (reportMmr, reportGames) can use it without an
 * import cycle.
 *
 * Example:
 *   computeSeasonRecap(payloads.map(toArcadeGame), { since: new Date(0) });
 */
import type { ArcadeGame } from "@/components/analyzer/arcade/types";
import type { InstantOpponent, InstantPayload } from "./reportPayload";

/**
 * Map a payload to the analyzer's `ArcadeGame` row. This replicates
 * `normaliseGame` (components/analyzer/arcade/hooks/useArcadeData.ts)
 * instead of importing it: that module is a Clerk/SWR React hook file,
 * and this one must stay pure (it runs on the public /try page before
 * any auth exists). Mapping: durationSec → duration, macroScore →
 * macro_score, opponent.race → oppRace, opponent.strategy →
 * opp_strategy, opponent.pulseId → oppPulseId.
 *
 * Example:
 *   toArcadeGame(payload).oppRace; // -> "Zerg"
 */
export function toArcadeGame(payload: InstantPayload): ArcadeGame {
  const opp = payload.opponent;
  return {
    gameId: payload.gameId,
    date: payload.date,
    result: payload.result,
    myToonHandle: payload.myToonHandle,
    myBuild: payload.myBuild,
    macro_score: payload.macroScore,
    opp_strategy: opp?.strategy ?? null,
    ...optionalGameFields(payload),
    ...(opp ? opponentGameFields(opp) : {}),
  };
}

/** Optional `ArcadeGame` fields, present only when the payload has them. */
function optionalGameFields(payload: InstantPayload): Partial<ArcadeGame> {
  const fields: Partial<ArcadeGame> = {};
  if (payload.myRace) fields.myRace = payload.myRace;
  if (payload.map) fields.map = payload.map;
  if (payload.durationSec !== null) fields.duration = payload.durationSec;
  if (payload.myMmr !== null) fields.myMmr = payload.myMmr;
  return fields;
}

function opponentGameFields(opp: InstantOpponent): Partial<ArcadeGame> {
  const fields: Partial<ArcadeGame> = { opponent: arcadeOpponent(opp) };
  if (opp.race) fields.oppRace = opp.race;
  if (opp.pulseId) fields.oppPulseId = opp.pulseId;
  return fields;
}

function arcadeOpponent(opp: NonNullable<InstantPayload["opponent"]>): ArcadeGame["opponent"] {
  const out: NonNullable<ArcadeGame["opponent"]> = { strategy: opp.strategy };
  if (opp.displayName) out.displayName = opp.displayName;
  if (opp.race) out.race = opp.race;
  if (opp.mmr !== null) out.mmr = opp.mmr;
  if (opp.pulseId) out.pulseId = opp.pulseId;
  return out;
}
