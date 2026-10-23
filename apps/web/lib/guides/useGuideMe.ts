"use client";

import { useAuth } from "@clerk/nextjs";
import { useApi } from "@/lib/clientApi";
import type { GuideMePayload } from "./types";

/** Both guide islands share useApi's account-scoped SWR identity and one request. */
export function useGuideMe(matchupSlug: string, buildSlug: string) {
  const { isLoaded, isSignedIn } = useAuth();
  const query = useApi<GuideMePayload>(isLoaded && isSignedIn ? `/v1/guides/me/${matchupSlug}/${buildSlug}` : null, { shouldRetryOnError: false });
  return { ...query, isLoaded, isSignedIn: Boolean(isLoaded && isSignedIn && query.error?.status !== 401) };
}
