"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useMemo, useRef, useState } from "react";
import { boundedApiRequest, useApi } from "./clientApi";
import { emptyGhostBuildConfig, type GhostBuildConfig, type GhostMatchupKey, type GhostTarget } from "./ghostBuild";
import { GHOST_PREF_PATH, writeSynced, type GhostPatch } from "./ghostSyncIO";
import { GHOST_SYNC_EVENT, normalizeGhostSnapshot, readGhostPracticeCache, writeGhostPracticeCache } from "./ghostSyncModel";
import { useUserSocket } from "./useUserSocket";

export const GHOST_REQUEST_TIMEOUT = 20_000;
const EMPTY = emptyGhostBuildConfig();

/** One owner-keyed SWR resource across settings, replay grades and chrome.
 * Cached targets are displayed only after a failed lookup, with an offline
 * label. Unscoped old browser assignments are migration input, never another
 * signed-in account's fallback. */
export function useGhostPractice() {
  const { isLoaded, isSignedIn, userId, getToken } = useAuth();
  const owner = isLoaded && isSignedIn && userId ? userId : null;
  const currentOwner = useRef(owner); currentOwner.current = owner;
  const active = useRef<AbortController | null>(null);
  const prefs = useApi<GhostBuildConfig | null>(GHOST_PREF_PATH, { keepPreviousData: false, revalidateOnFocus: true }, { timeoutMs: GHOST_REQUEST_TIMEOUT });
  const refresh = prefs.mutate;
  const [state, setState] = useState<{ owner: string | null; saving: boolean; error: string | null }>({ owner, saving: false, error: null });
  const [cache, setCache] = useState<{ owner: string; config: GhostBuildConfig | null } | null>(null);
  const latest = useRef<{ owner: string; config: GhostBuildConfig } | null>(null);
  if (latest.current?.owner !== owner) latest.current = null;
  useEffect(() => {
    currentOwner.current = owner;
    active.current?.abort(); active.current = null;
    setState({ owner, saving: false, error: null });
    setCache(owner ? { owner, config: readGhostPracticeCache(owner) } : null);
    return () => { currentOwner.current = null; const pending = active.current; active.current = null; pending?.abort(); };
  }, [owner]);
  const incoming = useMemo(() => !owner || prefs.isPreviousData ? null : normalizeGhostSnapshot(prefs.data), [owner, prefs.isPreviousData, prefs.data]);
  if (owner && incoming && (!latest.current || (incoming.revision ?? 0) >= (latest.current.config.revision ?? 0))) latest.current = { owner, config: incoming };
  const clean = owner && latest.current?.owner === owner ? latest.current.config : null;
  useEffect(() => {
    if (owner && clean) writeGhostPracticeCache(owner, clean);
  }, [owner, clean]);
  useUserSocket(useMemo(() => owner ? {
    "ghost:changed": (value: unknown) => { if (value === true) void refresh().catch(() => {}); },
    connect: () => { void refresh().catch(() => {}); },
  } : null, [owner, refresh]));

  const save = async (patch: GhostPatch) => {
    if (!owner || currentOwner.current !== owner || active.current) return false;
    const captured = owner;
    const controller = new AbortController(); active.current = controller;
    const stillCurrent = () => currentOwner.current === captured && active.current === controller && !controller.signal.aborted;
    setState({ owner: captured, saving: true, error: null });
    try {
      const saved = await boundedApiRequest(async signal => {
        const token = await getToken();
        signal.throwIfAborted();
        if (!token || !stillCurrent()) throw new DOMException("Sign-in changed", "AbortError");
        return writeSynced(() => Promise.resolve(token), patch, signal);
      }, GHOST_REQUEST_TIMEOUT, controller.signal);
      if (!stillCurrent()) return false;
      // A later device save may already be cached while this HTTP response was
      // held in transit. Keep its higher revision and revalidate afterward.
      await prefs.mutate(current => (current?.revision ?? 0) > (saved.revision ?? 0) ? current : saved, false);
      if (!stillCurrent()) return false;
      writeGhostPracticeCache(captured, saved);
      setCache({ owner: captured, config: saved });
      window.dispatchEvent(new Event(GHOST_SYNC_EVENT));
      setState({ owner: captured, saving: false, error: null });
      // A simultaneous edit in another browser may have committed afterward.
      void prefs.mutate().catch(() => {});
      return true;
    } catch {
      if (stillCurrent()) setState({ owner: captured, saving: false, error: "Couldn't confirm the Ghost assignment. Try again." });
      return false;
    } finally { if (active.current === controller) active.current = null; }
  };
  const offline = !!owner && !!prefs.error;
  const config = owner ? clean ?? (offline && cache?.owner === owner ? cache.config : null) ?? EMPTY : EMPTY;
  return {
    owner, config, hasConfig: !!clean, offline, loading: !!owner && prefs.data === undefined && !prefs.error,
    saving: !!owner && state.owner === owner && state.saving,
    error: owner && state.owner === owner ? state.error : null,
    readError: owner ? prefs.error : null,
    assign: (matchup: GhostMatchupKey, target: GhostTarget | null, expectedTarget?: GhostTarget | null) => save({ matchup, target, ...(expectedTarget !== undefined ? { expectedTarget } : {}) }),
    migrate: (merge: GhostBuildConfig) => save({ merge, onlyEmpty: true }),
    retry: () => { void prefs.mutate().catch(() => {}); },
  };
}
