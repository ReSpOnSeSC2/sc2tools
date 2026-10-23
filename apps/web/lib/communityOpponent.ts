import { coerceRace, type Race } from "@/lib/race";

/**
 * The public community opponent profile (/community/opponents/<id>):
 * an aggregate of every SC2 Tools player's games against one opponent,
 * published only once enough different players have faced them that
 * no single player's games can be picked out. Names, battle tags and
 * the toon handle in the URL are never shown.
 */

/**
 * Fewest different SC2 Tools players who must have faced an opponent
 * before the profile is public. Mirrors K_ANONYMITY_THRESHOLD in
 * apps/api/src/services/community.js.
 */
export const OPPONENT_PROFILE_MIN_PLAYERS = 5;

/** GET /v1/community/opponents/:pulseId. Every count is from the opponent's side. */
export interface CommunityOpponentAggregate {
  pulseId: string;
  /** SC2Pulse character id, when any player's data resolved it. */
  pulseCharacterId?: string | null;
  race?: string;
  contributors: number;
  games: number;
  wins: number;
  losses: number;
  winRate: number;
  strategies: Record<string, number>;
  byMap: Record<string, { wins: number; losses: number }>;
}

/** The opponent's race, or null when no game recorded it. */
export function opponentRace(race: string | undefined): Race | null {
  return race && race.trim() ? coerceRace(race) : null;
}

/** "Zerg opponent scouting profile" (or "Opponent scouting profile"). */
export function opponentHeading(race: string | undefined): string {
  const known = opponentRace(race);
  return known ? `${known} opponent scouting profile` : "Opponent scouting profile";
}

/**
 * The page title: race plus the resolved SC2Pulse character id, never
 * the toon handle from the URL.
 *
 * Example: `opponentMetaTitle({ race: "Zerg", pulseCharacterId: "994428" })`
 * → "Zerg opponent · Pulse #994428".
 */
export function opponentMetaTitle(data: Pick<CommunityOpponentAggregate, "race" | "pulseCharacterId">): string {
  const known = opponentRace(data.race);
  const base = known ? `${known} opponent` : "Opponent";
  const id = typeof data.pulseCharacterId === "string" && /^\d+$/.test(data.pulseCharacterId)
    ? data.pulseCharacterId
    : null;
  return id ? `${base} · Pulse #${id}` : base;
}

/** True when the aggregate meets the public floor (index it, show it). */
export function meetsPlayerFloor(data: Pick<CommunityOpponentAggregate, "contributors">): boolean {
  return Number.isFinite(data.contributors) && data.contributors >= OPPONENT_PROFILE_MIN_PLAYERS;
}

export interface StrategyShare {
  name: string;
  games: number;
  /** Share of the games with a recognised strategy, 0..1. */
  share: number;
}

/** Strategies, most-seen first, as shares of the games that have one. */
export function strategyShares(strategies: Record<string, number>, limit = 8): StrategyShare[] {
  const rows = Object.entries(strategies ?? {}).filter(([, games]) => Number.isFinite(games) && games > 0);
  const total = rows.reduce((sum, [, games]) => sum + games, 0);
  return rows
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, games]) => ({ name, games, share: total > 0 ? games / total : 0 }));
}

export interface MapRow {
  map: string;
  wins: number;
  losses: number;
  games: number;
  /** The opponent's win rate on this map, 0..1. */
  winRate: number;
}

/** Maps, most games first (ties by name). */
export function mapRows(byMap: CommunityOpponentAggregate["byMap"]): MapRow[] {
  return Object.entries(byMap ?? {})
    .map(([map, { wins, losses }]) => {
      const games = wins + losses;
      return { map, wins, losses, games, winRate: games > 0 ? wins / games : 0 };
    })
    .filter((row) => row.games > 0)
    .sort((a, b) => b.games - a.games || a.map.localeCompare(b.map));
}
