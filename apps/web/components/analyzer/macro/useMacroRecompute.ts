"use client";

import { useEffect, useRef, useState } from "react";
import { useApi } from "@/lib/clientApi";
import type { MacroBreakdownData } from "./MacroBreakdownPanel.types";

/** One cached breakdown read and a bounded refresh after a request, scoped to its game. */
export function useMacroRecompute(gameId: string | null) {
  const resource = useApi<MacroBreakdownData>(gameId ? `/v1/games/${encodeURIComponent(gameId)}/macro-breakdown` : null, { revalidateOnFocus: false });
  const scope = useRef({ gameId, generation: 0, requesting: false });
  if (scope.current.gameId !== gameId) scope.current = { gameId, generation: scope.current.generation + 1, requesting: false };
  const generation = scope.current.generation;
  const mounted = useRef(true);
  const [stored, setStored] = useState({ generation: -1, pending: false, requested: false, message: "" });
  const state = stored.generation === generation ? stored : { generation, pending: false, requested: false, message: "" };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const recompute = async () => {
    if (!gameId || scope.current.requesting || typeof resource.request !== "function") return;
    scope.current.requesting = true;
    const current = () => mounted.current && scope.current.generation === generation;
    setStored({ generation, pending: true, requested: false, message: "Requesting analysis recompute…" });
    try {
      await resource.request({ method: "POST", body: JSON.stringify({}) });
      if (current()) setStored({ generation, pending: false, requested: true, message: "Analysis recompute requested. Keep your desktop agent connected; results will refresh shortly. This does not start a StarCraft recording." });
    } catch (failure) {
      if (current()) setStored({ generation, pending: false, requested: false, message: (failure as { message?: string })?.message || "Could not request analysis. Please try again." });
    } finally {
      if (current()) scope.current.requesting = false;
    }
  };

  const mutate = resource.mutate;
  useEffect(() => {
    if (!gameId || stored.generation !== generation || !stored.requested) return;
    const timers = [3000, 10000, 30000, 60000].map((delay) => window.setTimeout(() => {
      void Promise.resolve(mutate()).catch(() => undefined);
    }, delay));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [gameId, generation, stored, mutate]);

  return { ...resource, recompute, recomputing: state.pending, recomputeMsg: state.message || null };
}
