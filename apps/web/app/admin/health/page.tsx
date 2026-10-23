"use client";

import { useEffect, useState } from "react";
import { AdminPageHeader as PageHeader } from "@/app/admin/components/AdminPageHeader";
import { Button } from "@/components/ui/Button";
import { RequestError } from "@/components/ui/RequestError";
import { useApi } from "@/lib/clientApi";
import { StatusTile, type Tone } from "../components/StatusTile";
import { formatDuration, timeSince } from "../components/format";
import { ForbiddenCard } from "../components/AdminFragments";
import { InfrastructureOverview } from "../components/InfrastructureOverview";
import { DatabaseBackupsCard } from "../components/DatabaseBackupsCard";
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
 *   - Whether browsers can back up original replays to R2 (the bucket's
 *     CORS rule, set up and verified by the API).
 *   - Atlas disk, pending-invoice costs, and diagnostic credential expiry.
 *   - Database backups: the newest Atlas Cloud Backup snapshot's age,
 *     schedule and retention, and the in-app snapshot counts.
 *
 * Operational health refreshes every 30 s. The page checks provider status
 * every five minutes; server-side snapshot caches prevent control-plane API
 * polling on every browser refresh.
 */
export default function AdminHealthPage() {
  const health = useApi<HealthResp>("/v1/admin/health", { refreshInterval: 30_000 });
  const infrastructure = useApi<AdminInfrastructureResp>("/v1/admin/infrastructure", { refreshInterval: 5 * 60_000 });
  const [lastSuccess, setLastSuccess] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (health.data && !health.error) setLastSuccess(Date.now());
  }, [health.data, health.error]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);
  const data = health.data;
  if (health.error?.status === 403 || infrastructure.error?.status === 403) return <ForbiddenCard />;
  return (
    <div className="space-y-6">
      <PageHeader anchor="infrastructure" eyebrow="Admin" title="Infrastructure" description="Provider costs, capacity, backups and operational health."
        actions={<Button variant="secondary" loading={health.isValidating || infrastructure.isValidating}
          onClick={() => { void Promise.allSettled([health.mutate(), infrastructure.mutate()]); }}>Refresh now</Button>} />
      <p className="text-caption text-text-dim">{lastSuccess === null ? "Operational checks have not completed yet." : "Operational checks updated " + Math.max(0, Math.floor((now - lastSuccess) / 1000)) + "s ago"}</p>
      {!infrastructure.data && data ? <CredentialExpiryWarning credential={data.mongo.atlas.credential} /> : null}
      <InfrastructureOverview data={infrastructure.data ?? null} error={infrastructure.error ?? null}
        isLoading={infrastructure.isLoading} onRetry={() => infrastructure.mutate()} />
      <DatabaseBackupsCard />
      <section aria-labelledby="operational-health-heading" className="space-y-3">
        <h2 id="operational-health-heading" className="text-h3 font-semibold text-text">Operational health</h2>
        {health.error ? <RequestError title="API health check failed" error={health.error} onRetry={() => health.mutate()} />
          : !data ? <div role="status" className="grid gap-3 md:grid-cols-3"><span className="sr-only">Loading operational health…</span>{[0, 1, 2].map((i) => <div key={i} className="h-32 animate-pulse rounded-xl bg-bg-elevated" />)}</div>
            : <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <StatusTile label="MongoDB" tone={data.mongo.ok ? "ok" : "error"} primary={data.mongo.ok ? String(data.mongo.latencyMs ?? "?") + " ms" : "down"} secondary={data.mongo.error || "ping responded ok"} />
              <StatusTile label="Original replay store" tone={data.runtime.replayFilesStore === "r2" ? "ok" : "error"} primary={backendLabel(data.runtime.replayFilesStore)} secondary={data.runtime.replayFilesStore === "r2" ? "Original replay uploads and signed downloads enabled" : "Original replay files are not being archived"} />
              <BrowserBackupTile runtime={data.runtime} />
              <StatusTile label="Game-details store" tone="ok" primary={backendLabel(data.runtime.gameDetailsStore)} secondary={data.runtime.gameDetailsStore === "r2" ? "Cloudflare R2 / S3-compatible" : "MongoDB game_details collection"} />
              <StatusTile label="Uptime" tone="ok" primary={formatDuration(data.uptime.uptimeSeconds)} secondary={"since " + new Date(data.uptime.startedAt).toLocaleString()} />
            </div>}
      </section>
      {data ? <p className="text-caption text-text-dim">Runtime · Node {data.runtime.nodeVersion}</p> : null}
    </div>
  );
}

/** `runtime.replayFilesBrowserUpload.status` from GET /v1/admin/health. */
type BrowserUploadState =
  | "ready"
  | "missing_cors"
  | "no_permission"
  | "error"
  | "disabled"
  | "unknown"
  | "checking";

interface BrowserUploadStatus {
  status: BrowserUploadState;
  checkedAt: string | null;
  detail: string | null;
}

const BROWSER_UPLOAD_STATES: ReadonlyArray<BrowserUploadState> = [
  "ready",
  "missing_cors",
  "no_permission",
  "error",
  "disabled",
  "unknown",
  "checking",
];

const SETUP_DOC_HINT =
  'see docs/instant-analysis.md, "Browser replay backup"';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBrowserUploadState(value: unknown): value is BrowserUploadState {
  return BROWSER_UPLOAD_STATES.some((state) => state === value);
}

/**
 * Narrow `runtime.replayFilesBrowserUpload`; null when an older API does
 * not report it (the tile then hides instead of guessing).
 */
function readBrowserUpload(runtime: unknown): BrowserUploadStatus | null {
  if (!isRecord(runtime)) return null;
  const raw = runtime.replayFilesBrowserUpload;
  if (!isRecord(raw) || !isBrowserUploadState(raw.status)) return null;
  return {
    status: raw.status,
    checkedAt: typeof raw.checkedAt === "string" ? raw.checkedAt : null,
    detail: typeof raw.detail === "string" && raw.detail ? raw.detail : null,
  };
}

/** Tone + plain-words copy for each browser-backup state. */
function browserUploadCopy(value: BrowserUploadStatus): {
  tone: Tone;
  primary: string;
  secondary: string;
  detail: string | null;
} {
  switch (value.status) {
    case "ready":
      return { tone: "ok", primary: "Ready", secondary: "Browsers can back up original replays to R2", detail: null };
    case "no_permission":
      return {
        tone: "warning",
        primary: "Needs setup",
        secondary: `The R2 key can't change bucket settings. Add the upload rule in Cloudflare — ${SETUP_DOC_HINT}`,
        detail: null,
      };
    case "missing_cors":
      return {
        tone: "warning",
        primary: "Needs setup",
        secondary:
          "Browsers can't upload replay files to R2 yet: R2 refused the browser check from this site. " +
          `Check the bucket's CORS policy in Cloudflare — ${SETUP_DOC_HINT}`,
        detail: value.detail,
      };
    case "error":
      return {
        tone: "warning",
        primary: "Check failed",
        secondary: value.detail ?? "The last check did not finish",
        detail: null,
      };
    case "disabled":
      return { tone: "neutral", primary: "Off", secondary: "Original replay storage is off", detail: null };
    default:
      return { tone: "neutral", primary: "Checking…", secondary: "The API is checking the R2 upload rule", detail: null };
  }
}

/** Can browsers PUT original replays to the private R2 bucket (its CORS rule)? */
function BrowserBackupTile({ runtime }: { runtime: unknown }) {
  const value = readBrowserUpload(runtime);
  if (!value) return null;
  const copy = browserUploadCopy(value);
  const notes = [copy.detail, value.checkedAt ? `checked ${timeSince(value.checkedAt)}` : null].filter(
    (note): note is string => note !== null,
  );
  return (
    <StatusTile
      label="Browser replay backup"
      tone={copy.tone}
      primary={copy.primary}
      secondary={copy.secondary}
      notes={notes}
    />
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
