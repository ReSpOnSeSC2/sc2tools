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
  const eta = fmtEta(etaSeconds);
  const isDone = job.status === "done";
  const breakdown = job.errorBreakdown || {};
  const benignSkips = breakdown.ai_game || 0;
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
              : active
                ? "Importing your history"
                : job.status}
          </Badge>
          {eta && active ? (
            <span className="text-text-dim">{eta}</span>
          ) : null}
        </div>
        <span className="tabular-nums text-caption text-text-muted">
          {processed.toLocaleString()} / {(job.total || 0).toLocaleString()}{" "}
          replays
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
        <span>imported: {(job.completed || 0).toLocaleString()}</span>
        {benignSkips > 0 ? <span>vs AI skipped: {benignSkips}</span> : null}
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
        {active ? (
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
            .filter(([code]) => code !== "ai_game")
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
                .filter((s) => s.errorCode !== "ai_game")
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
          {(job.completed || 0).toLocaleString()} replays imported. Live sync
          keeps things current from here — just play.
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
