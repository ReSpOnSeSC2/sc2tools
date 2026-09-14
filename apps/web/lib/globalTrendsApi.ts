"use client";

import type { SWRConfiguration } from "swr";
import { useApi, type ClientApiError } from "./clientApi";

export const GLOBAL_TRENDS_REQUEST_OPTIONS = { timeoutMs: 60_000 };
export const GLOBAL_TRENDS_SWR_CONFIG = {
  revalidateOnFocus: false,
  // Manual retry keeps an unavailable API from collecting repeated heavy work.
  shouldRetryOnError: false,
};

export function useGlobalTrendsApi<T>(path: string | null, config?: SWRConfiguration<T, ClientApiError>) {
  return useApi<T>(path, { ...GLOBAL_TRENDS_SWR_CONFIG, ...config }, GLOBAL_TRENDS_REQUEST_OPTIONS);
}
