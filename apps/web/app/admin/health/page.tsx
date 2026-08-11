"use client";

import { useApi } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import {
  formatBinaryBytes,
  formatBytes,
  formatDuration,
  formatUsd,
  formatUsdCents,
} from "../components/format";
import { ForbiddenCard } from "../components/AdminFragments";
import type { HealthResp } from "../components/adminTypes";

/**
 * /admin/health — runtime + dependency health.
 *
 * Surfaces the data an admin needs to answer "is everything talking
 * to everything?":
 *
 *   - Mongo ping latency and application-database allocation.
 *   - Process uptime + Node version.
 *   - Both object-store backends and Cloudflare analytics readiness.
 *   - Atlas disk, pending-invoice costs, and diagnostic credential expiry.
 *
 * Auto-refreshes every 30 s — short enough for an admin to watch a
 * deploy come up, long enough to not pound Mongo with health pings.
 */
export default function AdminHealthPage() {
  const { data, error, isLoading } = useApi<HealthResp>(
    "/v1/admin/health",
    { refreshInterval: 30_000 },
  );

  if (isLoading) {
    return (
      <div className="space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Health</h1>
        </header>
        <div className="grid gap-3 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-32 animate-pulse rounded-xl bg-bg-elevated" />
          ))}
        </div>
      </div>
    );
  }
  if (error) {
    if (error.status === 403) return <ForbiddenCard />;
    return (
      <Card padded>
        <p className="text-danger">Health probe failed: {error.message}</p>
      </Card>
    );
  }
  if (!data) return null;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold">Health</h1>
        <p className="text-text-muted">
          Refreshes every 30 s. Use this page to verify a fresh
          deploy reached its dependencies before opening the app to
          users.
        </p>
      </header>

      <CredentialExpiryWarning credential={data.mongo.atlas.credential} />

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <StatusTile
          label="MongoDB"
          tone={data.mongo.ok ? "ok" : "error"}
          primary={
            data.mongo.ok
              ? `${data.mongo.latencyMs ?? "?"} ms`
              : "down"
          }
          secondary={data.mongo.error || "ping responded ok"}
        />
        <StatusTile
          label="Cloudflare analytics"
          tone={cloudflareTone(data.cloudflareAnalytics)}
          primary={cloudflarePrimary(data.cloudflareAnalytics)}
          secondary={cloudflareDetail(data.cloudflareAnalytics)}
        />
        <StatusTile
          label="Original replay store"
          tone={data.runtime.replayFilesStore === "r2" ? "ok" : "error"}
          primary={backendLabel(data.runtime.replayFilesStore)}
          secondary={
            data.runtime.replayFilesStore === "r2"
              ? "Original replay uploads and signed downloads enabled"
              : "Original replay files are not being archived"
          }
        />
        <StatusTile
          label="Game-details store"
          tone="ok"
          primary={backendLabel(data.runtime.gameDetailsStore)}
          secondary={
            data.runtime.gameDetailsStore === "r2"
              ? "Cloudflare R2 / S3-compatible"
              : "MongoDB game_details collection"
          }
        />
        <StatusTile
          label="Atlas diagnostics"
          tone={atlasTone(data)}
          primary={atlasPrimary(data)}
          secondary={atlasDetail(data)}
        />
        <StatusTile
          label="Uptime"
          tone="ok"
          primary={formatDuration(data.uptime.uptimeSeconds)}
          secondary={`since ${new Date(data.uptime.startedAt).toLocaleString()}`}
        />
      </div>

      <InfrastructureStorageCard data={data} />

      <Card padded>
        <h3 className="text-caption font-semibold uppercase tracking-wider text-text">
          Runtime
        </h3>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-caption text-text-dim">Node version</dt>
            <dd className="mt-1 font-mono text-body text-text">
              {data.runtime.nodeVersion}
            </dd>
          </div>
          <div>
            <dt className="text-caption text-text-dim">
              Original replay backend
            </dt>
            <dd className="mt-1 font-mono text-body text-text">
              {backendLabel(data.runtime.replayFilesStore)}
            </dd>
          </div>
          <div>
            <dt className="text-caption text-text-dim">
              Cost analytics
            </dt>
            <dd className="mt-1 text-body text-text">
              {data.runtime.infrastructureCostsConfigured
                ? "configured"
                : "not configured"}
            </dd>
          </div>
          <div>
            <dt className="text-caption text-text-dim">
              Game-details backend
            </dt>
            <dd className="mt-1 font-mono text-body text-text">
              {data.runtime.gameDetailsStore}
            </dd>
          </div>
          <div>
            <dt className="text-caption text-text-dim">Server started</dt>
            <dd className="mt-1 text-body text-text">
              {new Date(data.uptime.startedAt).toLocaleString()}
            </dd>
          </div>
          <div>
            <dt className="text-caption text-text-dim">Mongo round-trip</dt>
            <dd className="mt-1 text-body text-text">
              {data.mongo.ok ? `${data.mongo.latencyMs ?? "?"} ms` : "—"}
            </dd>
          </div>
        </dl>
      </Card>
    </div>
  );
}

function StatusTile({
  label,
  tone,
  primary,
  secondary,
}: {
  label: string;
  tone: "ok" | "warning" | "error" | "neutral";
  primary: string;
  secondary?: string;
}) {
  const dot = {
    ok: "bg-success shadow-[0_0_0_4px_rgba(34,197,94,0.15)]",
    warning: "bg-warning shadow-[0_0_0_4px_rgba(234,179,8,0.15)]",
    error: "bg-danger shadow-[0_0_0_4px_rgba(239,68,68,0.15)]",
    neutral: "bg-text-dim shadow-[0_0_0_4px_rgba(148,163,184,0.12)]",
  }[tone];
  return (
    <Card padded>
      <div className="flex items-center justify-between">
        <span className="text-caption font-semibold uppercase tracking-wider text-text-dim">
          {label}
        </span>
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${dot}`}
          aria-hidden
        />
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums text-text">
        {primary}
      </div>
      {secondary ? (
        <p className="mt-1 text-caption text-text-dim">{secondary}</p>
      ) : null}
    </Card>
  );
}

function InfrastructureStorageCard({ data }: { data: HealthResp }) {
  const app = data.mongo.storage;
  const atlas = data.mongo.atlas;
  const cluster = atlas.available ? atlas.cluster : null;
  const billing = atlas.available ? atlas.billing : null;
  const diskReady =
    cluster?.diskUsedBytes != null && cluster.diskCapacityBytes != null;
  const projected = billing?.projectedMonthlyRunRateUsd
    ?? (billing?.projectedMonthlyRunRateCents != null
      ? billing.projectedMonthlyRunRateCents / 100
      : null);

  return (
    <Card padded={false}>
      <Card.Header>
        <h2 className="text-caption font-semibold uppercase tracking-wider text-text">
          Storage &amp; Atlas billing
        </h2>
        <span className="text-caption text-text-dim">
          provider snapshots can lag
        </span>
      </Card.Header>
      <Card.Body className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <HealthMetric
            label="Mongo app database"
            value={app ? formatBytes(app.allocatedTotalBytes) : "Unavailable"}
            caption={
              app
                ? `${formatBytes(app.logicalDataBytes)} logical data · database only · ${formatWhen(app.measuredAt)}`
                : "Whole-database dbStats probe unavailable"
            }
          />
          <HealthMetric
            label="Atlas disk used / capacity"
            value={
              diskReady
                ? `${formatBinaryBytes(cluster.diskUsedBytes!)} / ${formatBinaryBytes(cluster.diskCapacityBytes!)}`
                : "Unavailable"
            }
            caption={
              diskReady
                ? `${diskPercent(cluster.diskUsedBytes!, cluster.diskCapacityBytes!)} used · Atlas binary disk metric ${formatWhen(cluster.diskMeasuredAt)}`
                : "Provider disk metric unavailable; no value inferred"
            }
          />
          <HealthMetric
            label="Posted this Atlas cycle"
            value={
              billing?.available
                ? formatUsdCents(billing.postedCycleCents)
                : "Unavailable"
            }
            caption={
              billing?.available
                ? `Pending invoice through ${formatWhen(billing.postedThrough)} · about ${billing.lagDaysApprox}d lag`
                : "Pending-invoice charges unavailable"
            }
          />
          <HealthMetric
            label="Projected Atlas month"
            value={projected == null ? "Unavailable" : `${formatUsd(projected)}/mo`}
            caption="Linear estimate from posted charges, not a final invoice"
          />
        </div>

        {billing?.available && billing.categoryCents ? (
          <dl className="grid gap-2 rounded-lg border border-border bg-bg-elevated/50 p-3 text-caption sm:grid-cols-4">
            <ChargeItem label="Compute posted" cents={billing.categoryCents.compute} />
            <ChargeItem label="Storage posted" cents={billing.categoryCents.storage} />
            <ChargeItem label="Transfer posted" cents={billing.categoryCents.transfer} />
            <ChargeItem label="Other posted" cents={billing.categoryCents.other} />
          </dl>
        ) : null}

        <p className="text-caption text-text-dim">
          Mongo app bytes come from database-only dbStats and are not Atlas
          disk consumption or a bill. Atlas disk metrics and pending-invoice
          line items can arrive late; the Atlas dashboard and final invoice
          remain authoritative.
        </p>
      </Card.Body>
    </Card>
  );
}

function HealthMetric({
  label,
  value,
  caption,
}: {
  label: string;
  value: string;
  caption: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-bg-elevated/50 p-3">
      <div className="text-micro font-semibold uppercase tracking-wider text-text-dim">
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-text">
        {value}
      </div>
      <p className="mt-1 text-caption text-text-dim">{caption}</p>
    </div>
  );
}

function ChargeItem({ label, cents }: { label: string; cents: number }) {
  return (
    <div>
      <dt className="text-text-dim">{label}</dt>
      <dd className="mt-0.5 font-semibold tabular-nums text-text">
        {formatUsdCents(cents)}
      </dd>
    </div>
  );
}

function CredentialExpiryWarning({
  credential,
}: {
  credential: HealthResp["mongo"]["atlas"]["credential"];
}) {
  if (!credential.expiringSoon || credential.daysRemaining === null) return null;
  const expired = credential.daysRemaining <= 0;
  const amount = Math.abs(credential.daysRemaining);
  return (
    <div
      role="alert"
      className={[
        "rounded-lg border px-4 py-3 text-body",
        expired
          ? "border-danger/40 bg-danger/10 text-danger"
          : "border-warning/40 bg-warning/10 text-warning",
      ].join(" ")}
    >
      <strong>Atlas diagnostic credential {expired ? "expired" : "expires soon"}.</strong>{" "}
      {expired
        ? `Expiry passed ${amount} ${amount === 1 ? "day" : "days"} ago.`
        : `${credential.daysRemaining} ${credential.daysRemaining === 1 ? "day" : "days"} remaining.`}{" "}
      Rotate the read-only service credential before diagnostics stop.
      {credential.expiresAt ? ` Expiry date: ${formatWhen(credential.expiresAt)}.` : ""}
    </div>
  );
}

function cloudflareTone(
  value: HealthResp["cloudflareAnalytics"],
): "ok" | "warning" | "error" | "neutral" {
  if (!value.configured) return "neutral";
  if (!value.available) return "error";
  return value.stale ? "warning" : "ok";
}

function cloudflarePrimary(value: HealthResp["cloudflareAnalytics"]): string {
  if (!value.configured) return "not configured";
  if (!value.available) return "unavailable";
  return value.stale ? "stale snapshot" : "ready";
}

function cloudflareDetail(value: HealthResp["cloudflareAnalytics"]): string {
  if (!value.configured) return "Aggregate R2 usage analytics are disabled";
  if (!value.available) return "Configured, but the provider probe failed";
  return `${value.stale ? "Last-good" : "Latest"} aggregate snapshot ${formatWhen(value.asOf)}`;
}

function atlasTone(data: HealthResp): "ok" | "warning" | "error" | "neutral" {
  const atlas = data.mongo.atlas;
  if (!atlas.configured) return "neutral";
  if (!atlas.available) return "error";
  return atlas.cluster && atlas.billing?.available ? "ok" : "warning";
}

function atlasPrimary(data: HealthResp): string {
  const atlas = data.mongo.atlas;
  if (!atlas.configured) return "not configured";
  if (!atlas.available) return "unavailable";
  return atlas.cluster && atlas.billing?.available ? "ready" : "partial";
}

function atlasDetail(data: HealthResp): string {
  const atlas = data.mongo.atlas;
  if (!atlas.configured) return "Read-only Atlas diagnostics are disabled";
  if (!atlas.available) return "Configured, but the Atlas probe failed";
  if (!atlas.cluster) return "Billing available; cluster metrics unavailable";
  if (!atlas.billing?.available) return "Disk metrics available; billing unavailable";
  return `Disk and pending-invoice data measured ${formatWhen(atlas.measuredAt)}`;
}

function backendLabel(value: string): string {
  if (value === "r2") return "Cloudflare R2";
  if (value === "mongo") return "MongoDB";
  if (value === "disabled") return "disabled";
  return "unknown";
}

function formatWhen(value: string | null): string {
  if (!value) return "at an unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "at an unknown time";
  return date.toLocaleString();
}

function diskPercent(used: number, capacity: number): string {
  if (!Number.isFinite(used) || !Number.isFinite(capacity) || capacity <= 0) {
    return "unknown share";
  }
  return `${Math.min(100, Math.max(0, (used / capacity) * 100)).toFixed(1)}%`;
}
