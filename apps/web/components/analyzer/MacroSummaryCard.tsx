"use client";

import { useCallback, useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Gauge, RefreshCcw } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { apiCall, useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { scoreToneTextClass } from "@/lib/macro";

type MacroSummaryResp = {
  ok?: boolean;
  gamesTotal: number;
  gamesWithMacro: number;
  gamesMissingMacro: number;
  avgScore: number | null;
  leaks: Array<{ name: string; count: number; totalMinerals: number }>;
};

type BackfillStatusResp = {
  ok?: boolean;
  running?: boolean;
  status?: "pending" | "running" | "done" | string;
  total?: number;
  done?: number;
  updated?: number;
  errors?: number;
};

/**
 * Macro-tab header: average score across the filtered game set, the
 * most expensive recurring leaks (summed mineral cost), and coverage.
 * When older games predate macro scoring, offers a one-click backfill
 * that relays a recompute request to the user's desktop agent via the
 * existing /v1/macro/backfill API and tracks the job until it drains.
 */
export function MacroSummaryCard() {
  const { filters, dbRev } = useFilters();
  const { getToken } = useAuth();
  const query = useMemo(() => filtersToQuery(filters), [filters]);
  const { data, isLoading, mutate } = useApi<MacroSummaryResp>(
    `/v1/macro/summary${query}#${dbRev}`,
  );

  const [jobId, setJobId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // Poll the job while one is active. SWR's refreshInterval handles
  // the cadence; we stop polling (interval 0) once the job reports
  // done so an idle tab doesn't ping forever.
  const { data: job } = useApi<BackfillStatusResp>(
    jobId ? `/v1/macro/backfill/status?jobId=${encodeURIComponent(jobId)}` : null,
    {
      refreshInterval: (latest?: BackfillStatusResp) =>
        latest && latest.status !== "done" ? 4000 : 0,
      onSuccess: (latest: BackfillStatusResp) => {
        if (latest?.status === "done") mutate();
      },
    },
  );

  const startBackfill = useCallback(async () => {
    if (starting) return;
    setStarting(true);
    setStartError(null);
    try {
      const out = await apiCall<{ ok: boolean; jobId: string; total: number }>(
        getToken,
        "/v1/macro/backfill/start",
        {
          method: "POST",
          body: JSON.stringify({ reason: "macro_tab_backfill" }),
        },
      );
      setJobId(out.jobId);
    } catch (err) {
      const e = err as { message?: string };
      setStartError(e.message || "Couldn't start the backfill.");
    } finally {
      setStarting(false);
    }
  }, [getToken, starting]);

  if (isLoading) {
    return (
      <Card>
        <Skeleton rows={2} />
      </Card>
    );
  }
  if (!data || data.gamesTotal === 0) return null;

  const jobRunning = !!jobId && job?.status !== "done";
  const coveragePct = data.gamesTotal
    ? Math.round((data.gamesWithMacro / data.gamesTotal) * 100)
    : 0;

  return (
    <Card>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border-2 border-line bg-bg-elevated">
            <Gauge className="h-6 w-6 text-accent-cyan" aria-hidden />
          </div>
          <div>
            <div className="text-micro uppercase tracking-wider text-text-dim">
              Average macro score
            </div>
            <div
              className={`text-3xl font-bold tabular-nums ${scoreToneTextClass(data.avgScore)}`}
            >
              {data.avgScore != null ? data.avgScore : "—"}
            </div>
            <div className="mt-0.5 text-caption text-text-dim">
              {data.gamesWithMacro.toLocaleString()} of{" "}
              {data.gamesTotal.toLocaleString()} games scored ({coveragePct}%)
            </div>
          </div>
        </div>

        {data.leaks.length > 0 ? (
          <div className="min-w-0 flex-1 lg:max-w-md">
            <div className="text-micro uppercase tracking-wider text-text-dim">
              Most expensive recurring leaks
            </div>
            <ul className="mt-1.5 space-y-1">
              {data.leaks.slice(0, 3).map((leak) => (
                <li
                  key={leak.name}
                  className="flex items-baseline justify-between gap-3 text-sm"
                >
                  <span className="truncate text-text">{leak.name}</span>
                  <span className="shrink-0 tabular-nums text-text-muted">
                    ~{Math.round(leak.totalMinerals).toLocaleString()} minerals
                    <span className="text-text-dim"> · {leak.count}×</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {data.gamesMissingMacro > 0 || jobRunning ? (
          <div className="shrink-0 space-y-1.5 lg:text-right">
            {jobRunning ? (
              <Badge variant="cyan">
                Backfilling {job?.done ?? 0}/{job?.total ?? "…"}
                {job?.errors ? ` · ${job.errors} failed` : ""}
              </Badge>
            ) : (
              <Button
                variant="secondary"
                onClick={startBackfill}
                disabled={starting}
                iconLeft={<RefreshCcw className="h-4 w-4" aria-hidden />}
              >
                Score {data.gamesMissingMacro.toLocaleString()} older game
                {data.gamesMissingMacro === 1 ? "" : "s"}
              </Button>
            )}
            <p className="max-w-[16rem] text-micro text-text-dim">
              {jobRunning
                ? "Your desktop agent is re-parsing those replays and uploading scores."
                : "Needs your desktop agent online — it re-parses the replays locally."}
            </p>
            {startError ? (
              <p className="text-micro text-danger" role="alert">
                {startError}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
