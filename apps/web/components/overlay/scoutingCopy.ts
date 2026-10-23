import type { OpponentPhases } from "./types";

/**
 * Short on-stream copy shared by the opponent scouting widgets
 * (Favourite opening, Cheese alert, Scouting report). Pure strings, no
 * React, so every card words the same numbers the same way.
 */

/**
 * How many of the opponent's recent games in this matchup showed
 * something.
 *
 * Example: `ofLastGames(3, 5)` → "3 of last 5 games";
 * `ofLastGames(1, 1)` → "1 of 1 game".
 */
export function ofLastGames(samples: number, of: number): string {
  const n = Math.max(0, Math.round(samples));
  const total = Math.max(0, Math.round(of));
  return total > 1 ? `${n} of last ${total} games` : `${n} of ${total} game`;
}

const PHASE_LABEL: Record<OpponentPhases["typicalFinalPhase"], string> = {
  early: "Early",
  earlyMid: "Early/Mid",
  mid: "Mid",
  midLate: "Mid/Late",
  late: "Late",
};

/** Split a unit token into words: `unitWords("VoidRay")` → "Void Ray". */
function unitWords(token: string): string {
  return token.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/**
 * The scouting card's one-line phase forecast: where games against
 * this opponent usually end, plus the streamer's own army in those games
 * when that is mid game or later.
 *
 * Example: midLate + [Carrier, Tempest, Mothership] →
 * "Mid/Late game · Your army: Carrier, Tempest, Mothership".
 */
export function phaseLine(phases: OpponentPhases): string {
  const phase = `${PHASE_LABEL[phases.typicalFinalPhase] ?? "Mid"} game`;
  const units = (phases.typicalLateComp?.units ?? []).filter(Boolean).slice(0, 3);
  return units.length > 0 ? `${phase} · Your army: ${units.map(unitWords).join(", ")}` : phase;
}
