import { selectedGamesFromHeaders } from "@/lib/career/headerRows";
import type { MeDetection } from "./meDetection";
import { matchupLabel } from "./reportGames";
import { parseInstantPayload, type InstantPayload } from "./reportPayload";
import type { EligibleFile } from "./sessionPipeline";
import type { ParsedWithFile } from "./sessionState";
import type { ParseRequest } from "./types";

export interface CommanderRow {
  matchup: string;
  durationSec: number | null;
  result: string;
  myBuild: string | null;
}

function rankedMatchup(own: string | null, opponent: string | null): string | null {
  const matchup = matchupLabel(own, opponent);
  return matchup && /^[PTZ]v[PTZ]$/.test(matchup) ? matchup : null;
}

/** Do not merge files analyzed from different player perspectives. */
function dominantPlayer<T>(rows: readonly T[], playerOf: (row: T) => string | null): T[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const player = playerOf(row);
    if (!player) continue;
    const group = groups.get(player);
    if (group) group.push(row);
    else groups.set(player, [row]);
  }
  return [...groups.values()].reduce((largest, group) => group.length > largest.length ? group : largest, []);
}

/** Evidence from the same resolved selection and replay dedupe as the header scan. */
export function commanderHeaderRows(eligible: readonly EligibleFile[], detection: MeDetection, chosenToon: string | null,
  attempted: readonly ParseRequest[], parsed: readonly ParsedWithFile[]): CommanderRow[] {
  const attemptedKeys = new Set(attempted.map(({ file }) => file.key));
  const deep = new Map(parsed.map(({ file, game }) => [file.key, parseInstantPayload(game.json)]));
  const headers = eligible.flatMap(({ file, header }) => header ? [{ key: file.key, header }] : []);
  // Prefer a successful parse for builds. A rejected parse also wins over a
  // deferred duplicate so it cannot re-enter as header-only evidence.
  const priority = (key: string) => deep.get(key) ? 2 : Number(attemptedKeys.has(key));
  headers.sort((left, right) => priority(right.key) - priority(left.key));
  const selected = selectedGamesFromHeaders(headers, chosenToon, detection).filter(({ key }) => !attemptedKeys.has(key) || deep.get(key));
  return dominantPlayer(selected, row => row.me.toon).flatMap(({ key, header, me, opponent }) => {
    const matchup = rankedMatchup(me.race, opponent.race);
    if (!matchup) return [];
    const payload = deep.get(key);
    const myBuild = payload && payload.myToonHandle === me.toon && rankedMatchup(payload.myRace, payload.opponent?.race ?? null) === matchup
      ? payload.myBuild : null;
    return [{ matchup, durationSec: header.durationSec, result: me.result ?? "", myBuild }];
  });
}

/** Older saved reports can use their local deep parses even without a fresh scan. */
export function commanderSavedRows(payloads: readonly InstantPayload[]): CommanderRow[] {
  const seen = new Set<string>();
  const ranked = payloads.filter(game => {
    if (!game.isLadderGame || seen.has(game.gameId) || !Number.isFinite(Date.parse(game.date))) return false;
    seen.add(game.gameId);
    return true;
  });
  return dominantPlayer(ranked, row => row.myToonHandle).flatMap(game => {
    const matchup = rankedMatchup(game.myRace, game.opponent?.race ?? null);
    return matchup ? [{ matchup, durationSec: game.durationSec, result: game.result, myBuild: game.myBuild }] : [];
  });
}
