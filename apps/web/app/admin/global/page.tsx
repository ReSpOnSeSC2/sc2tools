"use client";
import { Suspense } from "react";
import { useApi, type ClientApiError } from "@/lib/clientApi";
import { RequestError } from "@/components/ui/RequestError";
import { AdminPageHeader } from "../components/AdminPageHeader";
import { AdminPlayersList } from "../components/AdminPlayersList";
import { BreakdownList } from "../components/BreakdownList";
import { ForbiddenCard, LoadingRows, MetricStat } from "../components/AdminFragments";
import { compactNumber } from "../components/format";
import type { GlobalSummaryResp, GlobalBreakdownsResp } from "../components/adminTypes";

/**
 * /admin/global — platform-wide tracking.
 *
 * Three stacked sections, each backed by its own admin endpoint:
 *   1. Summary counters (distinct players merged across users, raw
 *      opponent rows, users tracking, total games, shared SC2Pulse
 *      cache coverage).
 *   2. Global trend breakdowns — the most common opponent strategies,
 *      our builds, and maps across every user's games.
 *   3. A searchable, sortable global player browser: the same real
 *      opponent tracked by multiple users is merged into one row with a
 *      "tracked by N" count.
 */
function GlobalBody() {
  const summary = useApi<GlobalSummaryResp>("/v1/admin/global/summary", { keepPreviousData: true });
  const breakdowns = useApi<GlobalBreakdownsResp>("/v1/admin/global/breakdowns", { keepPreviousData: true });

  if (summary.error?.status === 403 || breakdowns.error?.status === 403) {
    return <ForbiddenCard />;
  }

  return (
    <div className="space-y-6">
      <AdminPageHeader anchor="global-trends" title="Global players" description="Platform-wide players and aggregate activity." />
      <details className="text-caption text-text-muted"><summary>Learn more</summary><p className="text-text-muted">
          Everything the platform tracks, aggregated across every user —
          merged player records plus the most common strategies, builds,
          and maps. The same real opponent faced by several users is
          collapsed into a single record.
        </p></details>

      <SummarySection
        data={summary.data ?? null}
        error={summary.error ?? null}
        onRetry={() => summary.mutate()}
        isLoading={summary.isLoading}
      />

      <BreakdownsSection
        data={breakdowns.data ?? null}
        error={breakdowns.error ?? null}
        onRetry={() => breakdowns.mutate()}
        isLoading={breakdowns.isLoading}
      />

      <AdminPlayersList />
    </div>
  );
}

function SummarySection({
  data,
  error,
  isLoading,
  onRetry,
}: {
  data: GlobalSummaryResp | null;
  error: ClientApiError | null;
  isLoading: boolean;
  onRetry: () => unknown;
}) {
  if (error) {
    return <RequestError error={error} onRetry={onRetry} />;
  }
  if (isLoading && !data) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl bg-bg-elevated" />
        ))}
      </div>
    );
  }
  if (!data) return null;
  const resolvedPct =
    data.cache.total > 0
      ? Math.round((data.cache.resolved / data.cache.total) * 100)
      : 0;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <MetricStat
        label="Tracked players"
        value={compactNumber(data.trackedPlayers)}
        caption={`${compactNumber(data.opponentRows)} per-user rows`}
      />
      <MetricStat
        label="Users tracking"
        value={compactNumber(data.usersTracking)}
        caption="have ≥ 1 opponent"
      />
      <MetricStat
        label="Total games"
        value={compactNumber(data.totalGames)}
        caption="across all users"
      />
      <MetricStat
        label="Pulse resolved"
        value={compactNumber(data.cache.resolved)}
        caption={`${resolvedPct}% of ${compactNumber(data.cache.total)} cached`}
      />
      <MetricStat
        label="MMR cached"
        value={compactNumber(data.cache.mmrCached)}
        caption="shared across users"
      />
    </div>
  );
}

function BreakdownsSection({
  data,
  error,
  isLoading,
  onRetry,
}: {
  data: GlobalBreakdownsResp | null;
  error: ClientApiError | null;
  isLoading: boolean;
  onRetry: () => unknown;
}) {
  if (error) {
    return <RequestError error={error} onRetry={onRetry} />;
  }
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <BreakdownList
        title="Opponent strategies"
        subtitle="most common across users"
        rows={data?.strategies ?? null}
        isLoading={isLoading}
        onRetry={onRetry}
      />
      <BreakdownList
        title="Our builds"
        subtitle="most played across users"
        rows={data?.builds ?? null}
        isLoading={isLoading}
        onRetry={onRetry}
      />
      <BreakdownList
        title="Maps"
        subtitle="most played across users"
        rows={data?.maps ?? null}
        isLoading={isLoading}
        onRetry={onRetry}
      />
    </div>
  );
}

export default function AdminGlobalPage() { return <Suspense fallback={<LoadingRows rows={8} />}><GlobalBody /></Suspense>; }
