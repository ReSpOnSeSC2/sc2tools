import { recordFailedRequest } from "./feedback/failedRequests";
import { normalizeGhostSnapshot } from "./ghostSyncModel";
import type { GhostBuildConfig, GhostMatchupKey, GhostTarget } from "./ghostBuild";

export const GHOST_PREF_PATH = "/v1/me/preferences/ghost";
export type GhostPatch = { matchup: GhostMatchupKey; target: GhostTarget | null; expectedTarget?: GhostTarget | null }
  | { merge: GhostBuildConfig; onlyEmpty: true };

/** This transport must remain framework-free. ghostBuild is also used by
 * server-rendered guides; importing a client-bound Clerk/SWR module here makes
 * Next register that entire client graph before the practice action is used.
 * Scoped callers provide the token fence, cancellation and real deadline. */
async function request(getToken: () => Promise<string | null>, init: RequestInit): Promise<unknown> {
  const token = await getToken(); init.signal?.throwIfAborted();
  if (!token) throw Object.assign(new Error("Sign in again to use practice assignments."), { status: 401, code: "auth_required" });
  let res: Response;
  try {
    res = await fetch(`${process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8080"}${GHOST_PREF_PATH}`, {
      ...init, cache: "no-store", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    });
  } catch (error) {
    if (error instanceof TypeError) recordFailedRequest({ path: GHOST_PREF_PATH, status: 0, code: "network_unavailable" });
    throw error;
  }
  if (!res.ok) {
    const raw = await res.json().catch(() => null);
    const code = typeof raw?.error?.code === "string" && raw.error.code.length <= 100 ? raw.error.code : undefined;
    const requestId = typeof raw?.error?.requestId === "string" && raw.error.requestId.length <= 100 ? raw.error.requestId : undefined;
    const message = code === "ghost_config_changed" ? "This matchup changed in another browser. Refresh the assignment and try again."
      : code === "invalid_ghost_config" ? "Ghost accepts up to 80 steps per build and 64KiB across all slots. Choose a shorter opening or clear a slot."
        : res.status === 401 ? "Sign in again to use practice assignments." : "Couldn't confirm Ghost settings. Try again.";
    recordFailedRequest({ path: GHOST_PREF_PATH, status: res.status, code, requestId });
    throw Object.assign(new Error(message), { status: res.status, code, requestId });
  }
  return res.json();
}

export async function readSynced(getToken: () => Promise<string | null>, signal?: AbortSignal): Promise<GhostBuildConfig | null> {
  const raw = await request(getToken, { signal });
  if (raw === null) return null;
  const clean = normalizeGhostSnapshot(raw);
  if (!clean) throw new Error("The saved Ghost configuration could not be read.");
  return clean;
}
export async function writeSynced(getToken: () => Promise<string | null>, patch: GhostPatch, signal?: AbortSignal): Promise<GhostBuildConfig> {
  const raw = await request(getToken, { method: "PATCH", body: JSON.stringify(patch), signal });
  const clean = normalizeGhostSnapshot(raw);
  if (!clean) throw new Error("The Ghost assignment could not be confirmed.");
  return clean;
}
