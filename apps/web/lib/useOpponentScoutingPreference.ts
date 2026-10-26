"use client";

import { useAuth } from "@clerk/nextjs";
import { useLayoutEffect, useRef, useState } from "react";
import { apiCall, boundedApiRequest, useApi } from "./clientApi";

type Preference = { groupByPlayer: boolean };
const PATH = "/v1/me/preferences/opponentScouting";

/** One account-keyed preference shared by list/dossier and the server's live path. */
export function useOpponentScoutingPreference() {
  const { userId, isLoaded, isSignedIn, getToken } = useAuth();
  const owner = isLoaded && isSignedIn && userId ? userId : null;
  const current = useRef(owner); current.current = owner;
  const active = useRef<AbortController | null>(null);
  const [state, setState] = useState<{ owner: string | null; saving: boolean; error: string }>({ owner: null, saving: false, error: "" });
  const prefs = useApi<Preference>(owner ? PATH : null, { revalidateOnFocus: false }, { timeoutMs: 20_000 });
  useLayoutEffect(() => {
    setState({ owner, saving: false, error: "" });
    return () => { active.current?.abort(); active.current = null; };
  }, [owner]);
  const loading = !owner || prefs.isLoading || (!prefs.data && !prefs.error) || prefs.isPreviousData;
  const value = !!owner && !prefs.isPreviousData && (prefs.data ? prefs.data.groupByPlayer !== false : !prefs.error);
  const saving = !!owner && state.owner === owner && state.saving;
  const setValue = async (groupByPlayer: boolean) => {
    if (!owner || loading || prefs.error || active.current || typeof groupByPlayer !== "boolean") return false;
    const captured = owner, controller = new AbortController(); active.current = controller;
    setState({ owner: captured, saving: true, error: "" });
    try {
      const saved = await boundedApiRequest(signal => apiCall<Preference>(async () => {
        const token = await getToken();
        if (current.current !== captured || active.current !== controller) throw new DOMException("Account changed", "AbortError");
        signal.throwIfAborted(); return token;
      }, PATH, { method: "PUT", signal, body: JSON.stringify({ groupByPlayer }) }), 20_000, controller.signal);
      if (typeof saved.groupByPlayer !== "boolean") throw new Error("Invalid grouping response");
      if (current.current !== captured || active.current !== controller || controller.signal.aborted) return false;
      await prefs.mutate(saved, false);
      if (current.current !== captured || active.current !== controller || controller.signal.aborted) return false;
      return true;
    } catch {
      if (current.current === captured && active.current === controller) setState({ owner: captured, saving: false, error: "Couldn’t save grouping. Your last saved choice is kept; try again." });
      return false;
    } finally {
      if (active.current === controller) { active.current = null; setState(previous => ({ ...previous, saving: false })); }
    }
  };
  return { groupByPlayer: value, setGroupByPlayer: setValue, loading, saving,
    error: owner && state.owner === owner ? state.error || (prefs.error ? "Couldn’t load your saved grouping. Retry to use it." : "") : "",
    unavailable: !!owner && !!prefs.error, retry: () => { void prefs.mutate().catch(() => {}); } };
}
