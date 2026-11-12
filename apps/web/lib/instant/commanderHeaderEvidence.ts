import { selectedGamesFromHeaders, type KeyedHeader, type SelectedHeader } from "@/lib/career/headerRows";
import { dominantPlayer, rankedMatchup, type CommanderRow } from "./commanderEvidence";
import type { MeDetection } from "./meDetection";
import { replayDigest } from "./replayDigest";
import { parseInstantPayload, type InstantPayload } from "./reportPayload";
import type { EligibleFile } from "./sessionPipeline";
import type { ParsedWithFile } from "./sessionState";
import type { IntakeFile, ParseRequest } from "./types";

type HeaderEvidence = {
  eligible: readonly EligibleFile[];
  detection: MeDetection;
  chosenToon: string | null;
  signal: AbortSignal;
};

async function verifiedHeader(file: IntakeFile, header: KeyedHeader["header"],
  deep: ReadonlyMap<string, InstantPayload | null>, signal: AbortSignal): Promise<KeyedHeader | null> {
  const digest = await replayDigest(file.blob);
  signal.throwIfAborted();
  // Without an opponent toon or a content digest, only a deep game ID can prove uniqueness.
  const identity = digest ?? deep.get(file.key)?.gameId;
  return identity ? { key: file.key, header, replayDigest: identity } : null;
}

async function commanderHeaders({ eligible, detection, chosenToon, signal }: HeaderEvidence,
  deep: ReadonlyMap<string, InstantPayload | null>): Promise<KeyedHeader[]> {
  const rows: KeyedHeader[] = [];
  for (const { file, header } of eligible) {
    signal.throwIfAborted();
    if (!header) continue;
    const toon = detection.selectorFor(file.key, chosenToon)?.toon;
    if (!toon || (chosenToon && toon !== chosenToon)) continue;
    if (header.players.some(player => player.toon && player.toon !== toon)) {
      rows.push({ key: file.key, header });
      continue;
    }
    const row = await verifiedHeader(file, header, deep, signal);
    if (row) rows.push(row);
  }
  return rows;
}

function uniqueDeepGames(rows: SelectedHeader[], deep: ReadonlyMap<string, InstantPayload | null>): SelectedHeader[] {
  const seen = new Set<string>();
  return rows.filter(({ key }) => {
    const gameId = deep.get(key)?.gameId;
    if (!gameId) return true;
    if (seen.has(gameId)) return false;
    seen.add(gameId);
    return true;
  });
}

/** Evidence from the same resolved selection and replay dedupe as the header scan. */
export async function commanderHeaderRows(evidence: HeaderEvidence, attempted: readonly ParseRequest[],
  parsed: readonly ParsedWithFile[]): Promise<CommanderRow[]> {
  const attemptedKeys = new Set(attempted.map(({ file }) => file.key));
  const deep = new Map(parsed.map(({ file, game }) => [file.key, parseInstantPayload(game.json)]));
  const headers = await commanderHeaders(evidence, deep);
  // Prefer a successful parse for builds. A rejected parse also wins over a
  // deferred duplicate so it cannot re-enter as header-only evidence.
  const priority = (key: string) => deep.get(key) ? 2 : Number(attemptedKeys.has(key));
  headers.sort((left, right) => priority(right.key) - priority(left.key));
  const selected = selectedGamesFromHeaders(headers, evidence.chosenToon, evidence.detection)
    .filter(({ key }) => !attemptedKeys.has(key) || deep.get(key));
  return dominantPlayer(uniqueDeepGames(selected, deep), row => row.me.toon).flatMap(({ key, header, me, opponent }) => {
    const matchup = rankedMatchup(me.race, opponent.race);
    if (!matchup) return [];
    const payload = deep.get(key);
    const myBuild = payload && payload.myToonHandle === me.toon && rankedMatchup(payload.myRace, payload.opponent?.race ?? null) === matchup
      ? payload.myBuild : null;
    return [{ matchup, durationSec: header.durationSec, result: me.result ?? "", myBuild }];
  });
}
