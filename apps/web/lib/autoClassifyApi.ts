"use client";

/**
 * Auto-classify discovery-engine client helpers.
 *
 * Wraps the two real endpoints the cloud router exposes
 * (`apps/api/src/routes/autoClassify.js`):
 *
 *   GET  /v1/auto-classify/candidates?perspective=you|opponent
 *   POST /v1/auto-classify/apply
 *
 * Uses the project's single Clerk-aware fetch stack (`useApi` +
 * `apiCall` from `@/lib/clientApi`) — there's no second fetcher here.
 */
import { useAuth } from "@clerk/nextjs";
import { useCallback } from "react";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import type {
  AutoApplyResult,
  AutoCandidate,
  AutoCandidatesResponse,
  BuildPerspective,
} from "@/components/builds/types";

/**
 * SWR-style hook over GET /v1/auto-classify/candidates. Returns the
 * parsed payload (perspective echo + candidate list) and forwards
 * SWR's loading / error / mutate handles so callers can render a
 * refresh button.
 *
 * The Clerk JWT is attached automatically — this is the same `useApi`
 * everything else in the frontend uses.
 */
export function useAutoCandidates(perspective: BuildPerspective) {
  const path = `/v1/auto-classify/candidates?perspective=${encodeURIComponent(
    perspective,
  )}`;
  const swr = useApi<AutoCandidatesResponse>(path);
  return {
    data: swr.data,
    candidates: swr.data?.candidates ?? [],
    isLoading: swr.isLoading,
    error: swr.error as ClientApiError | undefined,
    mutate: swr.mutate,
  };
}

/**
 * Promote one or more discovery candidates to real custom builds via
 * POST /v1/auto-classify/apply. Returns the service's summary so the
 * UI can render "Created N builds, tagged M games."
 *
 * Throws {@link ClientApiError} on failure (validation, auth, network)
 * exactly like every other mutation in the codebase.
 */
export async function applyAutoCandidates(
  getToken: () => Promise<string | null>,
  candidates: AutoCandidate[],
): Promise<AutoApplyResult> {
  return apiCall<AutoApplyResult>(getToken, "/v1/auto-classify/apply", {
    method: "POST",
    body: JSON.stringify({ candidates }),
  });
}

/**
 * Convenience hook for components that already have a Clerk auth
 * context — binds `getToken` once and returns a stable callback the
 * UI can pass to a button's onClick handler.
 */
export function useApplyAutoCandidates() {
  const { getToken } = useAuth();
  return useCallback(
    (candidates: AutoCandidate[]) => applyAutoCandidates(getToken, candidates),
    [getToken],
  );
}
