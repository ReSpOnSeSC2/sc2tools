import type { MeCandidate } from "@/lib/instant/meDetection";
import type { ParsedGame } from "@/lib/instant/types";

export interface PreviewPlayer {
  name: string;
  race: string;
  result: string;
  handle: string | null;
  build_log: string[];
  mmr?: number;
}
export interface PreviewDossier {
  ok: true;
  game_id: string;
  map: string;
  duration_sec: number;
  date: string;
  players: [PreviewPlayer, PreviewPlayer];
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, fallback = "") => typeof value === "string" && value.trim() ? value : fallback;
const logs = (value: unknown): value is string[] => Array.isArray(value) && value.every(line => typeof line === "string");
const rating = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? { mmr: value } : {};

/** Narrow the worker's payload to the old demo view, retaining both complete
 * logs. Names come from the replay scan/chooser, never a profile/API lookup. */
export function instantPreview(game: ParsedGame, roster: readonly MeCandidate[]): PreviewDossier | null {
  if (game.matchFormat !== "1v1" || game.isResumedFromReplay) return null;
  let raw: unknown;
  try { raw = JSON.parse(game.json); } catch { return null; }
  if (!record(raw) || !record(raw.opponent) || !logs(raw.buildLog) || !logs(raw.oppBuildLog)
    || typeof raw.durationSec !== "number" || !Number.isFinite(raw.durationSec) || raw.durationSec < 0
    || typeof raw.gameId !== "string" || raw.gameId !== game.gameId || typeof raw.date !== "string"
    || !["Victory", "Defeat", "Win", "Loss", "Tie"].includes(String(raw.result))) return null;
  const opponent = raw.opponent;
  const mine = roster.find(player => player.toon === raw.myToonHandle);
  const theirs = roster.find(player => player.toon === opponent.toonHandle);
  const result = String(raw.result), won = result === "Victory" || result === "Win";
  const lost = result === "Defeat" || result === "Loss";
  return { ok: true, game_id: raw.gameId, date: raw.date, map: text(raw.map, "Unknown map"), duration_sec: raw.durationSec,
    players: [
      { name: mine?.name || "You", race: text(raw.myRace, mine?.race || "Random"), result: won ? "Win" : lost ? "Loss" : "Tie",
        handle: typeof raw.myToonHandle === "string" ? raw.myToonHandle : null, build_log: raw.buildLog, ...rating(raw.myMmr) },
      { name: text(opponent.displayName, theirs?.name || "Opponent"), race: text(opponent.race, theirs?.race || "Random"), result: won ? "Loss" : lost ? "Win" : "Tie",
        handle: typeof opponent.toonHandle === "string" ? opponent.toonHandle : null, build_log: raw.oppBuildLog, ...rating(opponent.mmr) },
    ] };
}
