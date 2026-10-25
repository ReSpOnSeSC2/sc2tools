import type { ReplayLibraryResponse } from "@/components/analyzer/replays/types";

export type BuildStartReplayPage = Pick<ReplayLibraryResponse, "items" | "page">;
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === "string" ? value.slice(0, 500) : null;

/** A private picker needs only a bounded identity/display page. An older or
 * malformed 200 response follows the same inline recovery as a failed read. */
export function readBuildStartReplayPage(value: unknown): BuildStartReplayPage {
  const response = record(value), page = record(response?.page);
  const invalid = () => new Error("The replay list returned an unexpected response. Retry to load it again.");
  if (!response || !Array.isArray(response.items) || response.items.length > 20 || !page || typeof page.hasMore !== "boolean"
    || !(page.nextCursor === null || (typeof page.nextCursor === "string" && page.nextCursor.length > 0 && page.nextCursor.length <= 2048))
    || (page.hasMore && !page.nextCursor)) throw invalid();
  const seen = new Set<string>();
  const items = response.items.map(value => {
    const row = record(value), id = row?.gameId;
    if (!row || typeof id !== "string" || !id.trim() || id !== id.trim() || id.length > 256 || seen.has(id)) throw invalid();
    seen.add(id);
    const date = text(row.date);
    return { gameId: id, date: date && Number.isFinite(Date.parse(date)) ? date : null,
      map: text(row.map), result: text(row.result), myBuild: text(row.myBuild), opponent: { displayName: text(record(row.opponent)?.displayName) } };
  });
  return { items, page: { hasMore: page.hasMore, nextCursor: page.nextCursor as string | null } };
}
