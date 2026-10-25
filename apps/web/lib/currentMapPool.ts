/** Live-pool names and replay names may differ by an edition suffix, never by a Roman numeral. */
export function currentMapPoolKey(value: unknown): string {
  const tokens = String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/['\u2019]/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (tokens.length >= 3 && tokens.slice(-2).join(" ") === "ladder edition") tokens.splice(-2);
  else if (tokens.length >= 2 && ["le", "te", "ce", "re"].includes(tokens.at(-1)!)) tokens.pop();
  return tokens.join("");
}

export type PoolMetadata = { mapPool?: string[]; mapPoolSource?: "liquipedia" | "persisted" | "fallback"; mapPoolFetchedAt?: number | null };
export const POOL_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;

export function currentPool(metadata?: PoolMetadata, now = Date.now()) {
  const seen = new Set<string>();
  const maps = (Array.isArray(metadata?.mapPool) ? metadata.mapPool : []).slice(0, 30).filter((name) => {
    if (typeof name !== "string" || name.length > 200) return false;
    const key = currentMapPoolKey(name); if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  });
  const fetchedAt = metadata?.mapPoolFetchedAt;
  const age = typeof fetchedAt === "number" && Number.isFinite(fetchedAt) && fetchedAt <= now + 300_000 ? Math.max(0, now - fetchedAt) : null;
  const fresh = maps.length > 0 && ["liquipedia", "persisted"].includes(metadata?.mapPoolSource ?? "") && age !== null && age <= POOL_MAX_AGE_MS;
  return { maps, fresh, age, source: metadata?.mapPoolSource ?? "unknown", fetchedAt: age === null ? null : fetchedAt };
}
