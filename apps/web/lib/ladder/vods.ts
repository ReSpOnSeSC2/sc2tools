import { API_BASE } from "@/lib/apiBase";
import { formatNumber } from "@/lib/i18n/format";

export type Race = "terran" | "zerg" | "protoss" | "random";

/** One ladder game with a Twitch VOD. The other player is never part of it (ADR 0075). */
export type LadderVod = {
  /** Twitch VOD link that opens at the game; one per game, so it also identifies the card. */
  vodUrl: string;
  /** The streamer's channel login; null when Twitch did not name it. */
  channel: string | null;
  subscribersOnly: boolean;
  streamerRace: Race;
  opponentRace: Race;
  /** The streamer's rating, rounded to 100 by the server. */
  rating: number;
  map: string;
  durationSec: number;
  playedAt: string;
};

export type LadderVodsPage = { results: LadderVod[]; next: string | null; fetchedAt: string };
/** A map the server offers, by SC2Pulse id. The menu comes from the server's live ladder pool, so a rotation needs no web change. */
export type MapChoice = { id: string; name: string };
/** `available: false` is the server's gate: the finder is not open yet. */
export type LadderVodsAnswer = { available: false } | ({ available: true; maps: MapChoice[] } & LadderVodsPage);

/** The menu choices; "" means any. */
export type LadderFilters = { matchup: string; rating: string; length: string; map: string };

export const ANY_FILTERS: LadderFilters = { matchup: "", rating: "", length: "", map: "" };
/** What the page first shows: the games people ask about most, at high rating. */
export const DEFAULT_FILTERS: LadderFilters = { ...ANY_FILTERS, matchup: "tvz", rating: "5000" };

type Option = { value: string; label: string };

export const MATCHUP_OPTIONS: readonly Option[] = [
  { value: "", label: "Any matchup" },
  { value: "tvz", label: "Terran vs Zerg" },
  { value: "tvp", label: "Terran vs Protoss" },
  { value: "zvp", label: "Zerg vs Protoss" },
  { value: "tvt", label: "Terran vs Terran" },
  { value: "zvz", label: "Zerg vs Zerg" },
  { value: "pvp", label: "Protoss vs Protoss" },
];
export const RATING_OPTIONS: readonly Option[] = [
  { value: "", label: "Any rating" },
  { value: "0", label: "Under 3,000" },
  { value: "3000", label: "3,000 to 3,999" },
  { value: "4000", label: "4,000 to 4,999" },
  { value: "5000", label: "5,000 to 5,999" },
  { value: "6000", label: "6,000 and up" },
];
export const LENGTH_OPTIONS: readonly Option[] = [
  { value: "", label: "Any length" },
  { value: "0", label: "Under 5 minutes" },
  { value: "5", label: "5 to 10 minutes" },
  { value: "10", label: "10 to 15 minutes" },
  { value: "15", label: "15 to 20 minutes" },
  { value: "20", label: "20 minutes and up" },
];
/** "Any map", then the maps the server offers. */
export function mapOptions(maps: readonly MapChoice[]): Option[] {
  return [{ value: "", label: "Any map" }, ...maps.map(map => ({ value: map.id, label: map.name }))];
}

const RACE_NAMES: Record<Race, string> = { terran: "Terran", zerg: "Zerg", protoss: "Protoss", random: "Random" };
/** Above the server's own worst case (a queued turn, SC2Pulse, then the Twitch names). */
const REQUEST_TIMEOUT_MS = 20_000;
const CHANNEL_PATTERN = /^[A-Za-z0-9_]{1,25}$/;

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null;
const isRace = (value: unknown): value is Race => typeof value === "string" && value in RACE_NAMES;

const TWITCH_HOSTS = new Set(["www.twitch.tv", "twitch.tv"]);

/** The VOD link opens only on Twitch, whatever the server sent. */
function vodLinkOf(value: unknown): string | null {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && TWITCH_HOSTS.has(url.host) && url.pathname.startsWith("/videos/") ? url.href : null;
  } catch {
    return null;
  }
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isText = (value: unknown): value is string => typeof value === "string" && value !== "";
const isDate = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));
const channelOf = (value: unknown): string | null => (typeof value === "string" && CHANNEL_PATTERN.test(value) ? value : null);

function readVod(value: unknown): LadderVod | null {
  if (!isRow(value)) return null;
  const { streamerRace, opponentRace, rating, durationSec, map, playedAt } = value;
  const vodUrl = vodLinkOf(value.vodUrl);
  if (!vodUrl || !isRace(streamerRace) || !isRace(opponentRace)) return null;
  if (!isCount(rating) || !isCount(durationSec) || !isText(map) || !isDate(playedAt)) return null;
  return {
    vodUrl,
    channel: channelOf(value.channel),
    subscribersOnly: value.subscribersOnly === true,
    streamerRace,
    opponentRace,
    rating,
    map,
    durationSec,
    playedAt,
  };
}

function readMap(value: unknown): MapChoice | null {
  return isRow(value) && isText(value.id) && isText(value.name) ? { id: value.id, name: value.name } : null;
}

/** Validates the API answer; a shape it does not recognise is not shown. */
export function readLadderVods(value: unknown): LadderVodsAnswer | null {
  if (!isRow(value)) return null;
  if (value.available === false) return { available: false };
  if (value.available !== true || !Array.isArray(value.results) || typeof value.fetchedAt !== "string") return null;
  const next = typeof value.next === "string" && value.next ? value.next : null;
  const maps = Array.isArray(value.maps) ? value.maps.flatMap(map => readMap(map) ?? []) : [];
  return { available: true, maps, results: value.results.flatMap(row => readVod(row) ?? []), next, fetchedAt: value.fetchedAt };
}

/** The request for a search: only the menus that are set, then the page cursor. */
export function ladderVodsUrl(filters: LadderFilters, after: string | null): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
  if (after) query.set("after", after);
  const text = query.toString();
  return `${API_BASE}/v1/ladder-vods${text ? `?${text}` : ""}`;
}

export async function loadLadderVods(filters: LadderFilters, after: string | null, signal?: AbortSignal): Promise<LadderVodsAnswer> {
  const request = new AbortController();
  const deadline = setTimeout(() => request.abort(), REQUEST_TIMEOUT_MS);
  const cancel = () => request.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const response = await fetch(ladderVodsUrl(filters, after), { credentials: "omit", signal: request.signal });
    if (!response.ok) throw new Error("The ladder VOD search is unavailable.");
    const answer = readLadderVods(await response.json());
    if (!answer) throw new Error("The ladder VOD search could not be read.");
    return answer;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", cancel);
  }
}

export const raceName = (race: Race): string => RACE_NAMES[race];

export function ratingLabel(rating: number): string {
  return `${formatNumber(rating)} MMR`;
}

/** "12 min", "1 h 5 min"; whole minutes, as the game list shows them. */
export function lengthLabel(durationSec: number): string {
  const minutes = Math.max(1, Math.round(durationSec / 60));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function sameFilters(a: LadderFilters, b: LadderFilters): boolean {
  return a.matchup === b.matchup && a.rating === b.rating && a.length === b.length && a.map === b.map;
}
