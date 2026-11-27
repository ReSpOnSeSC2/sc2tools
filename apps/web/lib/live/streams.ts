import { API_BASE } from "@/lib/apiBase";
import { formatNumber } from "@/lib/i18n/format";

export type LivePlatform = "twitch" | "kick";
/** `off` is a platform the server has no credentials for; the rest describe the last refresh. */
export type PlatformState = "ok" | "stale" | "error" | "off";

export type LiveStream = {
  id: string;
  platform: LivePlatform;
  channel: string;
  title: string;
  /** Lower-case two- or three-letter code, or `other`. */
  language: string;
  viewers: number;
  startedAt: string;
  url: string;
};

export type LiveStreamsSnapshot = {
  streams: LiveStream[];
  platforms: Record<LivePlatform, PlatformState>;
  fetchedAt: string;
};

export type PlatformFilter = "all" | LivePlatform;
export type LiveSort = "viewers" | "small";
export type LiveFilters = { platform: PlatformFilter; language: string; sort: LiveSort };

export const DEFAULT_FILTERS: LiveFilters = { platform: "all", language: "all", sort: "viewers" };
export const PLATFORM_NAMES: Record<LivePlatform, string> = { twitch: "Twitch", kick: "Kick" };

const CHANNEL_HOSTS: Record<LivePlatform, string> = { twitch: "www.twitch.tv", kick: "kick.com" };
const STATES: readonly PlatformState[] = ["ok", "stale", "error", "off"];
const REQUEST_TIMEOUT_MS = 10_000;

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null;
const isPlatform = (value: unknown): value is LivePlatform => value === "twitch" || value === "kick";
const isState = (value: unknown): value is PlatformState => STATES.includes(value as PlatformState);

/** Links go only to the platform's own channel page, whatever the server sent. */
function channelUrl(platform: LivePlatform, value: unknown): string | null {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && url.host === CHANNEL_HOSTS[platform] ? url.href : null;
  } catch {
    return null;
  }
}

function readStream(value: unknown): LiveStream | null {
  if (!isRow(value) || !isPlatform(value.platform)) return null;
  const url = channelUrl(value.platform, value.url);
  if (!url || typeof value.id !== "string" || typeof value.channel !== "string" || !value.channel) return null;
  return {
    id: value.id,
    platform: value.platform,
    channel: value.channel,
    title: typeof value.title === "string" ? value.title : "",
    language: typeof value.language === "string" && value.language ? value.language : "other",
    viewers: typeof value.viewers === "number" && value.viewers > 0 ? Math.trunc(value.viewers) : 0,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : "",
    url,
  };
}

/** Validates the API answer; a shape it does not recognise is not shown. */
export function readLiveStreams(value: unknown): LiveStreamsSnapshot | null {
  if (!isRow(value) || !Array.isArray(value.streams) || !isRow(value.platforms)) return null;
  const { twitch, kick } = value.platforms;
  if (!isState(twitch) || !isState(kick) || typeof value.fetchedAt !== "string") return null;
  const streams = value.streams.flatMap(row => readStream(row) ?? []);
  return { streams, platforms: { twitch, kick }, fetchedAt: value.fetchedAt };
}

export async function loadLiveStreams(signal?: AbortSignal): Promise<LiveStreamsSnapshot> {
  const request = new AbortController();
  const deadline = setTimeout(() => request.abort(), REQUEST_TIMEOUT_MS);
  signal?.addEventListener("abort", () => request.abort(), { once: true });
  try {
    const response = await fetch(`${API_BASE}/v1/live-streams`, { credentials: "omit", signal: request.signal });
    if (!response.ok) throw new Error("The live stream list is unavailable.");
    const snapshot = readLiveStreams(await response.json());
    if (!snapshot) throw new Error("The live stream list could not be read.");
    return snapshot;
  } finally {
    clearTimeout(deadline);
  }
}

/** Language codes present in the list, most streams first. */
export function languagesIn(streams: readonly LiveStream[]): string[] {
  const counts = new Map<string, number>();
  for (const stream of streams) counts.set(stream.language, (counts.get(stream.language) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([code]) => code);
}

const BY_VIEWERS = (a: LiveStream, b: LiveStream) => b.viewers - a.viewers || a.id.localeCompare(b.id);
const SMALL_FIRST = (a: LiveStream, b: LiveStream) => a.viewers - b.viewers || a.id.localeCompare(b.id);

/** Applies the platform and language filters, then the chosen order. */
export function applyFilters(streams: readonly LiveStream[], filters: LiveFilters): LiveStream[] {
  return streams
    .filter(stream => filters.platform === "all" || stream.platform === filters.platform)
    .filter(stream => filters.language === "all" || stream.language === filters.language)
    .sort(filters.sort === "small" ? SMALL_FIRST : BY_VIEWERS);
}

/** A platform whose list could not be refreshed, for the notice above the cards. */
export function degradedPlatforms(platforms: LiveStreamsSnapshot["platforms"]): LivePlatform[] {
  return (Object.keys(platforms) as LivePlatform[]).filter(key => platforms[key] === "stale" || platforms[key] === "error");
}

/** True when the server has no platform to ask, so an empty list means nothing. */
export function listingIsOff(platforms: LiveStreamsSnapshot["platforms"]): boolean {
  return platforms.twitch === "off" && platforms.kick === "off";
}

/** "Portuguese" for `pt`; falls back to the upper-case code. */
export function languageName(code: string): string {
  if (code === "other") return "Other";
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

export function viewerLabel(viewers: number): string {
  return `${formatNumber(viewers)} ${viewers === 1 ? "viewer" : "viewers"}`;
}

/** "2 h 5 min" since `startedAt`; empty when the time is missing or in the future. */
export function liveForLabel(startedAt: string, now: number): string {
  const started = Date.parse(startedAt);
  const minutes = Math.floor((now - started) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0) return "";
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
