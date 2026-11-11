"use client";

import { useMemo } from "react";
import { Card, Skeleton } from "@/components/ui/Card";
import { filtersToQuery, useFilters } from "@/lib/filterContext";
import { dayName } from "@/lib/i18n/format";
import { useFormat } from "@/lib/i18n/useFormat";
import { clientTimezone, type ApiTimeseriesResponse } from "@/lib/timeseries";
import { useTrendsApi } from "@/lib/trendsDataContext";
import { useLocalStorageState } from "@/lib/useLocalStorageState";

type Bucket = "day" | "week" | "month";
const isBucket = (value: unknown): value is Bucket => value === "day" || value === "week" || value === "month";

export function useTrendsOverview() {
  const { filters, dbRev } = useFilters();
  const [bucket, setBucket] = useLocalStorageState<Bucket>("analyzer.trends.bucket", "week", isBucket);
  const tz = useMemo(clientTimezone, []);
  const weekStart = dayName(useFormat().weekStartDay);
  const request = useTrendsApi<ApiTimeseriesResponse>(`/v1/timeseries${filtersToQuery({ ...filters, interval: bucket, tz, weekStart })}#${dbRev}`);
  return { bucket, setBucket, tz, request };
}

export type TrendsOverview = ReturnType<typeof useTrendsOverview>;

export function TrendsOverviewLoading() {
  return <div role="status" aria-label="Loading summary" className="grid min-h-28 grid-cols-2 gap-3 md:grid-cols-4">
    {[0, 1, 2, 3].map(key => <Card key={key}><Skeleton rows={2} /></Card>)}
  </div>;
}
