import { wilsonInterval } from "@/lib/wilson";
import { getBalanceCohort, type BalanceEvidence, type BalanceRace } from "./evidence";

export const MAX_PERMIT_GAMES = 100_000;

export function parsePermitNumber(raw: string) {
  if (!/^\d{1,6}$/.test(raw)) return null;
  const value = Number(raw);
  return value <= MAX_PERMIT_GAMES ? value : null;
}

/** Attribute only the observed deficit below 50%, capped at that deficit. */
export function evaluatePermit(evidence: BalanceEvidence, key: string, race: BalanceRace, opponent: BalanceRace, wins: number, losses: number) {
  const games = wins + losses;
  if (!Number.isSafeInteger(wins) || !Number.isSafeInteger(losses) || wins < 0 || losses < 0 || games > MAX_PERMIT_GAMES) return null;
  const personalInterval = wilsonInterval(wins, games);
  const ladder = getBalanceCohort(evidence, key, race, opponent);
  if (!personalInterval || !ladder) return null;
  const personalRate = wins / games;
  const deficit = Math.max(0, 0.5 - personalRate);
  const ladderGap = Math.min(deficit, Math.max(0, 0.5 - ladder.winRate));
  const playerGap = deficit - ladderGap;
  const status = personalRate >= 0.5 ? "No losing record" : ladder.interval.high < 0.5 ? "Licensed to whine" : "Permit denied";
  return { status, ladder, personalRate, personalInterval, ladderGap, playerGap };
}
