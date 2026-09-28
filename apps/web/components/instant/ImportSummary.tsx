"use client";

/**
 * ImportSummary — what a signed-in browser import (or a Folder Sync pass)
 * did: games added / updated / already in the account / refused / left
 * for later, why the upload stopped early (daily cap, expired session,
 * busy servers, cancel), the optional original-file backup, and skipped
 * or failed replays grouped by kind. Counts only — never a file or player
 * name. Every row hides itself when its count is zero.
 *
 * The headline is not a live region: the panel that shows the summary
 * announces the result through its own always-mounted status region (a
 * region inserted together with its text is often not read). With
 * `autoFocus` the headline takes keyboard focus when the card appears.
 *
 * Example:
 *   <ImportSummary counts={summary} backup={summary.backup} failed={session.failed}
 *     onImportMore={session.reset} />
 */
import { useEffect, useRef } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, MinusCircle } from "lucide-react";
import { Button } from "@/components/ui";
import { uploadsResumeText } from "@/lib/instant/displayUnits";
import { summarizeFailures, type ErrorCopy, type FailureGroup } from "@/lib/instant/errorCopy";
import type { BackupStopReason, BackupSummary } from "@/lib/instant/replayBackup";
import type { UploadCounts } from "@/lib/instant/importRunner";
import type { FailedParse } from "@/lib/instant/types";
import type { UploadStopReason } from "@/lib/instant/uploader";

export interface ImportSummaryProps {
  counts: UploadCounts;
  failed: ReadonlyArray<FailedParse>;
  /** Original-file backup result; omitted or null when it did not run. */
  backup?: BackupSummary | null;
  onImportMore?: () => void;
  /** Show "Open your dashboard" (off where the page has its own exit). */
  showDashboardLink?: boolean;
  /** Replays left out of this run by the per-run cap (0 hides the line). */
  truncatedCount?: number;
  /** Move keyboard focus to the headline when the card mounts. */
  autoFocus?: boolean;
  className?: string;
}

const STOP_COPY: Record<UploadStopReason, ErrorCopy> = {
  daily_cap: {
    title: "Daily browser upload limit reached",
    hint:
      "Browser uploads are limited per day and the limit resets at midnight UTC. Import the rest tomorrow — " +
      "games already uploaded are skipped automatically — or install the desktop agent, which has no daily limit.",
  },
  auth: {
    title: "Your session expired",
    hint: "Sign in again, then import the same replays — games already uploaded are skipped automatically.",
  },
  server: {
    title: "Our servers are busy",
    hint: "The upload stopped after several retries. Try again in a few minutes — games already uploaded are skipped automatically.",
  },
  aborted: {
    title: "Upload cancelled",
    hint: "Games uploaded before you cancelled are kept in your account.",
  },
};

/**
 * Title + hint for an early stop of the upload; for the daily cap the hint
 * also says when uploads resume (local time) when the server said so.
 *
 * Example:
 *   stopCopy("daily_cap").title; // -> "Daily browser upload limit reached"
 */
export function stopCopy(reason: UploadStopReason, resetAt?: number | null): ErrorCopy {
  const copy = STOP_COPY[reason];
  const resume = reason === "daily_cap" ? uploadsResumeText(resetAt) : null;
  return resume ? { ...copy, hint: `${resume} ${copy.hint}` } : copy;
}

/**
 * The one-line headline of a summary (also what the panel announces).
 *
 * Example:
 *   importHeadline({ uploaded: 2, created: 2, skippedExisting: 0, rejected: 0, pending: 0 }); // -> "Import complete"
 */
export function importHeadline(counts: UploadCounts): string {
  if (counts.stoppedReason === "aborted") return "Upload cancelled";
  if (counts.stoppedReason) return "Import stopped early";
  if (counts.uploaded === 0 && counts.skippedExisting === 0) return "No games were uploaded";
  return "Import complete";
}

/**
 * The count rows to show (zero rows are left out).
 *
 * Example:
 *   summaryRows({ uploaded: 3, created: 2, skippedExisting: 0, rejected: 0, pending: 0 });
 *   // -> [{ label: "Added to your account", value: 2 }, { label: "Updated", value: 1 }]
 */
export function summaryRows(counts: UploadCounts): Array<{ label: string; value: number }> {
  const rows = [
    { label: "Added to your account", value: counts.created },
    { label: "Updated", value: Math.max(0, counts.uploaded - counts.created) },
    { label: "Already in your account", value: counts.skippedExisting },
    { label: "Refused by the server", value: counts.rejected },
    { label: "Not uploaded yet", value: counts.pending },
  ];
  return rows.filter((row) => row.value > 0);
}

function StopNotice({ reason, resetAt }: { reason: UploadStopReason; resetAt?: number }) {
  const copy = stopCopy(reason, resetAt);
  return (
    <div role="alert" className="flex gap-2 rounded-lg border-2 border-warning/50 bg-warning/10 px-3 py-2 text-caption">
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-warning" aria-hidden />
      <p className="min-w-0">
        <span className="block font-semibold text-text">{copy.title}</span>
        <span className="text-text-muted">{copy.hint}</span>
      </p>
    </div>
  );
}

/** Neutral note when the backup could not run at all (no store, or R2 blocked the browser). */
export const BACKUP_UNAVAILABLE_TEXT =
  "Your games were imported. Original-file backup isn't available right now, so no replay files were uploaded.";

/** Why the backup stopped early, appended to the counts. */
const BACKUP_STOP_NOTES: Record<BackupStopReason, string> = {
  unavailable: "replay backup is unavailable right now",
  auth: "stopped because your session expired",
  aborted: "stopped when you cancelled",
};

/**
 * The one line about original-file backup, or null when there is nothing
 * to say. When backup was unavailable before any file went up, the line is
 * the neutral {@link BACKUP_UNAVAILABLE_TEXT} (the import itself succeeded).
 *
 * Example:
 *   backupLine({ backedUp: [], alreadyStored: [], skipped: [], failed: [], stoppedReason: "unavailable" });
 *   // -> BACKUP_UNAVAILABLE_TEXT
 */
export function backupLine(backup: BackupSummary): string | null {
  if (backup.stoppedReason === "unavailable" && backup.backedUp.length === 0) return BACKUP_UNAVAILABLE_TEXT;
  const counts: ReadonlyArray<[number, string]> = [
    [backup.backedUp.length, "backed up"],
    [backup.alreadyStored.length, "already stored"],
    [backup.skipped.length, "skipped"],
    [backup.failed.length, "failed"],
  ];
  const parts = counts.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
  if (backup.stoppedReason) parts.push(BACKUP_STOP_NOTES[backup.stoppedReason]);
  return parts.length > 0 ? `Original replay files: ${parts.join(", ")}.` : null;
}

/**
 * Skipped / failed replays grouped by kind (shared with Folder Sync).
 *
 * Example:
 *   <FailureGroups groups={summarizeFailures(failed)} />
 */
export function FailureGroups({ groups }: { groups: ReadonlyArray<FailureGroup> }) {
  if (groups.length === 0) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-caption font-semibold text-text">Skipped or not analyzed</h3>
      <ul className="space-y-2">
        {groups.map((group) => {
          const Icon = group.skipped ? MinusCircle : AlertTriangle;
          return (
            <li key={group.kind} className="flex gap-2 text-caption">
              <Icon className={["mt-0.5 h-4 w-4 flex-shrink-0", group.skipped ? "text-text-dim" : "text-warning"].join(" ")} aria-hidden />
              <span className="min-w-0">
                <span className="font-semibold tabular-nums text-text">{group.count}</span>
                <span className="font-semibold text-text"> · {group.copy.title}</span>
                <span className="block text-text-muted">{group.copy.hint}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const LINK_CLASS = [
  "inline-flex min-h-[44px] items-center justify-center rounded-full border-2 border-line bg-accent px-5",
  "font-display text-body font-bold text-white hard-press hover:bg-accent-hover",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
].join(" ");

function CountRows({ counts }: { counts: UploadCounts }) {
  const rows = summaryRows(counts);
  if (rows.length === 0) return null;
  return (
    <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {rows.map((row) => (
        <div key={row.label} className="flex items-baseline justify-between gap-3 rounded-lg bg-bg-elevated px-3 py-2">
          <dt className="text-caption text-text-muted">{row.label}</dt>
          <dd className="font-display text-h4 tabular-nums text-text">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function SummaryActions({ counts, showDashboardLink, onImportMore }: {
  counts: UploadCounts;
  showDashboardLink: boolean;
  onImportMore?: () => void;
}) {
  const hasGames = counts.uploaded + counts.skippedExisting > 0;
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
      {showDashboardLink && hasGames ? (
        <Link href="/app" className={LINK_CLASS}>
          Open your dashboard
        </Link>
      ) : null}
      {onImportMore ? (
        <Button variant="secondary" onClick={onImportMore}>
          Import more replays
        </Button>
      ) : null}
    </div>
  );
}

function Headline({ counts, autoFocus }: { counts: UploadCounts; autoFocus: boolean }) {
  const Icon = counts.stoppedReason ? AlertTriangle : CheckCircle2;
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (autoFocus) heading.current?.focus();
  }, [autoFocus]);
  return (
    <div className="flex items-center gap-2">
      <Icon className={["h-5 w-5 flex-shrink-0", counts.stoppedReason ? "text-warning" : "text-success"].join(" ")} aria-hidden />
      <h2 ref={heading} tabIndex={-1} className="font-display text-h4 text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        {importHeadline(counts)}
      </h2>
    </div>
  );
}

function TruncatedNote({ count }: { count: number }) {
  if (count <= 0) return null;
  const noun = count === 1 ? "replay was" : "replays were";
  return (
    <p className="text-caption text-text-muted">
      {count} older {noun} left out of this run. Run the import again, or use Folder Sync, for the rest.
    </p>
  );
}

/**
 * Result card for one import.
 *
 * Example:
 *   <ImportSummary counts={{ uploaded: 3, created: 3, skippedExisting: 0, rejected: 0, pending: 0 }} failed={[]} />
 */
export function ImportSummary(props: ImportSummaryProps) {
  const { counts, failed, backup = null, onImportMore, showDashboardLink = true, className = "" } = props;
  const { truncatedCount = 0, autoFocus = false } = props;
  const backupText = backup ? backupLine(backup) : null;
  return (
    <section
      aria-label="Import summary"
      className={["space-y-4 rounded-xl border-2 border-line bg-bg-surface p-4 shadow-hard", className].filter(Boolean).join(" ")}
    >
      <Headline counts={counts} autoFocus={autoFocus} />
      <CountRows counts={counts} />
      {counts.stoppedReason ? <StopNotice reason={counts.stoppedReason} resetAt={counts.dailyCapResetAt} /> : null}
      <TruncatedNote count={truncatedCount} />
      {backupText ? <p className="text-caption text-text-muted">{backupText}</p> : null}
      <FailureGroups groups={summarizeFailures(failed)} />
      <SummaryActions counts={counts} showDashboardLink={showDashboardLink} onImportMore={onImportMore} />
    </section>
  );
}
