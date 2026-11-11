export type StudioReplay = {
  key: string;
  date: string;
  map: string;
  opponent: string;
  build: string;
  result: "W" | "L" | "";
  matchup: string;
};

export type ShelfReplayContext = { d: string; m: string; o: ""; b: string; res: "W" | "L" | "" };

function text(raw: unknown, max = 180): string {
  return typeof raw === "string" ? raw.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, max) : "";
}

export function replayDay(raw: unknown): string {
  const value = typeof raw === "string" ? raw.slice(0, 10) : "";
  if (!/^\d{4}-\d\d-\d\d$/.test(value)) return "";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : "";
}

function result(raw: unknown): StudioReplay["result"] {
  const value = text(raw).toLowerCase();
  if (["w", "win", "victory"].includes(value)) return "W";
  if (["l", "loss", "defeat"].includes(value)) return "L";
  return "";
}

function race(raw: unknown): string {
  const value = text(raw).toLowerCase();
  return ({ terran: "T", protoss: "P", zerg: "Z", t: "T", p: "P", z: "Z" } as Record<string, string>)[value] ?? "";
}

function matchup(build: string, own: string, opponent: string): string {
  return own && opponent ? `${own}v${opponent}` : /^[TPZ]v[TPZ](?=\b|_)/.exec(build)?.[0] ?? "";
}

/** Converts only rows returned by the owner's replay list or the consent-gated
 * student endpoint. The API's remaining fields never enter authoring state. */
export function studioReplays(raw: unknown, source: "mine" | "student"): StudioReplay[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 1000).flatMap((row, index) => {
    if (!row || typeof row !== "object") return [];
    const own = source === "mine";
    const date = replayDay(own ? row.date : row.d);
    const map = text(own ? row.map : row.m);
    if (!date || !map) return [];
    const build = text(own ? row.myBuild : row.b);
    const opponent = own ? text(row.opponent?.displayName) : "";
    const key = own ? text(row.gameId) : "";
    return [{ key: key || `${date}/${map}/${index}`, date, map, opponent, build,
      result: result(own ? row.result : row.res), matchup: matchup(build, race(row.myRace), race(row.opponent?.race)) }];
  });
}

export function filterStudioReplays(rows: StudioReplay[], options: { search: string; matchup: string; since: string; until: string }) {
  const search = options.search.trim().toLowerCase();
  return rows.filter(row => (!options.since || row.date >= options.since) && (!options.until || row.date <= options.until)
    && (!options.matchup || row.matchup === options.matchup)
    && (!search || `${row.map} ${row.opponent} ${row.build}`.toLowerCase().includes(search)));
}

export function shelfReplayContext(replay: StudioReplay): ShelfReplayContext {
  // The search row is private. Store only the facts needed by the coaching
  // note, without a private game identifier or opponent name.
  return { d: replay.date, m: replay.map, o: "", b: replay.build, res: replay.result };
}

export function studioReplayTitle(replay: StudioReplay): string {
  return [replay.map, replay.matchup, replay.result === "W" ? "Win" : replay.result === "L" ? "Loss" : "", replay.date]
    .filter(Boolean).join(" · ").slice(0, 180);
}
