import type { ArcadeGame } from "@/components/analyzer/arcade/types";
import { formatDate } from "@/lib/i18n/format";
import { isReplayFileName } from "@/lib/instant/fileIntake";
import { detectMe } from "@/lib/instant/meDetection";
import type { IntakeFile, ReplayHeader, ReplayHeaderPlayer, ReplayHeaderResult } from "@/lib/instant/types";

export const RECAP_YEAR = 2026;
export const RECAP_START = Date.UTC(RECAP_YEAR, 0, 1);
export const RECAP_END = Date.UTC(RECAP_YEAR + 1, 0, 1);

export function yearReplayFiles(files: IntakeFile[]): IntakeFile[] {
  const unique = new Map<string, IntakeFile>();
  for (const file of files) {
    if (!isReplayFileName(file.name)) continue;
    if (file.lastModified >= RECAP_START && file.lastModified < RECAP_END) unique.set(file.key, file);
  }
  return [...unique.values()].sort((left, right) => right.lastModified - left.lastModified);
}

export interface KeyedHeader {
  key: string;
  replayDigest?: string;
  header: ReplayHeader & { date: string };
}

export function isLadderHeader(result: ReplayHeaderResult): result is KeyedHeader["header"] {
  return result.ok && !!result.date && Number.isFinite(Date.parse(result.date))
    && result.matchFormat === "1v1" && result.isLadderGame === true
    && !result.isAiGame && result.playerCount === 2 && result.players.length === 2;
}

function isYearLadderGame(result: ReplayHeaderResult): result is KeyedHeader["header"] {
  if (!isLadderHeader(result)) return false;
  const date = Date.parse(result.date);
  return date >= RECAP_START && date < RECAP_END;
}

export function yearLadderHeaders(files: IntakeFile[], results: ReplayHeaderResult[]): KeyedHeader[] {
  return results.flatMap((header, index) =>
    isYearLadderGame(header) ? [{ key: files[index].key, header }] : [],
  );
}

export function headerIdentity(rows: KeyedHeader[]) {
  return detectMe(rows.map(({ key, header }) => ({
    key,
    players: header.players,
    toonFromPath: header.toonFromPath,
  })));
}

function toArcadeGame(row: KeyedHeader, me: ReplayHeaderPlayer, opponent: ReplayHeaderPlayer): ArcadeGame {
  const { key, header } = row;
  return {
    gameId: key,
    date: header.date,
    result: me.result ?? "",
    myToonHandle: me.toon,
    myRace: me.race,
    myLadderRace: me.selectedRace ?? undefined,
    oppRace: opponent.race,
    myMmr: me.mmr ?? undefined,
    oppMmr: opponent.mmr ?? undefined,
    duration: header.durationSec > 0 ? header.durationSec : undefined,
    map: header.map ?? undefined,
    opponent: { toonHandle: opponent.toon, displayName: opponent.name, race: opponent.race },
  };
}

export interface SelectedHeader extends KeyedHeader {
  me: ReplayHeaderPlayer;
  opponent: ReplayHeaderPlayer;
}

export function selectedGamesFromHeaders(rows: KeyedHeader[], chosenToon?: string): SelectedHeader[] {
  const identity = headerIdentity(rows);
  const seen = new Set<string>();
  const games: SelectedHeader[] = [];
  for (const row of rows) {
    const selector = identity.selectorFor(row.key, chosenToon);
    if (!selector?.toon) continue;
    const [first, second] = row.header.players;
    const me = first.toon === selector.toon ? first : second;
    const opponent = me === first ? second : first;
    const pair = [me.toon, opponent.toon].sort();
    const gameKey = opponent.toon
      ? JSON.stringify([row.header.date, row.header.durationSec, row.header.map, pair])
      : row.replayDigest ?? row.key;
    if (seen.has(gameKey)) continue;
    seen.add(gameKey);
    games.push({ ...row, me, opponent });
  }
  return games;
}

export function gamesFromHeaders(rows: KeyedHeader[], chosenToon?: string): ArcadeGame[] {
  return selectedGamesFromHeaders(rows, chosenToon).map((row) => toArcadeGame(row, row.me, row.opponent));
}

export function busiestReplayMonth(games: ArcadeGame[]): { month: string; games: number } | null {
  const counts = Array.from({ length: 12 }, () => 0);
  for (const game of games) counts[new Date(game.date).getUTCMonth()] += 1;
  const max = Math.max(...counts);
  if (!max) return null;
  const date = new Date(Date.UTC(RECAP_YEAR, counts.indexOf(max), 1));
  return { month: formatDate(date, { month: "long", timeZone: "UTC" }), games: max };
}
