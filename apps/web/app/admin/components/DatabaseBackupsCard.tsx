"use client";

import type { ReactNode } from "react";

import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { Card } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/QueryState";
import { useApi } from "@/lib/clientApi";
import { formatBytes, timeSince } from "./format";
import type {
  AdminBackupsResp,
  AtlasBackupStatus,
  AtlasSnapshotStatus,
  BackupFreshness,
  BackupRetentionItem,
  InAppSnapshotCounts,
} from "./adminTypes";

/** Where the restore steps live (repo doc; admins read it on GitHub). */
const RUNBOOK_PATH = "docs/runbooks/restore-database.md";
const DEFAULT_THRESHOLDS = { freshMaxHours: 26, agingMaxHours: 50 } as const;
/** Shown, with Retry, when the API answered with something else. */
const UNEXPECTED_ANSWER = {
  status: -1,
  message: "The backup status answer wasn't in the expected format.",
} as const;

export type BackupTone = "ok" | "warning" | "error" | "neutral";

/**
 * Admin Health "Database backups" card: how old the newest Atlas Cloud
 * Backup snapshot is (green under 26 h, amber under 50 h, red after that
 * or when there is none), the schedule and retention, point-in-time
 * restore, and the snapshots users take in Settings → Backups.
 *
 * Reads GET /v1/admin/backups every five minutes; the API caches Atlas for
 * ten, so this never polls Atlas directly.
 */
export function DatabaseBackupsCard() {
  const request = useApi<unknown>("/v1/admin/backups", {
    refreshInterval: 5 * 60_000,
  });
  const data = normalizeAdminBackups(request.data);

  return (
    <section aria-labelledby="database-backups-heading" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="space-y-1">
          <h2 id="database-backups-heading" className="text-h3 font-semibold text-text">
            Database backups
          </h2>
          <p className="text-body text-text-muted">
            Atlas snapshots of the whole database, plus the snapshots users
            take in Settings.
          </p>
        </div>
        {data ? <FreshnessBadge atlas={data.atlas} /> : null}
      </div>

      <QueryState
        q={{
          data: data ?? undefined,
          // An answer that isn't the backups contract (an older API, a
          // proxy error page) is a failure too, never an empty card.
          error: request.error ?? (request.data !== undefined && !data ? UNEXPECTED_ANSWER : undefined),
          mutate: () => request.mutate(),
        }}
        skeleton={
          <div
            className="h-56 rounded-xl bg-bg-elevated motion-safe:animate-pulse"
            role="status"
            aria-busy="true"
          >
            <span className="sr-only">Loading backup status…</span>
          </div>
        }
        errorTitle="Backup status couldn't load"
      >
        {(backups) => <BackupsBody data={backups} />}
      </QueryState>
    </section>
  );
}

function BackupsBody({ data }: { data: AdminBackupsResp }) {
  return (
    <Card padded={false}>
      <div className="grid md:grid-cols-2">
        <AtlasPanel atlas={data.atlas} thresholds={data.thresholds} />
        <InAppPanel inApp={data.inApp} />
      </div>
      <div className="flex flex-col gap-1 border-t border-border px-4 py-3 text-caption text-text-muted sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4">
        <span>
          Restore steps: <code className="break-all font-mono">{RUNBOOK_PATH}</code>
        </span>
        <LazyHelpLink slug="backups-and-export">What users are told about backups</LazyHelpLink>
      </div>
    </Card>
  );
}

function AtlasPanel({
  atlas,
  thresholds,
}: {
  atlas: AtlasBackupStatus;
  thresholds: AdminBackupsResp["thresholds"];
}) {
  const tone = backupTone(atlas.freshness);
  return (
    <div className="space-y-3 p-4">
      <div>
        <div className="text-micro font-semibold uppercase tracking-wider text-text-dim">
          Newest Atlas snapshot
        </div>
        <div className="mt-1 flex items-center gap-2">
          <span
            data-testid="backup-age-dot"
            className={`h-2.5 w-2.5 flex-none rounded-full ${TONE_DOT[tone]}`}
            aria-hidden
          />
          <span className="text-2xl font-semibold tabular-nums text-text">
            {snapshotAgeLabel(atlas)}
          </span>
        </div>
        {atlas.lastSnapshotAt ? (
          <p className="mt-0.5 text-caption text-text-muted">
            Taken {formatWhen(atlas.lastSnapshotAt)}
          </p>
        ) : null}
      </div>
      <AtlasNotice atlas={atlas} />
      {atlas.available ? <AtlasDetails atlas={atlas} /> : null}
      {atlas.configured ? (
        <p className="text-caption text-text-muted">
          On time means a snapshot in the last {thresholds.freshMaxHours} hours.
          Admins get one notification a day once the newest snapshot is{" "}
          {thresholds.agingMaxHours} hours old or there is none.
        </p>
      ) : null}
    </div>
  );
}

function AtlasDetails({ atlas }: { atlas: AtlasBackupStatus }) {
  return (
    <dl className="space-y-2.5 border-t border-border pt-3">
      <DetailRow
        label="Newest run"
        value={snapshotStatusLabel(atlas.latestStatus)}
        tone={atlas.latestStatus === "failed" ? "error" : undefined}
      />
      <DetailRow
        label="Next snapshot"
        value={atlas.nextSnapshotAt
          ? `${timeUntil(atlas.nextSnapshotAt)} · ${formatWhen(atlas.nextSnapshotAt)}`
          : "Not reported"}
      />
      <DetailRow label="Schedule and retention" value={<RetentionList items={atlas.retention} />} />
      <DetailRow label="Point-in-time restore" value={pointInTimeLabel(atlas.pointInTime)} />
      <DetailRow
        label="Snapshots on hand"
        value={atlas.completedSnapshotCount.toLocaleString()}
      />
    </dl>
  );
}

function InAppPanel({ inApp }: { inApp: InAppSnapshotCounts | null }) {
  return (
    <div className="space-y-3 border-t border-border p-4 md:border-l md:border-t-0">
      <div>
        <div className="text-micro font-semibold uppercase tracking-wider text-text-dim">
          Snapshots users take in Settings
        </div>
        <div className="mt-1 text-2xl font-semibold tabular-nums text-text">
          {inApp ? inApp.snapshotCount.toLocaleString() : "Unavailable"}
        </div>
        <p className="mt-0.5 text-caption text-text-muted">
          {inApp
            ? `from ${plural(inApp.userCount, "user")}`
            : "The counts couldn't be read this time."}
        </p>
      </div>
      {inApp ? (
        <dl className="space-y-2.5 border-t border-border pt-3">
          <DetailRow
            label="Newest"
            value={inApp.newestAt ? timeSince(inApp.newestAt) : "None yet"}
          />
          <DetailRow
            label="Space used"
            value={inApp.storageBytes === null ? "Unavailable" : formatBytes(inApp.storageBytes)}
          />
        </dl>
      ) : null}
      <p className="text-caption text-text-muted">
        These live in the same database, so Atlas snapshots include them.
        Each one restores a single account.
      </p>
    </div>
  );
}

function AtlasNotice({ atlas }: { atlas: AtlasBackupStatus }) {
  const notice = atlasNotice(atlas);
  if (!notice) return null;
  const styles = notice.tone === "error"
    ? "border-danger/40 bg-danger/10"
    : notice.tone === "warning"
      ? "border-warning/40 bg-warning/10"
      : "border-border bg-bg-elevated";
  return (
    <p className={`rounded-lg border px-3 py-2 text-caption text-text ${styles}`}>
      {notice.text}
    </p>
  );
}

function DetailRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: BackupTone;
}) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
      <dt className="text-caption text-text-dim">{label}</dt>
      <dd
        className={`text-caption font-semibold sm:text-right ${tone === "error" ? "text-danger" : "text-text"}`}
      >
        {value}
      </dd>
    </div>
  );
}

function RetentionList({ items }: { items: BackupRetentionItem[] }) {
  if (items.length === 0) return <>Not reported</>;
  return (
    <ul className="space-y-0.5">
      {items.map((item) => (
        <li key={`${item.frequency}-${item.everyHours ?? 0}-${item.keep}-${item.unit}`}>
          {retentionLabel(item)}
        </li>
      ))}
    </ul>
  );
}

function FreshnessBadge({ atlas }: { atlas: AtlasBackupStatus }) {
  const tone = backupTone(atlas.freshness);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-caption font-semibold uppercase tracking-wider ${TONE_PILL[tone]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[tone]}`} aria-hidden />
      {freshnessLabel(atlas)}
    </span>
  );
}

const TONE_DOT: Record<BackupTone, string> = {
  ok: "bg-success",
  warning: "bg-warning",
  error: "bg-danger",
  neutral: "bg-text-dim",
};

const TONE_PILL: Record<BackupTone, string> = {
  ok: "border-success/40 bg-success/10 text-success",
  warning: "border-warning/40 bg-warning/10 text-warning",
  error: "border-danger/40 bg-danger/10 text-danger",
  neutral: "border-border bg-bg-elevated text-text-muted",
};

/** Card colour for a snapshot-age band (see BackupFreshness). */
export function backupTone(freshness: BackupFreshness): BackupTone {
  if (freshness === "fresh") return "ok";
  if (freshness === "aging") return "warning";
  if (freshness === "stale" || freshness === "missing") return "error";
  return "neutral";
}

function freshnessLabel(atlas: AtlasBackupStatus): string {
  switch (atlas.freshness) {
    case "fresh":
      return "On time";
    case "aging":
      return "Late";
    case "stale":
      return "Overdue";
    case "missing":
      return "No snapshot";
    default:
      return atlas.errorCode === "not_configured" ? "Not connected" : "Unknown";
  }
}

function snapshotAgeLabel(atlas: AtlasBackupStatus): string {
  if (!atlas.available) return "Unknown";
  if (!atlas.lastSnapshotAt) return "None yet";
  return snapshotAge(atlas.lastSnapshotAt);
}

/**
 * Snapshot age in whole hours up to three days, so the 26 h and 50 h
 * lines are readable ("25 h ago", not "1d ago"); days after that.
 */
export function snapshotAge(iso: string, nowMs = Date.now()): string {
  const ms = nowMs - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "Unknown";
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 72) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/** Plain-words explanation for setup problems, outages and odd states. */
export function atlasNotice(
  atlas: AtlasBackupStatus,
): { tone: BackupTone; text: string } | null {
  if (atlas.errorCode === "not_configured") {
    return {
      tone: "neutral",
      text:
        "Atlas backup status isn't connected. Add the ATLAS_* service-account settings in Render; the account only needs the Project Read Only role.",
    };
  }
  if (atlas.errorCode === "atlas_backup_forbidden" && !atlas.available) {
    return {
      tone: "warning",
      text:
        "Atlas refused the backup check. Give the service account the Project Read Only role on this project, then reload this page.",
    };
  }
  if (!atlas.available) {
    return {
      tone: "warning",
      text: "Atlas didn't answer the backup check. It tries again within a minute.",
    };
  }
  if (atlas.stale) {
    return {
      tone: "warning",
      text: `Atlas didn't answer the latest check. This is the last good result, from ${
        atlas.checkedAt ? timeSince(atlas.checkedAt) : "earlier"
      }.`,
    };
  }
  if (atlas.cloudBackupEnabled === false) {
    return {
      tone: "error",
      text: "Cloud Backup is off for this cluster. Turn it on in Atlas under Backup.",
    };
  }
  if (atlas.freshness === "missing") {
    return {
      tone: "error",
      text: "Atlas has no completed snapshot of this cluster. Check Backup in Atlas.",
    };
  }
  if (atlas.freshness === "stale") {
    return {
      tone: "error",
      text: "The newest snapshot is overdue. Check the cluster's Backup page in Atlas for a failed or paused schedule.",
    };
  }
  if (atlas.freshness === "aging") {
    return {
      tone: "warning",
      text: "The newest snapshot is late. Atlas usually takes one a day; if the next one doesn't land, check Backup in Atlas.",
    };
  }
  return null;
}

/** "Every 6 hours, kept 2 days" / "Monthly, kept 12 months". */
export function retentionLabel(item: BackupRetentionItem): string {
  const keep = plural(item.keep, item.unit.replace(/s$/, ""));
  return `${frequencyLabel(item)}, kept ${keep}`;
}

function frequencyLabel(item: BackupRetentionItem): string {
  if (item.frequency === "hourly") {
    if (!item.everyHours || item.everyHours === 1) return "Every hour";
    return `Every ${item.everyHours} hours`;
  }
  return item.frequency[0].toUpperCase() + item.frequency.slice(1);
}

function snapshotStatusLabel(status: AtlasSnapshotStatus | null): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "inProgress":
      return "In progress";
    case "queued":
      return "Queued";
    case "failed":
      return "Failed";
    default:
      return "Not reported";
  }
}

function pointInTimeLabel(value: AtlasBackupStatus["pointInTime"]): string {
  if (value.enabled === null) return "Not reported";
  if (!value.enabled) return "Off";
  return value.windowDays
    ? `On, any moment in the last ${plural(value.windowDays, "day")}`
    : "On";
}

/** "in 45m", "in 3h", "in 2d"; "due now" once the time has passed. */
export function timeUntil(iso: string, nowMs = Date.now()): string {
  const ms = new Date(iso).getTime() - nowMs;
  if (!Number.isFinite(ms)) return "unknown";
  if (ms <= 60_000) return "due now";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `in ${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `in ${hr}h`;
  return `in ${Math.round(hr / 24)}d`;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "at an unknown time" : date.toLocaleString();
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

const FRESHNESS: ReadonlyArray<BackupFreshness> = ["fresh", "aging", "stale", "missing", "unknown"];
const FREQUENCIES: ReadonlyArray<string> = ["hourly", "daily", "weekly", "monthly", "yearly"];
const RETENTION_UNITS: ReadonlyArray<string> = ["days", "weeks", "months", "years"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRetentionItem(value: unknown): value is BackupRetentionItem {
  return isRecord(value)
    && FREQUENCIES.includes(String(value.frequency))
    && RETENTION_UNITS.includes(String(value.unit))
    && typeof value.keep === "number"
    && (value.everyHours === null || typeof value.everyHours === "number");
}

/**
 * Narrow the API payload. Returns null for anything that isn't the
 * /v1/admin/backups contract (an older API, a proxy error page), so the
 * card shows "couldn't load" instead of guessing.
 */
export function normalizeAdminBackups(raw: unknown): AdminBackupsResp | null {
  if (!isRecord(raw) || !isRecord(raw.atlas)) return null;
  const atlas = raw.atlas as Partial<AtlasBackupStatus>;
  if (
    typeof atlas.configured !== "boolean"
    || typeof atlas.available !== "boolean"
    || !FRESHNESS.includes(atlas.freshness as BackupFreshness)
  ) {
    return null;
  }
  const thresholds = isRecord(raw.thresholds)
    && typeof raw.thresholds.freshMaxHours === "number"
    && typeof raw.thresholds.agingMaxHours === "number"
    ? { freshMaxHours: raw.thresholds.freshMaxHours, agingMaxHours: raw.thresholds.agingMaxHours }
    : DEFAULT_THRESHOLDS;
  return {
    asOf: typeof raw.asOf === "string" ? raw.asOf : new Date().toISOString(),
    thresholds,
    atlas: {
      configured: atlas.configured,
      available: atlas.available,
      stale: atlas.stale === true,
      checkedAt: typeof atlas.checkedAt === "string" ? atlas.checkedAt : null,
      errorCode: atlas.errorCode ?? null,
      freshness: atlas.freshness as BackupFreshness,
      ageHours: typeof atlas.ageHours === "number" ? atlas.ageHours : null,
      lastSnapshotAt: typeof atlas.lastSnapshotAt === "string" ? atlas.lastSnapshotAt : null,
      latestStatus: atlas.latestStatus ?? null,
      completedSnapshotCount: typeof atlas.completedSnapshotCount === "number"
        ? atlas.completedSnapshotCount
        : 0,
      nextSnapshotAt: typeof atlas.nextSnapshotAt === "string" ? atlas.nextSnapshotAt : null,
      retention: Array.isArray(atlas.retention) ? atlas.retention.filter(isRetentionItem) : [],
      cloudBackupEnabled: typeof atlas.cloudBackupEnabled === "boolean"
        ? atlas.cloudBackupEnabled
        : null,
      pointInTime: isRecord(atlas.pointInTime)
        ? {
          enabled: typeof atlas.pointInTime.enabled === "boolean" ? atlas.pointInTime.enabled : null,
          windowDays: typeof atlas.pointInTime.windowDays === "number"
            ? atlas.pointInTime.windowDays
            : null,
        }
        : { enabled: null, windowDays: null },
    },
    inApp: normalizeInApp(raw.inApp),
  };
}

function normalizeInApp(raw: unknown): InAppSnapshotCounts | null {
  if (!isRecord(raw) || typeof raw.snapshotCount !== "number" || typeof raw.userCount !== "number") {
    return null;
  }
  return {
    snapshotCount: raw.snapshotCount,
    userCount: raw.userCount,
    newestAt: typeof raw.newestAt === "string" ? raw.newestAt : null,
    storageBytes: typeof raw.storageBytes === "number" ? raw.storageBytes : null,
  };
}
