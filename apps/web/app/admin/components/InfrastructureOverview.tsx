"use client";

import type { ReactNode } from "react";

import { Card } from "@/components/ui/Card";
import {
  formatBinaryBytes,
  formatBytes,
  formatUsd,
  timeSince,
} from "./format";
import type {
  AdminInfrastructureResp,
  InfrastructureAdvisory,
  InfrastructureLevel,
  InfrastructurePercentStats,
} from "./adminTypes";

type Props = {
  data: AdminInfrastructureResp | null;
  error: string | null;
  isLoading: boolean;
};

export function InfrastructureOverview({ data, error, isLoading }: Props) {
  if (isLoading && !data) {
    return (
      <section aria-labelledby="provider-capacity-heading" className="space-y-3">
        <SectionHeading status={null} asOf={null} />
        <div className="grid gap-3 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <div
              key={index}
              className="h-72 animate-pulse rounded-xl bg-bg-elevated"
            />
          ))}
        </div>
      </section>
    );
  }

  if (error || !data) {
    return (
      <section aria-labelledby="provider-capacity-heading" className="space-y-3">
        <SectionHeading status={null} asOf={null} />
        <Card padded>
          <div role="alert" className="space-y-1">
            <p className="font-semibold text-warning">
              Capacity monitoring is unavailable
            </p>
            <p className="text-body text-text-muted">
              No provider cost or upgrade recommendation has been inferred
              {error ? `: ${error}` : "."}
            </p>
          </div>
        </Card>
      </section>
    );
  }

  return (
    <section aria-labelledby="provider-capacity-heading" className="space-y-3">
      <SectionHeading status={data.overallStatus} asOf={data.asOf} />

      <div aria-live="polite">
        {data.advisories.length > 0 ? (
          <AdvisoryList advisories={data.advisories} />
        ) : (
          <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-body text-text-muted">
            <span className="h-2 w-2 flex-none rounded-full bg-success" aria-hidden />
            No tier change is recommended from the current provider signals.
          </div>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <CloudflareCard provider={data.providers.cloudflare} />
        <MongoCard provider={data.providers.mongo} />
        <RenderCard provider={data.providers.render} />
      </div>

      <p className="text-caption text-text-dim">
        Costs are running estimates, not final invoices. Capacity notices use
        recent provider telemetry and appear when configured watch or upgrade
        thresholds are crossed.
      </p>
    </section>
  );
}

function SectionHeading({
  status,
  asOf,
}: {
  status: InfrastructureLevel | null;
  asOf: string | null;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-2">
      <div className="space-y-1">
        <h2 id="provider-capacity-heading" className="text-h3 font-semibold text-text">
          Provider costs &amp; capacity
        </h2>
        <p className="text-body text-text-muted">
          Cloudflare R2, MongoDB Atlas, and Render in one view.
        </p>
      </div>
      <div className="flex items-center gap-2">
        {asOf ? (
          <span className="text-caption text-text-dim">
            updated {timeSince(asOf)}
          </span>
        ) : null}
        {status ? <StatusPill status={status} /> : null}
      </div>
    </div>
  );
}

function AdvisoryList({ advisories }: { advisories: InfrastructureAdvisory[] }) {
  return (
    <Card padded={false}>
      <Card.Header>
        <h3 className="text-caption font-semibold uppercase tracking-wider text-text">
          Capacity notices
        </h3>
        <span className="text-caption text-text-dim">
          {advisories.length} active
        </span>
      </Card.Header>
      <ul className="divide-y divide-border">
        {advisories.map((item) => (
          <li key={item.code} className="flex gap-3 px-4 py-3">
            <span
              className={`mt-1.5 h-2.5 w-2.5 flex-none rounded-full ${statusDot(item.level)}`}
              aria-hidden
            />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-text">{item.title}</span>
                <span className="rounded-full border border-border px-2 py-0.5 text-micro font-semibold uppercase tracking-wider text-text-dim">
                  {providerLabel(item.provider)}
                </span>
                <span className="sr-only">{statusLabel(item.level)} notice</span>
              </div>
              <p className="text-body text-text-muted">{item.message}</p>
              <p className="text-caption font-medium text-text">{item.action}</p>
              {item.metric && item.value !== null && item.threshold !== null ? (
                <p className="text-caption tabular-nums text-text-dim">
                  {formatAdvisoryValue(item.metric, item.value)} observed ·{" "}
                  {formatAdvisoryValue(item.metric, item.threshold)} {item.level} line
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function CloudflareCard({
  provider,
}: {
  provider: AdminInfrastructureResp["providers"]["cloudflare"];
}) {
  const usage = provider.usage;
  const cost = provider.cost;
  const ops = usage
    ? `${formatCount(usage.classARequests)} A · ${formatCount(usage.classBRequests)} B`
    : "Unavailable";

  return (
    <ProviderCard
      name="Cloudflare R2"
      status={provider.status}
      stale={provider.stale}
      measuredAt={provider.measuredAt}
      primaryLabel="Current cost estimate"
      primaryValue={moneyPerMonth(cost?.estimatedCurrentMonthlyUsd)}
      available={provider.available}
    >
      <MetricRow
        label="Archive stored"
        value={nullableBytes(usage?.storedBytes, false)}
        detail={usage
          ? `${formatCount(usage.verifiedOriginalReplays)} originals · ${formatCount(usage.objectCount)} objects`
          : "Usage snapshot unavailable"}
      />
      <MetricRow
        label="Operations this cycle"
        value={ops}
        detail={usage?.billingCycleStart
          ? `since ${formatShortDate(usage.billingCycleStart)}`
          : "Billing-cycle date unavailable"}
      />
      <MetricRow
        label="Estimate breakdown"
        value={cost
          ? `${money(cost.storageMonthlyRunRateUsd)} storage`
          : "Unavailable"}
        detail={cost
          ? `${money(cost.classAThisCycleUsd)} Class A · ${money(cost.classBThisCycleUsd)} Class B`
          : "No cost inferred"}
      />
      {usage?.unknownRequests ? (
        <p className="text-caption text-warning">
          {formatCount(usage.unknownRequests)} operations are unclassified.
        </p>
      ) : null}
    </ProviderCard>
  );
}

function MongoCard({
  provider,
}: {
  provider: AdminInfrastructureResp["providers"]["mongo"];
}) {
  const cluster = provider.cluster;
  const performance = cluster?.performance ?? null;
  const costValue = provider.cost.pricingMode === "atlas_projected"
    ? provider.cost.projectedMonthlyUsd
    : provider.cost.planningMonthlyUsd;
  const costLabel = provider.cost.pricingMode === "atlas_projected"
    ? "Projected month"
    : "Planning baseline";

  return (
    <ProviderCard
      name="MongoDB Atlas"
      status={provider.status}
      stale={provider.stale}
      measuredAt={provider.measuredAt}
      primaryLabel={costLabel}
      primaryValue={moneyPerMonth(costValue)}
      available={provider.available}
    >
      <MetricRow
        label="Cluster"
        value={cluster?.tier?.toUpperCase() || "Unavailable"}
        detail={cluster
          ? `${cluster.autoExpandStorage ? "storage auto-expand on" : "storage auto-expand off"}${cluster.provisionedDiskGb !== null ? ` · ${cluster.provisionedDiskGb} GB provisioned` : ""}`
          : "Atlas capacity monitoring unavailable"}
      />
      <UtilizationRow
        label="Disk"
        value={cluster?.diskUtilizationPercent ?? null}
        detail={cluster?.diskUsedBytes !== null && cluster?.diskUsedBytes !== undefined
          && cluster.diskCapacityBytes !== null
          ? `${formatBinaryBytes(cluster.diskUsedBytes)} / ${formatBinaryBytes(cluster.diskCapacityBytes)}`
          : "Provider disk metric unavailable"}
      />
      {performance && !performance.complete ? (
        <p
          className="rounded-md border border-warning/30 bg-warning/5 px-2.5 py-2 text-caption text-warning"
          role="status"
        >
          <span className="font-semibold">{nodeCoverage(performance)}</span>
          {" · "}CPU and cache coverage is partial.
        </p>
      ) : null}
      <WindowStats
        label="CPU"
        stats={performance?.cpu ?? null}
        suffix="%"
      />
      <WindowStats
        label="WiredTiger cache"
        stats={performance?.cache ?? null}
        suffix="%"
      />
      <p className="text-caption text-text-dim">
        App database: {nullableBytes(provider.appData?.allocatedTotalBytes, false)} allocated
        {provider.cost.postedCycleUsd !== null
          ? ` · ${money(provider.cost.postedCycleUsd)} posted this cycle`
          : ""}
      </p>
    </ProviderCard>
  );
}

function RenderCard({
  provider,
}: {
  provider: AdminInfrastructureResp["providers"]["render"];
}) {
  const service = provider.service;
  return (
    <ProviderCard
      name="Render API"
      status={provider.status}
      stale={provider.stale}
      measuredAt={provider.measuredAt}
      primaryLabel="Planning baseline"
      primaryValue={moneyPerMonth(provider.cost?.monthlyPlanningUsd)}
      available={provider.available}
    >
      <MetricRow
        label="Service plan"
        value={service?.plan ? titleCase(service.plan) : "Unavailable"}
        detail={service
          ? `${formatCount(service.instanceCount)} ${service.instanceCount === 1 ? "instance" : "instances"}${service.autoscalingEnabled ? " · autoscaling on" : ""}`
          : "Render capacity monitoring unavailable"}
      />
      <WindowStats label="CPU" stats={provider.metrics?.cpu ?? null} suffix="%" />
      <WindowStats
        label="Memory"
        stats={provider.metrics?.memory ?? null}
        suffix="%"
      />
      <p className="text-caption text-text-dim">
        {service?.suspended
          ? "Service is suspended."
          : provider.metrics?.windowMinutes
            ? `${provider.metrics.windowMinutes}-minute utilization window`
            : "Utilization window unavailable"}
      </p>
    </ProviderCard>
  );
}

function ProviderCard({
  name,
  status,
  stale,
  measuredAt,
  primaryLabel,
  primaryValue,
  available,
  children,
}: {
  name: string;
  status: InfrastructureLevel;
  stale: boolean;
  measuredAt: string | null;
  primaryLabel: string;
  primaryValue: string;
  available: boolean;
  children: ReactNode;
}) {
  return (
    <Card padded={false} className="flex h-full flex-col">
      <Card.Header>
        <h3 className="font-semibold text-text">{name}</h3>
        <StatusPill status={status} stale={stale} compact />
      </Card.Header>
      <Card.Body className="flex flex-1 flex-col gap-3">
        <div>
          <div className="text-micro font-semibold uppercase tracking-wider text-text-dim">
            {primaryLabel}
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-text">
            {primaryValue}
          </div>
        </div>
        <div className="space-y-3 border-t border-border pt-3">{children}</div>
        <p className="mt-auto border-t border-border pt-3 text-caption text-text-dim">
          {!available
            ? "Live provider metrics unavailable"
            : `${stale ? "Last-good snapshot" : "Measured"} ${measuredAt ? timeSince(measuredAt) : "at an unknown time"}`}
        </p>
      </Card.Body>
    </Card>
  );
}

function MetricRow({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-caption text-text-dim">{label}</div>
        <div className="mt-0.5 text-caption text-text-muted">{detail}</div>
      </div>
      <div className="flex-none text-right text-body font-semibold tabular-nums text-text">
        {value}
      </div>
    </div>
  );
}

function UtilizationRow({
  label,
  value,
  detail,
}: {
  label: string;
  value: number | null;
  detail: string;
}) {
  const width = value === null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <span className="text-caption text-text-dim">{label}</span>
        <span className="text-body font-semibold tabular-nums text-text">
          {value === null ? "Unavailable" : `${value.toFixed(1)}%`}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-bg-elevated"
        role={value === null ? undefined : "progressbar"}
        aria-label={value === null ? undefined : `${label} utilization`}
        aria-valuemin={value === null ? undefined : 0}
        aria-valuemax={value === null ? undefined : 100}
        aria-valuenow={value === null ? undefined : value}
      >
        <div className="h-full rounded-full bg-accent" style={{ width: `${width}%` }} />
      </div>
      <p className="text-caption text-text-muted">{detail}</p>
    </div>
  );
}

function WindowStats({
  label,
  stats,
  suffix,
}: {
  label: string;
  stats: InfrastructurePercentStats | null;
  suffix: string;
}) {
  return (
    <MetricRow
      label={label}
      value={stats?.latestPercent === null || stats?.latestPercent === undefined
        ? "Unavailable"
        : `${stats.latestPercent.toFixed(1)}${suffix}`}
      detail={stats && (stats.averagePercent !== null || stats.peakPercent !== null)
        ? `${formatNullable(stats.averagePercent, suffix)} avg · ${formatNullable(stats.peakPercent, suffix)} peak`
        : "No recent samples"}
    />
  );
}

function StatusPill({
  status,
  stale = false,
  compact = false,
}: {
  status: InfrastructureLevel;
  stale?: boolean;
  compact?: boolean;
}) {
  const effective = stale && status === "healthy" ? "watch" : status;
  const label = stale ? "Stale" : statusLabel(status);
  const styles = {
    healthy: "border-success/40 bg-success/10 text-success",
    watch: "border-warning/40 bg-warning/10 text-warning",
    upgrade: "border-danger/40 bg-danger/10 text-danger",
  }[effective];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border font-semibold uppercase tracking-wider ${compact ? "px-2 py-0.5 text-micro" : "px-2.5 py-1 text-caption"} ${styles}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${statusDot(effective)}`} aria-hidden />
      {label}
    </span>
  );
}

function statusDot(status: InfrastructureLevel): string {
  if (status === "upgrade") return "bg-danger";
  if (status === "watch") return "bg-warning";
  return "bg-success";
}

function statusLabel(status: InfrastructureLevel): string {
  if (status === "upgrade") return "Upgrade";
  if (status === "watch") return "Watch";
  return "Healthy";
}

function providerLabel(value: InfrastructureAdvisory["provider"]): string {
  if (value === "cloudflare") return "Cloudflare";
  if (value === "mongo") return "MongoDB";
  return "Render";
}

function formatAdvisoryValue(metric: string, value: number): string {
  if (metric.endsWith("_percent")) return `${value.toFixed(1)}%`;
  if (metric === "credential_days_remaining") {
    return `${value} ${Math.abs(value) === 1 ? "day" : "days"}`;
  }
  return value.toLocaleString();
}

function nullableBytes(value: number | null | undefined, binary: boolean): string {
  if (value === null || value === undefined) return "Unavailable";
  return binary ? formatBinaryBytes(value) : formatBytes(value);
}

function money(value: number | null | undefined): string {
  return value === null || value === undefined ? "Unavailable" : formatUsd(value);
}

function moneyPerMonth(value: number | null | undefined): string {
  const formatted = money(value);
  return formatted === "Unavailable" ? formatted : `${formatted}/mo`;
}

function formatCount(value: number | null | undefined): string {
  return value === null || value === undefined
    ? "Unavailable"
    : value.toLocaleString();
}

function nodeCoverage(
  performance: NonNullable<
    NonNullable<AdminInfrastructureResp["providers"]["mongo"]["cluster"]>["performance"]
  >,
): string {
  if (
    performance.processCount === null
    || performance.expectedProcessCount === null
  ) {
    return "Partial node coverage";
  }
  return `${performance.processCount}/${performance.expectedProcessCount} nodes measured`;
}

function formatNullable(value: number | null, suffix: string): string {
  return value === null ? "—" : `${value.toFixed(1)}${suffix}`;
}

function formatShortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}
