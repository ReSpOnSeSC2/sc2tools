"use client";

import useSWR from "swr";
import { API_BASE } from "./clientApi";
import { guidesEnabled } from "./guides/flags";
import type { GuideIndexPayload } from "./guides/types";

/** One public, cacheable index contains every published map cell; never request each map. */
export function useGuideMapPool() {
  return useSWR<GuideIndexPayload>(guidesEnabled() ? "/v1/guides" : null, async (path: string) => {
    const response = await fetch(`${API_BASE}${path}`);
    if (!response.ok) throw new Error("Community map comparison is unavailable.");
    return response.json();
  }, { revalidateOnFocus: false, dedupingInterval: 60 * 60 * 1000 });
}
