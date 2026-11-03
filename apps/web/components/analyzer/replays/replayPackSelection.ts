import { packText, recordedReplayResult, validPackUnicode, type PackNameMetadata } from "@/lib/exports/replayPacks/packNames";
import { readPackBytes, type PackWorkScope } from "@/lib/exports/replayPacks/packReaders";
import { ExportDownloadError } from "@/lib/exports/exportErrors";

export type PackSelectionRow = PackNameMetadata & { replaySizeBytes: number | null };
export const PACK_SELECTION_LIMIT = 100;
const invalid = () => new ExportDownloadError("invalid");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
export function packSelectionRow(value: unknown): PackSelectionRow {
  const row = object(value), raw = row.gameId;
  if (typeof raw !== "string" || raw.length > 200 || !validPackUnicode(raw) || /[\u0000-\u001f\u007f-\u009f]/u.test(raw)) throw invalid();
  const gameId = raw.trim();
  if (!gameId || /^[a-z][a-z0-9+.-]*:/iu.test(gameId) || /^[/\\]{2}/u.test(gameId)) throw invalid();
  const opponent = row.opponent && typeof row.opponent === "object" && !Array.isArray(row.opponent) ? (row.opponent as Record<string, unknown>).displayName : undefined;
  const size = row.replaySizeBytes;
  return Object.freeze({ gameId, date: packText(row.date, 32), map: packText(row.map, 120), matchup: packText(row.matchup, 32),
    opponent: packText(opponent, 100), result: recordedReplayResult(row.result),
    replaySizeBytes: typeof size === "number" && Number.isSafeInteger(size) && size >= 4 && size <= 5 * 1024 ** 2 ? size : null });
}

/** One existing list request, current sort, no cursor-following or merge/truncation. */
export function matchingReplayQuery(query: string): string {
  const params = new URLSearchParams(query); params.delete("cursor"); params.set("limit", "100"); params.set("enrich", "none");
  return params.toString();
}
export function parseMatchingReplays(value: unknown): readonly PackSelectionRow[] {
  const body = object(value);
  if (!Array.isArray(body.items) || body.items.length > PACK_SELECTION_LIMIT) throw invalid();
  const rows = body.items.map(packSelectionRow), ids = new Set(rows.map(row => row.gameId));
  if (ids.size !== rows.length) throw invalid();
  return Object.freeze(rows);
}
export async function selectMatchingReplays(apiBase: string, query: string, scope: PackWorkScope & { token: () => Promise<string | null> }, fetcher: typeof fetch = fetch): Promise<readonly PackSelectionRow[]> {
  const current = () => { scope.signal.throwIfAborted(); scope.assertCurrent(); };
  try {
    current(); const token = await scope.token(); current(); if (!token) throw new ExportDownloadError("failed");
    const response = await fetcher(`${apiBase}/v1/replays?${matchingReplayQuery(query)}`, { signal: scope.signal,
      headers: { authorization: `Bearer ${token}` }, cache: "no-store", credentials: "omit", redirect: "error" });
    const bytes = await readPackBytes(response, scope, 1024 ** 2); current();
    if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw invalid();
    const rows = parseMatchingReplays(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); current(); return rows;
  } catch (error) { throw scope.signal.aborted ? new ExportDownloadError("cancelled") : error instanceof ExportDownloadError ? error : new ExportDownloadError("invalid"); }
}
