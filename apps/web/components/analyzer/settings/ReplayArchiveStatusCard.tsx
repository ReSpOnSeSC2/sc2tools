"use client";

import Link from "next/link";
import {
  AlertTriangle,
  Cloud,
  CloudOff,
  Download,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useApi } from "@/lib/clientApi";
import { fmtAgo } from "@/lib/format";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";

export type ReplayArchiveStatus = {
  totalGames: number;
  archivedGames: number;
  missingGames: number;
  archiveComplete: boolean;
  enabled: boolean;
  backfillVersion: number;
  resyncRequestedAt: string | null;
  requiresResync: boolean;
};

/**
 * Account-scoped original-replay readiness. This intentionally consumes only
 * the aggregate `/me` status contract: object keys, bucket names, provider
 * account IDs, and credentials never reach this surface.
 */
export function ReplayArchiveStatusCard() {
  const request = useApi<unknown>("/v1/me/replay-archive-status", {
    refreshInterval: (latest) => {
      const value = normalizeReplayArchiveStatus(latest);
      return value?.enabled && !value.archiveComplete ? 30_000 : 0;
    },
    revalidateOnFocus: true,
  });
  const status = normalizeReplayArchiveStatus(request.data);

  return (
    <Section
      title="Cloud Replay Archive"
      description="Private originals for clean downloads, alongside the replay analysis already in your account."
    >
      {request.isLoading && !request.data ? (
        <Card>
          <div
            className="flex min-h-28 items-center gap-3 text-body text-text-muted"
            role="status"
            aria-live="polite"
            aria-busy="true"
          >
            <Cloud className="h-5 w-5 animate-pulse text-accent-cyan" aria-hidden />
            Checking replay archive readiness&hellip;
          </div>
        </Card>
      ) : status ? (
        <ArchiveStatus status={status} />
      ) : (
        <Card>
          <div className="flex items-start gap-3" role="status">
            <StatusIcon tone="neutral">
              <AlertTriangle className="h-5 w-5" aria-hidden />
            </StatusIcon>
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-body-lg font-semibold text-text">
                  Archive status temporarily unavailable
                </h3>
                <Badge variant="neutral">Unknown</Badge>
              </div>
              <p className="text-body text-text-muted">
                Your replay data has not been changed. Refresh this page in a
                moment to check archive coverage again.
              </p>
            </div>
          </div>
        </Card>
      )}
    </Section>
  );
}

function ArchiveStatus({ status }: { status: ReplayArchiveStatus }) {
  if (!status.enabled) {
    return (
      <Card>
        <div className="flex items-start gap-3">
          <StatusIcon tone="neutral">
            <CloudOff className="h-5 w-5" aria-hidden />
          </StatusIcon>
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-body-lg font-semibold text-text">
                Cloud archive unavailable
              </h3>
              <Badge variant="neutral">Unavailable</Badge>
            </div>
            <p className="text-body text-text-muted">
              Original replay storage is not currently enabled. Your parsed
              game analysis remains available.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  const presentation = archivePresentation(status);
  const Icon = presentation.Icon;
  const archived = status.archivedGames.toLocaleString("en-US");
  const missing = status.missingGames.toLocaleString("en-US");
  const total = status.totalGames.toLocaleString("en-US");
  const coverage = status.totalGames > 0
    ? Math.round((status.archivedGames / status.totalGames) * 100)
    : 100;

  return (
    <Card variant={status.requiresResync ? "feature" : "default"}>
      <div className="space-y-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <StatusIcon tone={presentation.tone}>
              <Icon className="h-5 w-5" aria-hidden />
            </StatusIcon>
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-body-lg font-semibold text-text">
                  {presentation.title}
                </h3>
                <Badge variant={presentation.badgeVariant}>
                  {presentation.badge}
                </Badge>
              </div>
              <p className="max-w-2xl text-body text-text-muted">
                {presentation.description}
              </p>
              {status.resyncRequestedAt && !status.archiveComplete ? (
                <p className="text-caption text-text-dim">
                  Full re-sync started {fmtAgo(status.resyncRequestedAt)}.
                </p>
              ) : null}
            </div>
          </div>
          <Link
            href="/download"
            className={[
              "hard-press inline-flex min-h-11 flex-shrink-0 items-center justify-center gap-2 rounded-full border-2 border-line px-4 font-display text-caption font-bold",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
              status.requiresResync
                ? "bg-accent text-white hover:bg-accent-hover"
                : "bg-bg-surface text-text hover:bg-bg-elevated",
            ].join(" ")}
          >
            <Download className="h-4 w-4" aria-hidden />
            {presentation.actionLabel}
          </Link>
        </div>

        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <ArchiveCount
            label="Archived originals"
            value={archived}
            detail={status.totalGames > 0 ? `of ${total} saved games` : "ready to receive files"}
            testId="archive-archived-count"
          />
          <ArchiveCount
            label="Missing originals"
            value={missing}
            detail={status.missingGames === 0 ? "nothing to recover" : "not downloadable yet"}
            testId="archive-missing-count"
          />
          <ArchiveCount
            label="Archive coverage"
            value={`${coverage}%`}
            detail="original files only"
            testId="archive-coverage"
          />
        </dl>

        {status.totalGames > 0 ? (
          <div className="space-y-1.5">
            <div
              className="h-2 overflow-hidden rounded-full bg-bg-elevated"
              role="progressbar"
              aria-label="Replay archive coverage"
              aria-valuemin={0}
              aria-valuemax={status.totalGames}
              aria-valuenow={status.archivedGames}
              aria-valuetext={`${archived} of ${total} original replays archived`}
            >
              <span
                className="block h-full rounded-full bg-accent-cyan transition-[width]"
                style={{ width: `${coverage}%` }}
              />
            </div>
            <p className="text-caption text-text-dim">
              Originals stay private to your account. The browser cannot start
              a full folder scan; run Re-sync replay library from the desktop
              agent when prompted.
            </p>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function ArchiveCount({
  label,
  value,
  detail,
  testId,
}: {
  label: string;
  value: string;
  detail: string;
  testId: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-bg-elevated/70 px-3 py-3">
      <dt className="text-micro font-semibold uppercase tracking-wider text-text-dim">
        {label}
      </dt>
      <dd
        className="mt-1 font-display text-h3 font-bold tabular-nums text-text"
        data-testid={testId}
      >
        {value}
      </dd>
      <p className="text-caption text-text-muted">{detail}</p>
    </div>
  );
}

function StatusIcon({
  tone,
  children,
}: {
  tone: "success" | "warning" | "accent" | "neutral";
  children: React.ReactNode;
}) {
  const classes = {
    success: "border-success/30 bg-success/10 text-success",
    warning: "border-warning/30 bg-warning/10 text-warning",
    accent: "border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan",
    neutral: "border-border bg-bg-elevated text-text-muted",
  }[tone];
  return (
    <span
      className={`inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg border ${classes}`}
    >
      {children}
    </span>
  );
}

function archivePresentation(status: ReplayArchiveStatus): {
  title: string;
  description: string;
  badge: string;
  badgeVariant: BadgeVariant;
  actionLabel: string;
  tone: "success" | "warning" | "accent";
  Icon: typeof Cloud;
} {
  if (status.requiresResync) {
    return {
      title: "Full re-sync required",
      description:
        `${status.missingGames.toLocaleString("en-US")} saved ${status.missingGames === 1 ? "game is" : "games are"} missing the original file. `
        + "Install the latest agent, choose All time, then click Re-sync replay library once. Files still on this PC will upload without duplicating games.",
      badge: "Action needed",
      badgeVariant: "warning",
      actionLabel: "Download latest agent",
      tone: "warning",
      Icon: RefreshCw,
    };
  }
  if (status.archiveComplete && status.totalGames > 0) {
    return {
      title: "Archive up to date",
      description:
        "Every saved game has its original replay archived privately and ready to download from replay history or game analysis.",
      badge: "Ready",
      badgeVariant: "success",
      actionLabel: "Check for agent updates",
      tone: "success",
      Icon: ShieldCheck,
    };
  }
  if (status.totalGames === 0) {
    return {
      title: "Ready for your first replay",
      description:
        "The latest desktop agent will sync analysis and privately archive each original replay after a game finishes.",
      badge: "Ready",
      badgeVariant: "success",
      actionLabel: "Install latest agent",
      tone: "success",
      Icon: ShieldCheck,
    };
  }
  return {
    title: "Full re-sync started",
    description:
      "Keep the desktop agent open while it checks local replay files. Originals no longer on this PC may remain unavailable; you do not need to restart the scan just for those files.",
    badge: "Scanning / partial",
    badgeVariant: "cyan",
    actionLabel: "View re-sync guide",
    tone: "accent",
    Icon: Cloud,
  };
}

export function normalizeReplayArchiveStatus(
  value: unknown,
): ReplayArchiveStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const totalGames = nonNegativeInteger(data.totalGames);
  const archivedGames = nonNegativeInteger(data.archivedGames);
  const missingGames = nonNegativeInteger(data.missingGames);
  const backfillVersion = nonNegativeInteger(data.backfillVersion);
  const resyncRequestedAt = data.resyncRequestedAt;
  const enabled = data.enabled;
  const requiresResync = data.requiresResync;
  if (
    totalGames === null
    || archivedGames === null
    || missingGames === null
    || backfillVersion === null
    || archivedGames + missingGames !== totalGames
    || typeof data.archiveComplete !== "boolean"
    || data.archiveComplete !== (missingGames === 0)
    || typeof enabled !== "boolean"
    || typeof requiresResync !== "boolean"
    || (
      resyncRequestedAt !== null
      && (
        typeof resyncRequestedAt !== "string"
        || Number.isNaN(new Date(resyncRequestedAt).getTime())
      )
    )
  ) {
    return null;
  }
  const expectedRequiresResync =
    enabled
    && totalGames > 0
    && missingGames > 0
    && (backfillVersion < 1 || resyncRequestedAt === null);
  if (requiresResync !== expectedRequiresResync) return null;
  return data as ReplayArchiveStatus;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : null;
}
