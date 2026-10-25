import { gameSourceFilters } from "./gameSourceFilters";

export type GameSource = { href: string; label: string; filters?: string; sampled?: boolean };
export type GameNeighborScope = "all" | "opponent" | "matchup" | "build";

/** Only local list routes can become a game backlink. Never chain game pages. */
export function safeGameSource(raw: unknown, label?: unknown, filters?: unknown, sampled?: unknown): GameSource | null {
  if (typeof raw !== "string" || raw.length > 2048 || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  try {
    const url = new URL(raw, "https://sc2tools.invalid");
    if (url.origin !== "https://sc2tools.invalid" || !/^\/(?:app|builds)(?:\/|$)/.test(url.pathname) || /^\/app\/game(?:\/|$)/.test(url.pathname)) return null;
    const tab = url.searchParams.get("tab");
    const inferred = url.pathname.startsWith("/app/replays") || tab === "replays" ? "Replays" : url.pathname.startsWith("/app/opponents") || tab === "opponents" ? "Opponents" : url.pathname.startsWith("/app/maps") || tab === "battlefield" ? "Maps" : url.pathname.startsWith("/app/macro") || tab === "macro" ? "Macro" : tab === "builds" || url.pathname.startsWith("/app/builds") || url.pathname.startsWith("/builds") ? "Builds" : "Today";
    return { href: `${url.pathname}${url.search}${url.hash}`, label: typeof label === "string" && label.trim() ? label.trim().slice(0, 100) : inferred,
      ...(typeof filters === "string" ? { filters: gameSourceFilters(filters) } : {}), ...(sampled === true || sampled === "1" ? { sampled: true } : {}) };
  } catch { return null; }
}

export function gameSourceFromQuery(query: Record<string, string | string[] | undefined>): GameSource | null {
  const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
  return safeGameSource(first(query.from), first(query.fromLabel), first(query.fromFilters), first(query.fromSample));
}

export function isGameNeighborScope(value: unknown): value is GameNeighborScope {
  return typeof value === "string" && ["all", "opponent", "matchup", "build"].includes(value);
}

/** The Navigation API exposes the actual previous entry; other browsers use the durable source link. */
export function previousEntryMatchesSource(source: GameSource, browser: Window = window): boolean {
  try {
    const navigation = (browser as Window & { navigation?: { currentEntry?: { index: number }; entries: () => { url?: string }[] } }).navigation;
    if (!navigation?.currentEntry || navigation.currentEntry.index < 1) return false;
    const previous = navigation.entries()[navigation.currentEntry.index - 1]?.url;
    if (!previous) return false;
    const url = new URL(previous);
    return url.origin === browser.location.origin && `${url.pathname}${url.search}${url.hash}` === source.href;
  } catch { return false; }
}

export function backToGameSource(event: { defaultPrevented: boolean; button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault: () => void }, source: GameSource | null): void {
  if (event.defaultPrevented || !source || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !previousEntryMatchesSource(source)) return;
  event.preventDefault();
  window.history.back();
}
