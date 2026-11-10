"use client";

import { useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { RefreshCw } from "lucide-react";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import { useUserSocket } from "@/lib/useUserSocket";
import {
  REANALYSIS_ERROR_COPY,
  cohortTitle,
  cohortTitleById,
  formatEta,
  formatMilestoneDate,
  isActiveJob,
  normalizeReanalysis,
  type ReanalysisCohort,
  type ReanalysisJob,
  type ReanalysisOverview,
} from "@/lib/reanalysis";
import { Button, LinkButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { RequestError } from "@/components/ui/RequestError";
import { Section } from "@/components/ui/Section";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";

const PATH = "/v1/me/reanalysis";
const STATS_NOTE =
  "Historical stats will change: each game gets the current engine's build and opponent-strategy labels, so win rates by build and matchup trends include the corrected labels.";

/**
 * Settings → Backups & data: "Re-analyze games". Lists the owner's cohorts
 * (games labelled by an engine older than a label-changing release, games
 * missing a macro score, games with no engine version) and runs one paced
 * job through the desktop agent. Live progress arrives as
 * `reanalysis:progress`; the status read doubles as the job's watchdog.
 */
export function ReanalysisCard() {
  const { getToken } = useAuth();
  const request = useApi<unknown>(PATH, {
    refreshInterval: (latest) => (isActiveJob(normalizeReanalysis(latest)?.job) ? 30_000 : 0),
    revalidateOnFocus: true,
  });
  const overview = normalizeReanalysis(request.data);
  const active = isActiveJob(overview?.job);
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const { mutate } = request;

  const handlers = useMemo(() => (active ? {
    "reanalysis:progress": (payload: unknown) => {
      void mutate((current: unknown) => {
        const merged = normalizeReanalysis(current && typeof current === "object" ? { ...current, job: payload } : null);
        return merged ?? current;
      }, { revalidate: false });
      const status = (payload as { status?: unknown } | null)?.status;
      if (typeof status === "string" && !["running", "waiting_for_agent", "update_required", "paused"].includes(status)) void mutate();
    },
  } : null), [active, mutate]);
  useUserSocket(handlers);

  async function send(action: string, path: string, body: Record<string, string>) {
    if (pending) return;
    setPending(action);
    setError("");
    try {
      await apiCall(getToken, path, { method: "POST", body: JSON.stringify(body) });
      await mutate();
    } catch (failure) {
      const code = (failure as ClientApiError | undefined)?.code;
      setError((code && REANALYSIS_ERROR_COPY[code]) || (failure as ClientApiError | undefined)?.message || "Please try again.");
    } finally {
      setPending(null);
    }
  }

  return (
    <Section
      id="reanalyze"
      className="scroll-mt-28"
      title="Re-analyze games"
      description="Bring games analyzed by an older engine up to date. Your desktop agent re-reads each replay, from this PC or your replay archive, in batches of 100."
    >
      <Card>
        {request.isLoading && !request.data ? (
          <p className="flex min-h-16 items-center gap-2 text-body text-text-muted" role="status" aria-live="polite" aria-busy="true">
            <RefreshCw className="h-4 w-4 motion-safe:animate-spin text-accent-cyan" aria-hidden />
            Counting games that need re-analysis&hellip;
          </p>
        ) : request.error && !request.data ? (
          <RequestError
            error={request.error}
            onRetry={() => request.mutate()}
            copy={{ server: { title: "Re-analysis status temporarily unavailable", body: "Your games have not been changed. Try again in a moment." } }}
          />
        ) : overview ? (
          <div className="space-y-4">
            {overview.job && active ? (
              <JobProgress
                job={overview.job}
                agent={overview.agent}
                cohorts={overview.cohorts}
                pending={pending}
                onAction={(action) => void send(action, `${PATH}/${action}`, { jobId: overview.job!.id })}
              />
            ) : (
              <CohortPicker
                overview={overview}
                selected={selected}
                onSelect={setSelected}
                starting={pending === "start"}
                onStart={(cohortId) => void send("start", PATH, { cohortId })}
              />
            )}
            {error ? <p role="alert" className="text-body-sm text-danger">{error}</p> : null}
            <p className="text-caption text-text-muted">
              <LazyHelpLink slug="reanalyze">Re-analyze old games after an update</LazyHelpLink>
            </p>
          </div>
        ) : (
          <p className="text-body text-text-muted" role="status">Re-analysis is not available right now.</p>
        )}
      </Card>
    </Section>
  );
}

function AgentNote({ agent, running }: { agent: ReanalysisOverview["agent"]; running: boolean }) {
  if (agent === "ready") return null;
  if (agent === "update_required") {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-body-sm text-text" role="status">
        <span className="min-w-0 flex-1">Update your desktop agent to re-analyze games. This version cannot run re-analysis.</span>
        <LinkButton href="/download" size="sm" variant="secondary">Get the update</LinkButton>
      </div>
    );
  }
  return (
    <p className="rounded-lg border border-border bg-bg-elevated p-3 text-body-sm text-text-muted" role="status">
      {running
        ? "Your desktop agent is offline. Re-analysis continues when it reconnects."
        : "Your desktop agent is offline. You can start now; games are re-analyzed once it connects."}
    </p>
  );
}

function cohortDetail(cohort: ReanalysisCohort): string {
  if (cohort.kind === "engine") return cohort.summary ?? "";
  if (cohort.kind === "macro") return "Games saved without a macro score, for example when it could not be computed at the time.";
  return "Games uploaded before the desktop agent reported its engine version. Re-analysis records the current one.";
}

function CohortPicker({ overview, selected, onSelect, starting, onStart }: {
  overview: ReanalysisOverview;
  selected: string | null;
  onSelect: (id: string) => void;
  starting: boolean;
  onStart: (cohortId: string) => void;
}) {
  const available = overview.cohorts.filter((cohort) => cohort.count > 0);
  const choice = available.find((cohort) => cohort.id === selected) ?? available[0] ?? null;
  const last = overview.job;
  return (
    <div className="space-y-4">
      {last ? <LastRun job={last} cohorts={overview.cohorts} /> : null}
      {available.length > 0 ? <AgentNote agent={overview.agent} running={false} /> : null}
      {available.length === 0 ? (
        <p className="text-body text-text-muted" role="status">All your games already use the current analysis. Nothing to re-analyze.</p>
      ) : (
        <fieldset className="space-y-2">
          <legend className="mb-2 text-body-sm font-medium text-text">Choose which games to re-analyze</legend>
          {overview.cohorts.map((cohort) => (
            <label
              key={cohort.id}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 focus-within:ring-2 focus-within:ring-accent ${choice?.id === cohort.id ? "border-accent bg-accent/5" : "border-border"} ${cohort.count === 0 ? "cursor-not-allowed opacity-60" : ""}`}
            >
              <input
                type="radio"
                name="reanalysis-cohort"
                value={cohort.id}
                className="mt-1 h-4 w-4 shrink-0 accent-accent"
                checked={choice?.id === cohort.id}
                disabled={cohort.count === 0}
                onChange={() => onSelect(cohort.id)}
              />
              <span className="min-w-0 space-y-1">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium text-text">{cohortTitle(cohort)}</span>
                  <span className="text-caption tabular-nums text-text-muted">{cohort.count.toLocaleString()} game{cohort.count === 1 ? "" : "s"}</span>
                </span>
                {cohort.kind === "engine" ? (
                  <span className="block text-caption text-text-muted">
                    {cohort.matchups?.join(" and ")} games{formatMilestoneDate(cohort.date) ? ` · engine change from ${formatMilestoneDate(cohort.date)}` : ""}
                  </span>
                ) : null}
                <span className="block text-body-sm text-text-muted">What changed: {cohortDetail(cohort)}</span>
                {cohort.kind === "engine" && cohort.unknown ? (
                  <span className="block text-caption text-text-muted">
                    {cohort.unknown.toLocaleString()} more in these matchups have no engine version; choose Engine version unknown for those.
                  </span>
                ) : null}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {choice ? (
        <div className="space-y-2">
          <p className="text-caption text-text-muted">{STATS_NOTE}</p>
          <Button onClick={() => onStart(choice.id)} loading={starting} iconLeft={<RefreshCw className="h-4 w-4" aria-hidden />}>
            Start re-analysis
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function LastRun({ job, cohorts }: { job: ReanalysisJob; cohorts: ReanalysisCohort[] }) {
  const title = cohortTitleById(cohorts, job.cohortId);
  const summary = job.status === "completed"
    ? `${job.updated.toLocaleString()} updated, ${job.unavailable.toLocaleString()} without a replay file, ${job.failed.toLocaleString()} failed.`
    : `Cancelled after ${job.processed.toLocaleString()} of ${job.total.toLocaleString()} games.`;
  return (
    <p className="rounded-lg border border-border p-3 text-body-sm text-text-muted">
      <span className="font-medium text-text">Last run · {title}:</span> {summary}
    </p>
  );
}

function JobProgress({ job, agent, cohorts, pending, onAction }: {
  job: ReanalysisJob;
  agent: ReanalysisOverview["agent"];
  cohorts: ReanalysisCohort[];
  pending: string | null;
  onAction: (action: "pause" | "resume" | "cancel") => void;
}) {
  const percent = job.total > 0 ? Math.min(100, Math.round((job.processed / job.total) * 100)) : 0;
  const eta = job.status === "running" ? formatEta(job.etaSec) : null;
  const status = job.status === "paused"
    ? `Paused at ${job.processed.toLocaleString()} of ${job.total.toLocaleString()} games.`
    : job.status === "waiting_for_agent"
      ? "Waiting for your desktop agent. Re-analysis continues when it is online."
      : job.status === "update_required"
        ? "Waiting for a desktop agent update."
        : `Re-analyzing ${job.processed.toLocaleString()} of ${job.total.toLocaleString()} games${eta ? ` · ${eta} left` : ""}.`;
  return (
    <div className="space-y-3">
      <p className="text-body-sm font-medium text-text">{cohortTitleById(cohorts, job.cohortId)}</p>
      <div
        role="progressbar"
        aria-label="Re-analysis progress"
        aria-valuemin={0}
        aria-valuemax={job.total}
        aria-valuenow={job.processed}
        aria-valuetext={`${job.processed} of ${job.total} games`}
        className="h-2 overflow-hidden rounded-full bg-bg-elevated"
      >
        <div className="h-full rounded-full bg-accent motion-safe:transition-[width] motion-safe:duration-500" style={{ width: `${percent}%` }} />
      </div>
      <p className="text-body-sm text-text" role="status" aria-live="polite">{status}</p>
      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-caption text-text-muted">
        <div className="flex gap-1"><dt>Updated</dt><dd className="tabular-nums text-text">{job.updated.toLocaleString()}</dd></div>
        <div className="flex gap-1"><dt>No replay file</dt><dd className="tabular-nums text-text">{job.unavailable.toLocaleString()}</dd></div>
        <div className="flex gap-1"><dt>Failed</dt><dd className="tabular-nums text-text">{job.failed.toLocaleString()}</dd></div>
      </dl>
      <AgentNote agent={agent} running />
      <div className="flex flex-wrap gap-2">
        {job.status === "paused" ? (
          <Button variant="secondary" size="sm" loading={pending === "resume"} disabled={Boolean(pending)} onClick={() => onAction("resume")}>Resume</Button>
        ) : (
          <Button variant="secondary" size="sm" loading={pending === "pause"} disabled={Boolean(pending)} onClick={() => onAction("pause")}>Pause</Button>
        )}
        <Button variant="ghost" size="sm" loading={pending === "cancel"} disabled={Boolean(pending)} onClick={() => onAction("cancel")}>Cancel re-analysis</Button>
      </div>
      <p className="text-caption text-text-muted">{STATS_NOTE}</p>
    </div>
  );
}

export default ReanalysisCard;
