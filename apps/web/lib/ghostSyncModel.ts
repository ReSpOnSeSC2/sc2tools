import { normalizeGhostBuildConfig, type GhostBuildConfig } from "./ghostBuild";

export const MAX_GHOST_JSON_BYTES = 64 * 1024;
/** Synced transport bound; the old compact fragment codec stays compatible. */
export function normalizeSyncedGhostBuildConfig(input: unknown): GhostBuildConfig | null {
  try {
    const json = JSON.stringify(input);
    if (!json || new TextEncoder().encode(json).byteLength > MAX_GHOST_JSON_BYTES) return null;
    return normalizeGhostBuildConfig(input);
  } catch { return null; }
}

/** Read metadata is server-owned; it is never copied into slot writes. */
export function normalizeGhostSnapshot(input: unknown): GhostBuildConfig | null {
  const config = normalizeSyncedGhostBuildConfig(input);
  if (!config) return null;
  const revision = (input as { revision?: unknown }).revision;
  if (revision !== undefined && (!Number.isSafeInteger(revision) || typeof revision !== "number" || revision < 0)) return null;
  return { ...config, ...(typeof revision === "number" ? { revision } : {}) };
}

const CACHE_PREFIX = "sc2tools:ghost-build:account:v2:";
export const GHOST_SYNC_EVENT = "sc2tools:ghost-build-armed";
export function readGhostPracticeCache(owner: string): GhostBuildConfig | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + owner);
    return raw && raw.length <= MAX_GHOST_JSON_BYTES ? normalizeGhostSnapshot(JSON.parse(raw)) : null;
  } catch { return null; }
}
export function writeGhostPracticeCache(owner: string, config: GhostBuildConfig): void {
  try {
    const clean = normalizeGhostSnapshot(config);
    const previous = readGhostPracticeCache(owner);
    if (clean && (clean.revision ?? 0) >= (previous?.revision ?? 0)) localStorage.setItem(CACHE_PREFIX + owner, JSON.stringify(clean));
  } catch { /* Account save still succeeds when browser storage is unavailable. */ }
}
