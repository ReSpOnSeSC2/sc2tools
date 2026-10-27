"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useSWRConfig, unstable_serialize } from "swr";
import { apiCall, useOwnerRequestScope } from "@/lib/clientApi";
import { ACTIVATION_PATH, FIRST_GAME_VIEWED_PATH, validActivation, type ActivationResponse } from "@/lib/activation";

type GameAdmission = { data?: { gameId: string } | null; error?: unknown; isPreviousData: boolean; isLoading: boolean };
type Lifetime = { owner: string | null; gameId: string; active: boolean };

/** Only a successful current private game body can record this server-once marker. */
export function useFirstGameViewed(gameId: string, admission: GameAdmission) {
  const { isLoaded, isSignedIn, userId, getToken } = useAuth();
  const owner = isLoaded && isSignedIn && userId ? userId : null;
  const runOwned = useOwnerRequestScope(owner, getToken);
  const request = useRef(runOwned); request.current = runOwned;
  const { cache, mutate } = useSWRConfig();
  const ref = useRef<Lifetime>({ owner, gameId, active: !!owner });
  if (ref.current.owner !== owner || ref.current.gameId !== gameId) {
    ref.current.active = false;
    ref.current = { owner, gameId, active: !!owner };
  }
  const lifetime = ref.current;
  const [result, setResult] = useState<{ lifetime: Lifetime; phase: "pending" | "recorded" | "unavailable" } | null>(null);
  const admitted = !!owner && !!gameId && admission.data?.gameId === gameId && !admission.error
    && admission.isLoading === false && admission.isPreviousData === false;
  useLayoutEffect(() => { lifetime.active = !!owner; return () => { lifetime.active = false; }; }, [lifetime, owner]);
  useEffect(() => {
    if (!admitted || !lifetime.owner) return;
    const key = ["authenticated-api", lifetime.owner, ACTIVATION_PATH] as const;
    const existing = cache.get(unstable_serialize(key))?.data;
    if (validActivation(existing) && existing.firstGameViewed) return;
    const controller = new AbortController();
    const assertRecord = () => { if (!lifetime.active || ref.current !== lifetime || controller.signal.aborted) throw new DOMException("Game changed", "AbortError"); };
    const issuingRequest = request.current;
    setResult({ lifetime, phase: "pending" });
    void issuingRequest(lifetime.owner, async (scopedToken, signal, assertOwner) => {
      const token = async () => { assertRecord(); const value = await scopedToken(); assertRecord(); return value; };
      assertRecord();
      const ack = await apiCall<{ firstGameViewed: boolean }>(token, FIRST_GAME_VIEWED_PATH, { method: "PUT", body: JSON.stringify({ gameId }), signal });
      assertOwner(); assertRecord();
      if (ack.firstGameViewed !== true) throw new Error("The game-view marker was not confirmed.");
      if (cache.get(unstable_serialize(key))?.data !== undefined) await mutate<ActivationResponse>(key, value => {
        assertOwner(); assertRecord();
        return validActivation(value) ? { ...value, firstGameViewed: true } : value;
      }, { revalidate: false });
      assertOwner(); assertRecord(); setResult({ lifetime, phase: "recorded" });
    }, 15_000, controller.signal).catch(() => {
      if (lifetime.active && ref.current === lifetime && !controller.signal.aborted) setResult({ lifetime, phase: "unavailable" });
    });
    return () => controller.abort();
  }, [admitted, lifetime, gameId, cache, mutate]);
  return result && result.lifetime === lifetime ? result.phase : "idle";
}
