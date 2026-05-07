"use client";

import { useApi } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { formatDuration } from "../components/format";
import { ForbiddenCard } from "../components/AdminFragments";
import type { HealthResp } from "../components/adminTypes";

/**
 * /admin/health — runtime + dependency health.
 *
 * Surfaces the data an admin needs to answer "is everything talking
 * to everything?":
 *
 *   - Mongo ping latency (and which database / cluster).
 *   - Process uptime + Node version.
 *   - The configured ``GAME_DETAILS_STORE`` backend (mongo or r2),
 *     so it's possible to verify a deploy is using R2 without
 *     grepping env vars.
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

      <div className="grid gap-3 md:grid-cols-3">
        <StatusTile
          label="MongoDB"
          ok={data.mongo.ok}
          primary={
            data.mongo.ok
              ? `${data.mongo.latencyMs ?? "?"} ms`
              : "down"
          }
          secondary={data.mongo.error || "ping responded ok"}
        />
        <StatusTile
          label="Game-details store"
          ok
          primary={data.runtime.gameDetailsStore}
          secondary={
            data.runtime.gameDetailsStore === "r2"
              ? "Cloudflare R2 / S3-compatible"
              : "MongoDB game_details collection"
          }
        />
        <StatusTile
          label="Uptime"
          ok
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
  ok,
  primary,
  secondary,
}: {
  label: string;
  ok: boolean;
  primary: string;
  secondary?: string;
}) {
  const dot = ok
    ? "bg-success shadow-[0_0_0_4px_rgba(34,197,94,0.15)]"
    : "bg-danger shadow-[0_0_0_4px_rgba(239,68,68,0.15)]";
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
