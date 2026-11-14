import { balanceTierKey, BALANCE_LEAGUES } from "./bundle";
import type { getBalanceCohort, BalanceEvidence, BalanceRace } from "./evidence";
import { matchesVerdictInterval, type Verdict } from "./verdictShare";
import { toAutopsyGame } from "@/lib/instant/report";
import type { InstantPayload } from "@/lib/instant/reportPayload";
import { lossAutopsy } from "@/lib/lossAutopsy";

const REGION = { "1": "US", "2": "EU", "3": "KR" } as const;

// Deliberately match exact outputs from strategy_detector_race.py.
export const EARLY_AGGRESSION = ["Zerg - 12 Pool", "Protoss - Cannon Rush", "Protoss - Proxy 4 Gate", "Protoss - Proxy 2 Gate", "Terran - Proxy Rax"] as const;

type Cohort = NonNullable<ReturnType<typeof getBalanceCohort>>;

export function raceCode(value: string | null | undefined): BalanceRace | null {
  switch (value?.trim().toLowerCase()) {
    case "protoss":
    case "p": return "P";
    case "terran":
    case "t": return "T";
    case "zerg":
    case "z": return "Z";
    default: return null;
  }
}

export function replayCases(payloads: readonly InstantPayload[]) {
  return payloads.flatMap(game => {
    const race = raceCode(game.myRace);
    const opponent = raceCode(game.opponent?.race);
    const isLoss = /^(?:loss|defeat)$/i.test(game.result);
    if (game.isLadderGame !== true || !isLoss || !race || !opponent || race === opponent
      || /^(?:r|random)$/i.test(game.myLadderRace ?? "")) return [];
    return [{ game, race, opponent }];
  }).sort((a, b) => Date.parse(b.game.date) - Date.parse(a.game.date));
}

export function replayCohort(evidence: BalanceEvidence, game: InstantPayload) {
  const regionKey = /^([123])-S2-/i.exec(game.myToonHandle ?? "")?.[1] as keyof typeof REGION | undefined;
  const region = regionKey ? REGION[regionKey] : undefined;
  const mmr = game.myMmr;
  if (region && mmr !== null && mmr > 0) {
    const candidates = evidence.tiers.filter(tier => tier.bounds.some(bound =>
      bound.region === region && bound.maxRating > 0 && mmr >= bound.minRating && mmr <= bound.maxRating,
    ));
    if (candidates.length === 1) return { key: balanceTierKey(candidates[0]), source: "mmr" } as const;
  }
  const leagueId = game.opponent?.leagueId;
  const league = leagueId == null ? undefined : BALANCE_LEAGUES[BALANCE_LEAGUES.length - 1 - leagueId];
  return league ? { key: league, source: "opponent" } as const : null;
}

export function replayMap(evidence: BalanceEvidence, replayName: string | null) {
  const name = replayName?.trim().toLowerCase();
  if (!name) return null;
  const matches = evidence.maps.filter(map => map.name.trim().toLowerCase() === name);
  return matches.length === 1 ? matches[0] : null;
}

function hasStats(events: NonNullable<InstantPayload["macroBreakdown"]>["stats_events"], key: "minerals_current" | "army_value") {
  return events?.some(event => typeof event[key] === "number") ?? false;
}

/** Compare only rules both perspectives support. The opponent payload has no personal medians or race mechanics. */
export function replayExhibits(payload: InstantPayload) {
  const game = toAutopsyGame(payload);
  const breakdown = game.macroBreakdown;
  const own = lossAutopsy({ game });
  const opponentWindows = breakdown?.raw?.opp_supply_block_windows;
  const opponentBlocked = breakdown?.player_stats?.opponent?.supply_blocked_seconds;
  const enemy = breakdown && lossAutopsy({ game: {
    result: "Defeat",
    macroBreakdown: {
      ok: true,
      race: payload.opponent?.race,
      raw: { supply_block_windows: opponentWindows, supply_blocked_seconds: opponentBlocked },
      stats_events: breakdown.opp_stats_events,
      opp_stats_events: breakdown.stats_events,
    },
  } });
  const canCompare = {
    supply_block: opponentWindows !== undefined || typeof opponentBlocked === "number",
    resource_float: hasStats(breakdown?.stats_events, "minerals_current") && hasStats(breakdown?.opp_stats_events, "minerals_current"),
    one_sided_fight: hasStats(breakdown?.stats_events, "army_value") && hasStats(breakdown?.opp_stats_events, "army_value"),
  };
  const mirrors = own.flatMap(cause => {
    const key = cause.id as keyof typeof canCompare;
    return canCompare[key] ? [{ cause, opponentSeverity: enemy?.find(entry => entry.id === key)?.severityScore ?? 0 }] : [];
  });
  const hasOwnEvidence = !!breakdown && (
    breakdown.raw?.supply_block_windows !== undefined
    || typeof breakdown.raw?.supply_blocked_seconds === "number"
    || hasStats(breakdown.stats_events, "minerals_current")
    || own.length > 0
  );
  return {
    own,
    mirrors,
    severity: hasOwnEvidence ? own[0]?.severityScore ?? 0 : null,
    earlyAggression: payload.opponentProxy === true || EARLY_AGGRESSION.some(label => payload.opponent?.strategy === label),
  };
}

export function decideReplayVerdict(interval: Cohort["interval"], exhibits: Pick<ReturnType<typeof replayExhibits>, "severity" | "own" | "mirrors">): Verdict {
  const { severity, own, mirrors } = exhibits;
  if (matchesVerdictInterval("imba", interval) && severity !== null && severity < 40) return "imba";
  if (matchesVerdictInterval("split", interval)) return "split";
  if (matchesVerdictInterval("contempt", interval)) return "contempt";
  const replayEdge = own.some(cause => {
    const mirror = mirrors.find(row => row.cause.id === cause.id);
    return !mirror || cause.severityScore > mirror.opponentSeverity;
  });
  return replayEdge ? "replay" : "insufficient";
}
