"use client";

import { useState, type FormEvent } from "react";
import { useAuth } from "@clerk/nextjs";
import { Play, RefreshCw, Square } from "lucide-react";
import { apiCall } from "@/lib/clientApi";
import { fmtDate } from "@/lib/format";
import type {
  GuideAdminStatusPayload,
  GuideBackfillStatus,
  GuideRecomputeState,
  GuideRunSummary,
} from "@/lib/guides/types";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { LoadingRows, MetricStat } from "../../components/AdminFragments";
import { formatDuration, timeSince } from "../../components/format";
import {
  AdminNotice,
  AdminSectionHeader,
  BACKFILL_DAYS_DEFAULT,
  BACKFILL_DAYS_MAX,
  BACKFILL_DAYS_MIN,
  GUIDE_BACKFILL_PATH,
  GUIDE_RECOMPUTE_PATH,
  adminErrorText,
  clampBackfillDays,
  type AdminNoticeValue,
  type AdminResource,
} from "./guidesAdminShared";

const HEADING_ID = "guide-status-heading";
const MS_PER_SECOND = 1000;

/** Backfill reason codes (jobs/guideSamplesBackfillJob.js) → copy. */
const BACKFILL_ERROR_COPY: Readonly<Record<string, string>> = {
  lock_held: "another API instance holds the backfill lock",
  lock_lost: "the backfill lock was lost mid-run",
  run_failed: "the last pass failed (see the API logs)",
};

type Busy = "recompute" | "start" | "stop" | null;

export interface GuideStatusPanelProps {
  status: AdminResource<GuideAdminStatusPayload>;
}

function runCaption(run: GuideRunSummary | null): string {
  if (!run) return "No nightly run has finished yet.";
  const took = formatDuration(Math.round(run.durationMs / MS_PER_SECOND));
  return `${fmtDate(run.computedAt)} · took ${took}`;
}

function recomputeText(state: GuideRecomputeState | undefined): string | null {
  if (!state) return null;
  if (state.running) return "A recompute is running now. This page refreshes until it finishes.";
  if (!state.last) return null;
  const outcome = state.last.ran ? "finished" : `was skipped (${state.last.reason ?? "no reason given"})`;
  return `The last recompute started here ${outcome} ${timeSince(state.last.finishedAt)}.`;
}

function backfillSummary(status: GuideBackfillStatus): string {
  const counts = `${status.processed.toLocaleString()} games processed, ${status.written.toLocaleString()} samples written, ${status.skipped.toLocaleString()} skipped, ${status.failed.toLocaleString()} failed`;
  const window = status.days ? ` over the last ${status.days} days` : "";
  if (status.running) return `Running${window}: ${counts}.`;
  if (!status.startedAt) return "Not started since the API last restarted.";
  const state = status.done ? "Finished" : "Stopped";
  return `${state} ${timeSince(status.finishedAt)}${window}: ${counts}.`;
}

function useStatusActions(status: AdminResource<GuideAdminStatusPayload>) {
  const { getToken } = useAuth();
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<AdminNoticeValue | null>(null);

  async function run(kind: Exclude<Busy, null>, path: string, body: object | null, done: string, lead: string) {
    if (busy) return;
    setBusy(kind);
    setNotice(null);
    try {
      await apiCall<unknown>(getToken, path, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });
      await status.mutate();
      setNotice({ tone: "success", text: done });
    } catch (err) {
      setNotice({ tone: "error", text: adminErrorText(lead, err) });
    } finally {
      setBusy(null);
    }
  }

  return {
    busy,
    notice,
    recompute: () => run("recompute", GUIDE_RECOMPUTE_PATH, null, "Recompute started. It runs in the background and takes a few minutes; the pages refresh when it finishes.", "Couldn't start the recompute."),
    startBackfill: (days: number) => run("start", GUIDE_BACKFILL_PATH, { action: "start", days }, `Backfill started for the last ${days} days.`, "Couldn't start the backfill."),
    stopBackfill: () => run("stop", GUIDE_BACKFILL_PATH, { action: "stop" }, "Backfill stopped. Starting it again resumes where it left off.", "Couldn't stop the backfill."),
  };
}

/**
 * Nightly guide_stats run status + "Recompute now", the guide_samples
 * count and the admin-triggered samples backfill (start/stop with a
 * clamped day window). Counts only; the API never returns ids here.
 */
export function GuideStatusPanel({ status }: GuideStatusPanelProps) {
  const actions = useStatusActions(status);
  const data = status.data;
  const recomputeNote = recomputeText(data?.recompute);
  return (
    <section aria-labelledby={HEADING_ID} className="space-y-4">
      <AdminSectionHeader
        id={HEADING_ID}
        title="Stats runs"
        description="Guide numbers come from a nightly recompute over the game corpus. Recompute after a catalog or rules change instead of waiting for the next night."
        actions={
          <Button
            iconLeft={<RefreshCw className="h-4 w-4" aria-hidden />}
            loading={actions.busy === "recompute"}
            disabled={Boolean(actions.busy) || !data || Boolean(data.recompute?.running)}
            onClick={() => void actions.recompute()}
          >
            Recompute now
          </Button>
        }
      />
      <AdminNotice notice={actions.notice} />
      {status.error ? (
        <Card><p role="alert" className="text-danger">Couldn&apos;t load the run status. {status.error.message}</p></Card>
      ) : !data ? (
        <div role="status" aria-label="Loading run status"><LoadingRows rows={3} /></div>
      ) : (
        <>
          <RunMetrics run={data.run} samples={data.samples.count} />
          {recomputeNote ? <p className="text-caption text-text-muted">{recomputeNote}</p> : null}
          <BackfillCard backfill={data.backfill} busy={actions.busy} onStart={(days) => void actions.startBackfill(days)} onStop={() => void actions.stopBackfill()} />
        </>
      )}
    </section>
  );
}

function RunMetrics({ run, samples }: { run: GuideRunSummary | null; samples: number }) {
  const counts = run?.counts;
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <MetricStat label="Last recompute" value={run ? timeSince(run.computedAt) : "Never"} caption={runCaption(run)} />
      <MetricStat
        label="Published builds"
        value={counts ? counts.published.toLocaleString() : "—"}
        caption={counts ? `of ${counts.builds.toLocaleString()} builds · ${counts.counters.toLocaleString()} counters · ${counts.maps.toLocaleString()} maps` : undefined}
      />
      <MetricStat label="Timing samples" value={samples.toLocaleString()} caption="Pseudonymous build-log samples (guide_samples)" />
    </div>
  );
}

function BackfillCard({
  backfill,
  busy,
  onStart,
  onStop,
}: {
  backfill: GuideBackfillStatus | null;
  busy: Busy;
  onStart: (days: number) => void;
  onStop: () => void;
}) {
  const [daysInput, setDaysInput] = useState(String(backfill?.days ?? BACKFILL_DAYS_DEFAULT));
  const running = Boolean(backfill?.running);
  const unavailable = !backfill || backfill.disabled;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const days = clampBackfillDays(daysInput);
    setDaysInput(String(days));
    onStart(days);
  }

  return (
    <Card>
      <form className="space-y-3" onSubmit={submit} aria-labelledby="guide-backfill-heading">
        <h3 id="guide-backfill-heading" className="text-body font-semibold text-text">Samples backfill</h3>
        <p className="text-caption text-text-muted">
          Timing and army samples are captured as games upload. The backfill walks older games (newest first, at most 2 per second) to fill the timing tables. It never starts on its own.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field className="sm:w-48" label="Days to backfill" hint={`${BACKFILL_DAYS_MIN}–${BACKFILL_DAYS_MAX} days`}>
            <Input
              type="number"
              inputMode="numeric"
              min={BACKFILL_DAYS_MIN}
              max={BACKFILL_DAYS_MAX}
              value={daysInput}
              disabled={unavailable || running}
              onChange={(event) => setDaysInput(event.target.value)}
              onBlur={() => setDaysInput(String(clampBackfillDays(daysInput)))}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" iconLeft={<Play className="h-4 w-4" aria-hidden />} loading={busy === "start"} disabled={unavailable || running || Boolean(busy)}>Start backfill</Button>
            <Button variant="secondary" iconLeft={<Square className="h-4 w-4" aria-hidden />} loading={busy === "stop"} disabled={!running || Boolean(busy)} onClick={onStop}>Stop</Button>
          </div>
        </div>
        <BackfillState backfill={backfill} />
      </form>
    </Card>
  );
}

function BackfillState({ backfill }: { backfill: GuideBackfillStatus | null }) {
  if (!backfill) return <p className="text-caption text-text-dim">The backfill job isn&apos;t available on this API instance.</p>;
  if (backfill.disabled) {
    return <p className="text-caption text-warning">Switched off on this server (SC2TOOLS_GUIDE_BACKFILL_DISABLED or the samples kill switch).</p>;
  }
  const error = backfill.lastError ? BACKFILL_ERROR_COPY[backfill.lastError] ?? backfill.lastError : null;
  return (
    <div className="space-y-1 text-caption text-text-muted">
      <p>{backfillSummary(backfill)}</p>
      {error ? <p className="text-danger">Last problem: {error}.</p> : null}
    </div>
  );
}
