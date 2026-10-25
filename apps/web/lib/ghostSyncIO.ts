import { apiCall } from "./clientApi";
import { normalizeGhostSnapshot } from "./ghostSyncModel";
import type { GhostBuildConfig, GhostMatchupKey, GhostTarget } from "./ghostBuild";

export const GHOST_PREF_PATH = "/v1/me/preferences/ghost";
export type GhostPatch = { matchup: GhostMatchupKey; target: GhostTarget | null; expectedTarget?: GhostTarget | null }
  | { merge: GhostBuildConfig; onlyEmpty: true };

export async function readSynced(getToken: () => Promise<string | null>, signal?: AbortSignal): Promise<GhostBuildConfig | null> {
  const raw = await apiCall<unknown>(getToken, GHOST_PREF_PATH, { signal });
  if (raw === null) return null;
  const clean = normalizeGhostSnapshot(raw);
  if (!clean) throw new Error("The saved Ghost configuration could not be read.");
  return clean;
}
export async function writeSynced(getToken: () => Promise<string | null>, patch: GhostPatch, signal?: AbortSignal): Promise<GhostBuildConfig> {
  const raw = await apiCall<unknown>(getToken, GHOST_PREF_PATH, { method: "PATCH", body: JSON.stringify(patch), signal });
  const clean = normalizeGhostSnapshot(raw);
  if (!clean) throw new Error("The Ghost assignment could not be confirmed.");
  return clean;
}
