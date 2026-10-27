"use client";

import { useRef } from "react";
import { useAuth } from "@clerk/nextjs";
import { useApi } from "@/lib/clientApi";
import { validGap } from "./sessions";

export const SESSION_POLICY_PATH = "/v1/me/session-policy";
export type SessionPolicy = { gapMinutes: number; source: "preference" | "auto-overlay" | "auto-player"; storedGapMinutes: number | null };

export function readSessionPolicy(value: unknown): SessionPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 3 || !validGap(row.gapMinutes)) return null;
  if (row.source === "preference" && validGap(row.storedGapMinutes) && row.gapMinutes === row.storedGapMinutes) return row as SessionPolicy;
  if (row.storedGapMinutes === null && (row.source === "auto-overlay" && row.gapMinutes === 240 || row.source === "auto-player" && row.gapMinutes === 90)) return row as SessionPolicy;
  return null;
}

// A fresh JSON response (or validated Profile ACK) must keep its identity even
// when the three scalars equal the old policy. Always-false comparison would
// also destabilize SWR's external-store snapshots.
const samePolicyResponse = (left: unknown, right: unknown) => left === right;

/** One owner-scoped dataset read; no polling or fetch from a quiz generator. */
export function useSessionPolicy() {
  const { userId, isLoaded, isSignedIn } = useAuth();
  const owner = isLoaded && isSignedIn && userId ? userId : null;
  const response = useApi<unknown>(SESSION_POLICY_PATH, {
    revalidateOnMount: true, keepPreviousData: false, dedupingInterval: 0,
    compare: samePolicyResponse,
    revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false,
  }, { timeoutMs: 15_000 });
  const data = response.data;
  const admission = useRef({ owner, initialData: data });
  if (admission.current.owner !== owner) admission.current = { owner, initialData: data };
  // A settled warm entry carries false loading flags until SWR's scheduled
  // revalidation starts. Do not expose that initial object even on this render.
  // Concurrent consumers still share the pending GET; a new response or ACK
  // gives each consumer positive admission without relying on onSuccess.
  const waitingForCurrent = owner !== null && data === admission.current.initialData;
  const loading = response.isLoading || response.isValidating || (!response.error && waitingForCurrent);
  const policy = !owner || response.error || response.isPreviousData || loading ? null : readSessionPolicy(data);
  return { policy, loading, error: response.error?.message ?? (!loading && !policy ? "Session settings are unavailable. Retry before playing session quizzes." : null), retry: response.mutate };
}