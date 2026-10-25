"use client";
import { useAuth } from "@clerk/nextjs";
import { useEffect, useRef, useState } from "react";
import { apiCall } from "./clientApi";
import { rivalRequest } from "./rivalRequest";

export type RivalSummaryGroup = { key: string; pulseIds: string[]; primaryPulseId: string };
export type RivalSummary = { generatedAt: string; hasAnyGames: boolean; recentComplete: boolean; weekGames: Record<string, number>; rivals: {
  key: string; sampleGames: number; matchingGames: number; lastMeeting: string | null;
  streak: { kind: "win" | "loss"; count: number; atLeast: boolean } | null;
  usualOpener: { name: string; share: number; samples: number; of: number } | null;
  pulse: { change: { delta: number; baselineAt: string; currentAt: string } | null; fetchedAt: string | null } | null;
  live: { platform: string; url: string; observedAt: string }[];
}[] };

/** One explicit bounded metadata batch. Owner + exact filter/identity scope
 * fence both the token wait and response. No polling or prior-cohort data. */
export function useRivalSummary(groups: RivalSummaryGroup[], query: string, revision: number, enabled: boolean) {
  const { userId, getToken, isLoaded, isSignedIn } = useAuth();
  const authenticatedOwner = isLoaded && isSignedIn && userId ? userId : null;
  const [attempt, setAttempt] = useState(0);
  const body = JSON.stringify({ groups });
  const scope = `${authenticatedOwner || ""}\n${query}\n${body}\n${revision}\n${attempt}`;
  const current = useRef(scope); current.current = scope;
  const active = useRef<AbortController | null>(null);
  const [state, setState] = useState<{ scope: string; data?: RivalSummary; error?: boolean; loading?: boolean }>({ scope: "" });
  useEffect(() => {
    if (!enabled || !authenticatedOwner) return;
    const controller = new AbortController();
    active.current = controller;
    setState({ scope, loading: true });
    void (async () => {
      try {
        const data = await rivalRequest(controller, async () => {
          const token = await getToken();
          controller.signal.throwIfAborted();
          if (current.current !== scope || active.current !== controller) throw new DOMException("Scope changed", "AbortError");
          if (!token) throw new Error("Sign in again to read rival details.");
          return apiCall<RivalSummary>(() => Promise.resolve(token), `/v1/rivals/summary${query}`, { method: "POST", body, signal: controller.signal });
        });
        if (current.current === scope && active.current === controller && !controller.signal.aborted) setState({ scope, data });
      } catch {
        if (current.current === scope && active.current === controller) setState({ scope, error: true });
      }
    })();
    return () => { if (active.current === controller) active.current = null; controller.abort(); };
  }, [body, scope, query, enabled, authenticatedOwner, getToken]);
  const matches = !!authenticatedOwner && enabled && state.scope === scope;
  return { data: matches ? state.data : undefined, error: matches && !!state.error, loading: !!authenticatedOwner && enabled && (!matches || !!state.loading), retry: () => setAttempt(value => value + 1) };
}
