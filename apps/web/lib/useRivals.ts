"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useRef, useState } from "react";
import { apiCall, useApi } from "./clientApi";
import { opponentPlayerKey, type GroupableOpponent, type PulseLink } from "./opponentGroups";

export const MAX_RIVALS = 50;
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
  const { userId, getToken } = useAuth();
  const prefs = useApi<{ keys?: string[] }>("/v1/me/preferences/rivals", { revalidateOnFocus: false });
  const owner = useRef(userId); owner.current = userId;
  const active = useRef<AbortController | null>(null);
  const [state, setState] = useState<{ owner: string | null | undefined; saving: boolean; error: string | null }>({ owner: userId, saving: false, error: null });
  useEffect(() => { active.current?.abort(); active.current = null; return () => active.current?.abort(); }, [userId]);
  const keys = prefs.isPreviousData ? [] : prefs.data?.keys || [];
  const saving = state.owner === userId && state.saving;
  const toggle = async (candidates: string[]) => {
    if (!userId || active.current || prefs.isLoading || prefs.error || !prefs.data || !candidates.length) return;
    const capturedOwner = userId;
    const selected = candidates.some(key => keys.includes(key));
    const next = keys.filter(key => !candidates.includes(key));
    if (!selected) next.push(candidates[0]);
    if (next.length > MAX_RIVALS) { setState({ owner: userId, saving: false, error: "You can star up to 50 rivals. Remove a star first." }); return; }
    const controller = new AbortController(); active.current = controller;
    setState({ owner: userId, saving: true, error: null });
    try {
      const token = await getToken();
      if (owner.current !== capturedOwner || controller.signal.aborted) return;
      const saved = await apiCall<{ keys: string[] }>(() => Promise.resolve(token), "/v1/me/preferences/rivals", { method: "PUT", body: JSON.stringify({ keys: next }), signal: controller.signal });
      if (owner.current === capturedOwner && !controller.signal.aborted) { await prefs.mutate(saved, false); setState({ owner: capturedOwner, saving: false, error: null }); }
    } catch {
      if (owner.current === capturedOwner && !controller.signal.aborted) setState({ owner: capturedOwner, saving: false, error: "Couldn't save your rivals. Try again." });
    } finally { if (active.current === controller) active.current = null; }
  };
  return { owner: userId || null, keys, toggle, saving, loading: prefs.isLoading || !prefs.data, error: state.owner === userId ? state.error : null, unavailable: !!prefs.error };
}
