"use client";
import { useAuth } from "@clerk/nextjs";
import { useEffect, useRef, useState } from "react";
import { apiCall } from "./clientApi";

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
  const [attempt, setAttempt] = useState(0);
  const body = JSON.stringify({ groups });
  const scope = `${userId || ""}\n${query}\n${body}\n${revision}\n${attempt}`;
  const current = useRef(scope); current.current = scope;
  const [state, setState] = useState<{ scope: string; data?: RivalSummary; error?: boolean; loading?: boolean }>({ scope: "" });
  useEffect(() => {
    if (!enabled || !isLoaded || !isSignedIn || !userId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    setState({ scope, loading: true });
    void (async () => {
      try {
        const token = await getToken();
        if (current.current !== scope || controller.signal.aborted) return;
        const data = await apiCall<RivalSummary>(() => Promise.resolve(token), `/v1/rivals/summary${query}`, { method: "POST", body, signal: controller.signal });
        if (current.current === scope && !controller.signal.aborted) setState({ scope, data });
      } catch {
        if (current.current === scope) setState({ scope, error: true });
      } finally { clearTimeout(timer); }
    })();
    return () => { clearTimeout(timer); controller.abort(); };
  }, [body, scope, query, enabled, userId, getToken, isLoaded, isSignedIn]);
  const matches = enabled && state.scope === scope;
  return { data: matches ? state.data : undefined, error: matches && !!state.error, loading: enabled && (!matches || !!state.loading), retry: () => setAttempt(value => value + 1) };
}
