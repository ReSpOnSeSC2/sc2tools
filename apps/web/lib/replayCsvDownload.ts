import { API_BASE, buildApiError } from "./clientApi";
import { accountFilter } from "./accountFilter";

const KEYS = new Set(["since", "until", "patch_era", "race", "opp_race", "map", "map_exact", "mmr_min", "mmr_max", "opp_strategy", "build", "leak", "macro_min", "macro_max", "min_minutes", "max_minutes", "exclude_too_short", "regions", "accounts", "map_pool", "game_size", "result", "matchup", "search", "sort"]);

export function replayCsvPath(raw: string, opponentId?: string): string {
  if (opponentId !== undefined && (!opponentId.length || opponentId.length > 160 || opponentId.trim() !== opponentId || /[\u0000-\u001f\u007f]/u.test(opponentId))) throw new Error("Choose a recorded opponent before exporting.");
  const query = new URLSearchParams(), source = new URLSearchParams(raw.replace(/^\?/, "").split("#", 1)[0]);
  for (const [original, value] of source) {
    const key = original === "q" ? "search" : original;
    if (KEYS.has(key) || (opponentId !== undefined && ["mergeLinked", "analysisGameIds"].includes(key))) query.set(key, key === "accounts" ? accountFilter(value) ?? "" : value);
  }
  const base = opponentId === undefined ? "/v1/export.csv" : `/v1/opponents/${encodeURIComponent(opponentId)}/export.csv`;
  return `${base}${query.size ? `?${query}` : ""}`;
}

export async function fetchReplayCsv(getToken: () => Promise<string | null>, query: string, signal: AbortSignal, opponentId?: string): Promise<{ blob: Blob; truncated: boolean }> {
  const path = replayCsvPath(query, opponentId), token = await getToken();
  signal.throwIfAborted();
  if (!token) throw new Error("Sign in again to export your games.");
  const response = await fetch(`${API_BASE}${path}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal });
  if (!response.ok) {
    if (response.status === 429) throw new Error("Exports are limited to one per minute. Wait a minute, then try again.");
    throw new Error((await buildApiError(response)).message);
  }
  const blob = await response.blob();
  signal.throwIfAborted();
  return { blob, truncated: response.headers.get("X-Export-Truncated")?.toLowerCase() === "true" };
}

/** Download server-produced UTF-8/BOM CSV without modifying its safe cells. */
export function saveReplayCsv(blob: Blob, filename = "sc2tools-games.csv"): void {
  const url = URL.createObjectURL(blob), anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.style.display = "none";
  document.body.appendChild(anchor);
  try { anchor.click(); } finally { anchor.remove(); URL.revokeObjectURL(url); }
}
