"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useRef, useState } from "react";
import { apiCall, useApi } from "./clientApi";
import { opponentPlayerKey, type GroupableOpponent, type PulseLink } from "./opponentGroups";
import { rivalRequest, RIVAL_REQUEST_TIMEOUT_MS } from "./rivalRequest";

export const MAX_RIVALS = 50;
const EMPTY_KEYS: string[] = [];
type RivalIdentity = Pick<GroupableOpponent, "pulseId" | "pulseCharacterId" | "globalIdentity">;
export function rivalKeys(row: RivalIdentity & { identities?: RivalIdentity[] }, links?: Record<string, PulseLink> | null) {
  const identities = row.identities || [row];
  return [...new Set([opponentPlayerKey(row, links), ...identities.flatMap(identity => {
    const link = identity.pulseCharacterId ? links?.[identity.pulseCharacterId] : null;
    return [opponentPlayerKey(identity, links), ...(link?.proId ? [`pro:${link.proId}`] : []), ...(link?.accountId ? [`acct:${link.accountId}`] : []), `solo:${identity.pulseId}`];
  })])];
}

/** Reads use the account-keyed API cache. A late token or save from another
 * signed-in account cannot publish a write or change the current UI. */
export function useRivals() {
  const { userId, getToken, isLoaded, isSignedIn } = useAuth();
  const authenticatedOwner = isLoaded && isSignedIn && userId ? userId : null;
  const prefs = useApi<{ keys?: string[] }>("/v1/me/preferences/rivals", { revalidateOnFocus: false }, { timeoutMs: RIVAL_REQUEST_TIMEOUT_MS });
  const owner = useRef(authenticatedOwner); owner.current = authenticatedOwner;
  const active = useRef<AbortController | null>(null);
  const [state, setState] = useState<{ owner: string | null | undefined; saving: boolean; error: string | null }>({ owner: userId, saving: false, error: null });
  useEffect(() => {
    active.current?.abort(); active.current = null;
    return () => { const pending = active.current; active.current = null; pending?.abort(); };
  }, [authenticatedOwner]);
  const keys = !authenticatedOwner || prefs.isPreviousData ? EMPTY_KEYS : prefs.data?.keys || EMPTY_KEYS;
  const saving = !!authenticatedOwner && state.owner === authenticatedOwner && state.saving;
  const toggle = async (candidates: string[]) => {
    if (!authenticatedOwner || owner.current !== authenticatedOwner || active.current || prefs.isLoading || prefs.error || !prefs.data || !candidates.length) return;
    const capturedOwner = authenticatedOwner;
    const selected = candidates.some(key => keys.includes(key));
    const next = keys.filter(key => !candidates.includes(key));
    if (!selected) next.push(candidates[0]);
    if (next.length > MAX_RIVALS) { setState({ owner: userId, saving: false, error: "You can star up to 50 rivals. Remove a star first." }); return; }
    const controller = new AbortController(); active.current = controller;
    setState({ owner: userId, saving: true, error: null });
    try {
      const saved = await rivalRequest(controller, async () => {
        const token = await getToken();
        controller.signal.throwIfAborted();
        if (owner.current !== capturedOwner || active.current !== controller) throw new DOMException("Owner changed", "AbortError");
        if (!token) throw new Error("Sign in again to save rivals.");
        return apiCall<{ keys: string[] }>(() => Promise.resolve(token), "/v1/me/preferences/rivals", { method: "PUT", body: JSON.stringify({ keys: next }), signal: controller.signal });
      });
      if (owner.current === capturedOwner && active.current === controller && !controller.signal.aborted) {
        await prefs.mutate(saved, false);
        if (owner.current === capturedOwner && active.current === controller && !controller.signal.aborted) setState({ owner: capturedOwner, saving: false, error: null });
      }
    } catch {
      if (owner.current === capturedOwner && active.current === controller) setState({ owner: capturedOwner, saving: false, error: "Couldn't confirm your rivals. Try again." });
    } finally { if (active.current === controller) active.current = null; }
  };
  return { owner: authenticatedOwner, keys, toggle, saving, loading: !authenticatedOwner || prefs.isLoading || (!prefs.data && !prefs.error), error: authenticatedOwner && state.owner === authenticatedOwner ? state.error : null, unavailable: !!authenticatedOwner && !!prefs.error, retry: () => { void prefs.mutate().catch(() => {}); } };
}
