"use client";

import { useApi } from "@/lib/clientApi";
import { useFilters } from "@/lib/filterContext";
import type { GoalsResponse } from "@/lib/goals";

/**
 * GET /v1/goals for the signed-in player. ``dbRev`` (bumped on
 * ``games:changed``) is a fragment, so a new replay refetches progress
 * without the fragment ever reaching the API.
 */
export function useGoals() {
  const { dbRev } = useFilters();
  return useApi<GoalsResponse>(`/v1/goals#${dbRev}`, { keepPreviousData: true, revalidateOnFocus: false });
}
