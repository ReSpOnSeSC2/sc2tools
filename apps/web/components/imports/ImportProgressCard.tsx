"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { ChevronDown, ChevronRight, StopCircle } from "lucide-react";
import { apiCall, type ClientApiError } from "@/lib/clientApi";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  ERROR_CODE_COPY,
  fmtEta,
  isBenignImportSkip,
  type ImportJob,
} from "./useImportStatus";

/**
 * Live progress for a bulk replay import: N/M with ETA, a cyan
 * progress bar, per-reason failure breakdown with human copy, and a
 * Cancel affordance. Pure presentational — feed it the job from
 * useImportStatus so every surface (checklist, dashboard, wizard,
 * Settings) shows identical numbers.
 */
export function ImportProgressCard({
  job,
  active,
  pct,
  etaSeconds,
  onCancelled,
}: {
  job: ImportJob;
  active: boolean;
  pct: number;
  etaSeconds: number | null;
  onCancelled?: () => void;
}) {
  const { getToken } = useAuth();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);

  const processed = (job.completed || 0) + (job.errors || 0);
  const remaining =
    typeof job.remaining === "number" && Number.isFinite(job.remaining)
      ? Math.max(0, job.remaining)
      : Math.max(0, (job.total || 0) - processed);
  const displayTotal = Math.max(job.total || 0, processed + remaining);
  const handled = Math.max(processed, displayTotal - remaining);
  const eta = fmtEta(etaSeconds);
  const isDone = job.status === "done";
  const isStalled = job.status === "stalled";
  const breakdown = job.errorBreakdown || {};
  const aiGameSkips = breakdown.ai_game || 0;
  const resumedReplaySkips = breakdown.resumed_replay || 0;
  const filteredSkips = breakdown.filtered || 0;
  const intentionalSkipCount = Object.entries(breakdown).reduce(
    (sum, [code, count]) => sum + (isBenignImportSkip(code) ? count : 0),
    0,
  );
  const acceptedCount = Math.max(
    0,
    (job.completed || 0) - intentionalSkipCount,
  );
  const failureCount = Math.max(0, job.errors || 0);
  const samples = job.errorSamples || [];

  async function cancel() {
    setCancelling(true);
    setCancelError(null);
    try {
      await apiCall(getToken, "/v1/import/cancel", {
        method: "POST",
        body: "{}",
      });
      onCancelled?.();
    } catch (err) {
      setCancelError(
        (err as ClientApiError | undefined)?.message ?? "Couldn't cancel.",
      );
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="space-y-2" data-testid="import-progress-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-caption">
          <Badge
            variant={isDone ? "success" : active ? "cyan" : "warning"}
            size="sm"
          >
            {isDone
              ? "Import complete"
              : isStalled
                ? "Background sync continuing"
              : active
                ? "Importing your history"
                : job.status}
          </Badge>
          {eta && active && !isStalled ? (
            <span className="text-text-dim">{eta}</span>
          ) : null}
        </div>
        <span className="tabular-nums text-caption text-text-muted">
          {handled.toLocaleString()} / {displayTotal.toLocaleString()} replay
          files checked
        </span>
      </div>

      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-2 w-full overflow-hidden rounded-full bg-bg-elevated"
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-accent-cyan to-accent shadow-halo-cyan transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3 text-caption text-text-dim">
        <span>accepted: {acceptedCount.toLocaleString()}</span>
        <span>remaining: {remaining.toLocaleString()}</span>
        {aiGameSkips > 0 ? <span>vs AI skipped: {aiGameSkips}</span> : null}
        {resumedReplaySkips > 0 ? (
          <span>replay-resume sessions skipped: {resumedReplaySkips}</span>
        ) : null}
        {filteredSkips > 0 ? (
          <span>outside date range skipped: {filteredSkips}</span>
        ) : null}
        {failureCount > 0 ? (
          <button
            type="button"
            onClick={() => setShowErrors((v) => !v)}
            className="inline-flex items-center gap-1 text-danger hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
            aria-expanded={showErrors}
          >
            {showErrors ? (
              <ChevronDown className="h-3 w-3" aria-hidden />
            ) : (
              <ChevronRight className="h-3 w-3" aria-hidden />
            )}
            {failureCount.toLocaleString()} file
            {failureCount === 1 ? "" : "s"} couldn&apos;t be imported
          </button>
        ) : null}
        {active || isStalled ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmCancel(true)}
            disabled={cancelling}
            iconLeft={<StopCircle className="h-3.5 w-3.5" aria-hidden />}
            className="ml-auto"
          >
            Cancel
          </Button>
        ) : null}
      </div>

      {showErrors && failureCount > 0 ? (
        <div className="space-y-2 rounded-lg border border-border bg-bg-elevated/60 p-3">
          {Object.entries(breakdown)
            .filter(([code]) => !isBenignImportSkip(code))
            .map(([code, count]) => (
              <div key={code} className="text-caption">
                <span className="font-semibold text-text">
                  {count}× {code.replaceAll("_", " ")}
                </span>{" "}
                <span className="text-text-muted">
                  {ERROR_CODE_COPY[code] || ""}
                </span>
              </div>
            ))}
          {samples.length > 0 ? (
            <ul className="space-y-0.5 border-t border-border pt-2">
              {samples
                .filter((s) => !isBenignImportSkip(s.errorCode))
                .slice(0, 10)
                .map((s, i) => (
                  <li
                    key={`${s.file}-${i}`}
                    className="truncate font-mono text-micro text-text-dim"
                  >
                    {s.file}
                    <span className="text-text-dim/70"> — {s.errorCode}</span>
                  </li>
                ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {isDone ? (
        <p className="text-caption text-success">
          {acceptedCount.toLocaleString()} replay files accepted. Live sync
          keeps things current from here — just play.
        </p>
      ) : null}
      {isStalled ? (
        <p className="text-caption text-warning">
          Progress paused after no confirmed outcomes. {remaining.toLocaleString()} replay
          {remaining === 1 ? " file remains" : " files remain"}. Background sync is
          still checking them; waiting or rate-limited files are not counted as accepted.
        </p>
      ) : null}
      {cancelError ? (
        <p className="text-caption text-danger" role="alert">
          {cancelError}
        </p>
      ) : null}

      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={async () => {
          setConfirmCancel(false);
          await cancel();
        }}
        title="Cancel this import?"
        description="Already-imported games stay in the cloud, and background sync keeps watching for new replays. You can restart the import any time from Settings."
        confirmLabel="Cancel import"
        cancelLabel="Keep importing"
        intent="danger"
      />
    </div>
  );
}
