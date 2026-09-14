"use client";

import type { SWRConfiguration } from "swr";
import { useApi, type ClientApiError } from "./clientApi";

// Allow the initial shared history build, then each card's bounded query.
export const GLOBAL_TRENDS_REQUEST_OPTIONS = { timeoutMs: 90_000 };
export const GLOBAL_TRENDS_SWR_CONFIG = {
  revalidateOnFocus: false,
  // Manual retry keeps an unavailable API from collecting repeated heavy work.
  shouldRetryOnError: false,
};

export function useGlobalTrendsApi<T>(path: string | null, config?: SWRConfiguration<T, ClientApiError>) {
  return useApi<T>(path, { ...GLOBAL_TRENDS_SWR_CONFIG, ...config }, GLOBAL_TRENDS_REQUEST_OPTIONS);
}
