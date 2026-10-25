import { API_BASE, buildApiError } from "./clientApi";
import { accountFilter } from "./accountFilter";

const KEYS = new Set(["since", "until", "patch_era", "race", "opp_race", "map", "map_exact", "mmr_min", "mmr_max", "opp_strategy", "build", "leak", "macro_min", "macro_max", "min_minutes", "max_minutes", "exclude_too_short", "regions", "accounts", "map_pool", "game_size", "result", "matchup", "search", "sort"]);

export function replayCsvPath(raw: string): string {
  const query = new URLSearchParams(), source = new URLSearchParams(raw.replace(/^\?/, "").split("#", 1)[0]);
  for (const [original, value] of source) {
    const key = original === "q" ? "search" : original;
    if (KEYS.has(key)) query.set(key, key === "accounts" ? accountFilter(value) ?? "" : value);
  }
  return `/v1/export.csv${query.size ? `?${query}` : ""}`;
}

export async function fetchReplayCsv(getToken: () => Promise<string | null>, query: string, signal: AbortSignal): Promise<{ blob: Blob; truncated: boolean }> {
  const path = replayCsvPath(query), token = await getToken();
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
export function saveReplayCsv(blob: Blob): void {
  const url = URL.createObjectURL(blob), anchor = document.createElement("a");
  anchor.href = url; anchor.download = "sc2tools-games.csv"; anchor.style.display = "none";
  document.body.appendChild(anchor);
  try { anchor.click(); } finally { anchor.remove(); URL.revokeObjectURL(url); }
}
