import { API_BASE } from "@/lib/apiBase";
import { isCount, isDate, isRace, isRow, isText, type Race } from "@/lib/ladder/vods";

/** One game of a pro's. The other player is never part of it (ADR 0075). */
export type ProGame = {
  map: string;
  /** Null when SC2Pulse did not say. */
  opponentRace: Race | null;
  won: boolean;
  durationSec: number;
  playedAt: string;
};

export type ProLive = { platform: "twitch" | "kick"; channel: string; url: string; viewers: number };

/** A Grandmaster who played lately: race, league and rating only, no name. */
export type PlayerRow = { race: Race; league: string; rating: number; playedAt: string };

/** A known pro; the server sends these only while its names gate is open (ADR 0065). */
export type ProRow = PlayerRow & { nickname: string; team: string | null; live: ProLive | null; games: ProGame[] };

export type ProBoard = { showNames: boolean; pros: ProRow[]; players: PlayerRow[]; fetchedAt: string };
/** `available: false` is the server's gate: the board is not open yet. */
export type ProBoardAnswer = { available: false } | ({ available: true } & ProBoard);

/** The server answers from memory, so this is generous only for a cold connection. */
const REQUEST_TIMEOUT_MS = 10_000;
const CHANNEL_HOSTS: Record<ProLive["platform"], string[]> = {
  twitch: ["www.twitch.tv", "twitch.tv"],
  kick: ["kick.com", "www.kick.com"],
};
const CHANNEL_PATTERN = /^[A-Za-z0-9_]{1,25}$/;

/** The live link opens only on the platform it names, whatever the server sent. */
function liveOf(value: unknown): ProLive | null {
  if (!isRow(value) || (value.platform !== "twitch" && value.platform !== "kick")) return null;
  const { platform, channel, viewers } = value;
  try {
    const url = new URL(String(value.url));
    const trusted = url.protocol === "https:" && CHANNEL_HOSTS[platform].includes(url.host);
    return trusted && typeof channel === "string" && CHANNEL_PATTERN.test(channel) && isCount(viewers)
      ? { platform, channel, url: url.href, viewers }
      : null;
  } catch {
    return null;
  }
}

function gameOf(value: unknown): ProGame | null {
  if (!isRow(value)) return null;
  const { map, opponentRace, won, durationSec, playedAt } = value;
  if (!isText(map) || !isCount(durationSec) || !isDate(playedAt) || typeof won !== "boolean") return null;
  return { map, opponentRace: isRace(opponentRace) ? opponentRace : null, won, durationSec, playedAt };
}

function playerOf(value: unknown): PlayerRow | null {
  if (!isRow(value)) return null;
  const { race, league, rating, playedAt } = value;
  return isRace(race) && isText(league) && isCount(rating) && isDate(playedAt) ? { race, league, rating, playedAt } : null;
}

function proOf(value: unknown): ProRow | null {
  const player = playerOf(value);
  if (!player || !isRow(value) || !isText(value.nickname)) return null;
  const games = Array.isArray(value.games) ? value.games.flatMap(game => gameOf(game) ?? []) : [];
  return { ...player, nickname: value.nickname, team: isText(value.team) ? value.team : null, live: liveOf(value.live), games };
}

/** Validates the API answer; a shape it does not recognise is not shown. */
export function readProBoard(value: unknown): ProBoardAnswer | null {
  if (!isRow(value)) return null;
  if (value.available === false) return { available: false };
  if (value.available !== true || !Array.isArray(value.players) || !Array.isArray(value.pros) || !isDate(value.fetchedAt)) return null;
  return {
    available: true,
    showNames: value.showNames === true,
    pros: value.pros.flatMap(row => proOf(row) ?? []),
    players: value.players.flatMap(row => playerOf(row) ?? []),
    fetchedAt: value.fetchedAt,
  };
}

export async function loadProBoard(signal?: AbortSignal): Promise<ProBoardAnswer> {
  const request = new AbortController();
  const deadline = setTimeout(() => request.abort(), REQUEST_TIMEOUT_MS);
  const cancel = () => request.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const response = await fetch(`${API_BASE}/v1/pros-on-ladder`, { credentials: "omit", signal: request.signal });
    if (!response.ok) throw new Error("The pros board is unavailable.");
    const answer = readProBoard(await response.json());
    if (!answer) throw new Error("The pros board could not be read.");
    return answer;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", cancel);
  }
}

/** "grandmaster" as a label. */
export const leagueName = (league: string): string => league.charAt(0).toUpperCase() + league.slice(1);
