export type ReplayCursor = string | null;
export const replaySearch = (raw: string | null) => raw && raw.length <= 100 && !/[\u0000-\u001f\u007f]/.test(raw) ? raw : "";
export const replayResult = (raw: string | null): "all" | "win" | "loss" | "tie" => ["win", "loss", "tie"].includes(raw || "") ? raw as "win" | "loss" | "tie" : "all";
export const replayMatchup = (raw: string | null) => raw && /^[PTZR]v[PTZR]$/.test(raw) ? raw : "all";
export const replaySort = (raw: string | null): "date_desc" | "date_asc" => raw === "date_asc" ? raw : "date_desc";
export const replayCursor = (raw: string | null): ReplayCursor => raw && raw.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(raw) ? raw : null;
export function replayBefore(raw: string | null): string {
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) && Number.isFinite(Date.parse(`${raw}T00:00:00.000Z`)) && new Date(`${raw}T00:00:00.000Z`).toISOString().slice(0, 10) === raw ? raw : "";
}
/** The replay date only narrows the global window; it never extends it. */
export function replayUntil(globalUntil: string | null, before: string): string | null {
  if (!replayBefore(before)) return globalUntil;
  const end = `${before}T23:59:59.999Z`, global = globalUntil ? Date.parse(globalUntil) : NaN;
  return Number.isFinite(global) && global <= Date.parse(end) ? globalUntil : end;
}

type History = { key: string; cursors: ReplayCursor[]; firstPage: number | null };
const historyKey = (owner: string) => `sc2tools.replays.history:${owner}`;
function readHistories(owner: string): History[] {
  try {
    const raw = sessionStorage.getItem(historyKey(owner)); if (!raw || raw.length > 250000) return [];
    const rows: unknown = JSON.parse(raw);
    return Array.isArray(rows) ? rows.filter((row): row is History => row && typeof row.key === "string" && row.key.length <= 8192 && Array.isArray(row.cursors) && row.cursors.length <= 64 && row.cursors.every((cursor: unknown) => cursor === null || typeof cursor === "string" && replayCursor(cursor) === cursor) && (row.firstPage === null || Number.isSafeInteger(row.firstPage) && row.firstPage > 0)).slice(-12) : [];
  } catch { return []; }
}
export function replayPageMemory(owner: string, key: string, cursor: ReplayCursor) {
  const history = readHistories(owner).find(row => row.key === key), index = history?.cursors.indexOf(cursor) ?? -1;
  return { previous: history && index > 0 ? history.cursors[index - 1] : null,
    hasPrevious: index > 0, page: cursor === null ? 1 : history && index >= 0 && history.firstPage !== null ? history.firstPage + index : null };
}
export function rememberReplayPage(owner: string, key: string, cursor: ReplayCursor, next: string) {
  if (!replayCursor(next) || next === cursor || key.length > 8192) return;
  const rows = readHistories(owner), history = rows.find(row => row.key === key), index = history?.cursors.indexOf(cursor) ?? -1;
  let cursors = history && index >= 0 ? [...history.cursors.slice(0, index + 1), next] : [cursor, next];
  let firstPage = cursor === null ? 1 : history && index >= 0 ? history.firstPage : null;
  if (cursors.length > 64) { const trimmed = cursors.length - 64; cursors = cursors.slice(trimmed); if (firstPage !== null) firstPage += trimmed; }
  try {
    const retained = [...rows.filter(row => row.key !== key), { key, cursors, firstPage }].slice(-12);
    let serialized = JSON.stringify(retained);
    while (serialized.length > 250000 && retained.length > 1) { retained.shift(); serialized = JSON.stringify(retained); }
    sessionStorage.setItem(historyKey(owner), serialized);
  } catch { /* Without session storage, Back to newest remains available. */ }
}
export const replayRowMemoryKey = (owner: string) => `sc2tools.replays.row:${owner}`;
export function rememberReplayRow(owner: string, key: string, cursor: ReplayCursor, gameId: string) {
  try { sessionStorage.setItem(replayRowMemoryKey(owner), JSON.stringify({ key, cursor, gameId, href: `${location.pathname}${location.search}${location.hash}` })); } catch { /* Navigation still works without scroll restoration. */ }
}
export function replayScrollBehavior(): ScrollBehavior { return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"; }
