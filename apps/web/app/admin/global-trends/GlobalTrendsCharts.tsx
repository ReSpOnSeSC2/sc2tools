"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { TrendsOverviewLoading, useTrendsOverview } from "@/components/analyzer/TrendsOverview";
import { TrendsRequestError } from "@/components/analyzer/charts/TrendsRequestError";

const Charts = dynamic(() => import("@/components/analyzer/TrendsTab").then(module => module.TrendsTabView), {
  ssr: false,
  loading: TrendsOverviewLoading,
});

/** Keep the chart bundle out of denied or stalled admin requests. */
export function GlobalTrendsCharts() {
  const overview = useTrendsOverview();
  const { data, error, mutate } = overview.request;
  const [admitted, setAdmitted] = useState(false);
  useEffect(() => { if (data) setAdmitted(true); }, [data]);
  if (admitted || data) return <Charts overview={overview} />;
  if (error) return <div className="min-h-28"><TrendsRequestError title="Summary" error={error} retry={mutate} /></div>;
  return <TrendsOverviewLoading />;
}
