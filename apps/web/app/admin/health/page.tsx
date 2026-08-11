"use client";

import { useApi } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { formatDuration } from "../components/format";
import { ForbiddenCard } from "../components/AdminFragments";
import { InfrastructureOverview } from "../components/InfrastructureOverview";
import type {
  AdminInfrastructureResp,
  HealthResp,
} from "../components/adminTypes";

/**
 * /admin/health — provider costs, capacity, and dependency health.
 *
 * Surfaces the data an admin needs to answer "is everything talking
 * to everything?":
 *
 *   - Cloudflare R2, MongoDB Atlas, and Render costs and utilization.
 *   - Tier-purchase advisories from explicit planning thresholds.
 *   - Mongo ping latency and application-database allocation.
 *   - Process uptime + Node version.
 *   - Both object-store backends and Cloudflare analytics readiness.
 *   - Atlas disk, pending-invoice costs, and diagnostic credential expiry.
 *
 * Operational health refreshes every 30 s. The page checks provider status
 * every five minutes; server-side snapshot caches prevent control-plane API
 * polling on every browser refresh.
 */
export default function AdminHealthPage() {
  const health = useApi<HealthResp>(
    "/v1/admin/health",
    { refreshInterval: 30_000 },
  );
  const infrastructure = useApi<AdminInfrastructureResp>(
    "/v1/admin/infrastructure",
    { refreshInterval: 5 * 60_000 },
  );
  const { data, error, isLoading } = health;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Infrastructure</h1>
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
  if (infrastructure.error?.status === 403) return <ForbiddenCard />;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold">Infrastructure</h1>
        <p className="text-text-muted">
          Costs, capacity, and dependency health. Provider status is checked
          every five minutes and may reflect cached upstream data; operational
          checks refresh every 30 seconds.
        </p>
      </header>

      {!infrastructure.data ? (
        <CredentialExpiryWarning credential={data.mongo.atlas.credential} />
      ) : null}

      <InfrastructureOverview
        data={infrastructure.data ?? null}
        error={infrastructure.error?.message ?? null}
        isLoading={infrastructure.isLoading}
      />

      <div className="space-y-1">
        <h2 className="text-h3 font-semibold text-text">Operational health</h2>
        <p className="text-body text-text-muted">
          Live application dependencies and the current API process.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
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
          label="Uptime"
          tone="ok"
          primary={formatDuration(data.uptime.uptimeSeconds)}
          secondary={`since ${new Date(data.uptime.startedAt).toLocaleString()}`}
        />
      </div>

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
