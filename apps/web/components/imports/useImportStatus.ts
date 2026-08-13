"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "@/lib/clientApi";
import { useUserSocket } from "@/lib/useUserSocket";

/** Serialised import job — the REAL wire shape from /v1/import/status
 * and /v1/import/jobs (see apps/api/src/services/import.js
 * serialiseJob). The Settings panel previously expected a
 * `{current: {...}}` envelope that never existed, which is why it
 * always rendered "Idle". */
export type ImportJob = {
  jobId: string;
  kind: string | null;
  status: "pending" | "scanning" | "running" | "stalled" | "done" | "cancelled" | "error" | "idle" | string;
  phase: string | null;
  folder: string | null;
  total: number;
  completed: number;
  errors: number;
  /** Best-known files still awaiting a terminal pipeline outcome. */
  remaining: number | null;
  workers: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastMessage: string;
  errorBreakdown: Record<string, number> | null;
  errorSamples: Array<{ file: string; errorCode: string; message?: string }> | null;
};

type StatusResp = Partial<ImportJob> & {
  ok?: boolean;
  running?: boolean;
  phase?: string | null;
};

/** Human copy for the agent's skip-reason codes (shared contract with
 * apps/agent replay_pipeline SKIP_* + import_controller). */
export const ERROR_CODE_COPY: Record<string, string> = {
  parse_failed:
    "File looks corrupt, cut off, or from an unsupported SC2 version.",
  player_unresolved:
    "Couldn't tell which player is you — set your BattleTag in Settings → Profile, then re-import.",
  no_result: "The replay has no recorded result (left during loading?).",
  ai_game: "Skipped — game vs the AI.",
  resumed_replay:
    "Skipped — a replay-resume session is not a new ladder result.",
  filtered: "Skipped — outside your import date range.",
  rejected_by_server: "The server rejected the upload.",
  file_unstable: "The file never finished writing (cloud-sync lag?).",
  analyzer_unavailable: "The agent's parser couldn't load — restart the agent.",
};

/** Skip reasons that mean the importer deliberately ignored a file. */
export const BENIGN_SKIP_CODES = new Set([
  "ai_game",
  "resumed_replay",
  "filtered",
]);

export function isBenignImportSkip(code: string): boolean {
  return BENIGN_SKIP_CODES.has(code);
}

export type ImportStatusState = {
  /** Latest job (any status), or null before the first job ever. */
  job: ImportJob | null;
  /** True while a job is scanning/running. */
  active: boolean;
  /** 0–100, counting errors as processed so the bar always finishes. */
  pct: number;
  /** Seconds remaining, null until recent forward movement is measurable. */
  etaSeconds: number | null;
  isLoading: boolean;
  refresh: () => void;
};

const ACTIVE_STATUSES = new Set(["scanning", "running", "pending"]);
const CURRENT_JOB_STATUSES = new Set([
  ...ACTIVE_STATUSES,
  "stalled",
]);

/** A stalled reporter still owns the import and may resume in the background. */
export function importJobBlocksStart(status: unknown): boolean {
  return CURRENT_JOB_STATUSES.has(String(status));
}

/** Keep a slow REST fallback alive even when the progress socket is quiet. */
export function importStatusRefreshInterval(latest?: StatusResp): number {
  return latest && importJobBlocksStart(latest.status) ? 5000 : 0;
}

/**
 * Merge one `import:progress` socket event into the accumulated live
 * delta. Two hard rules, both learned from a real seesaw (agent
 * auto-updated mid-backfill, restarted, and re-adopted its job):
 *
 *   1. An event for a DIFFERENT job never merges — mixing two jobs'
 *      counters made the progress bar bounce between their numbers.
 *   2. Counters are monotonic within a job. Socket delivery reorders
 *      around reconnects, and a restarted agent re-reports from a
 *      lower absolute count until it catches back up (the API also
 *      guards with $max) — a lower value never wins.
 */
export function mergeProgressEvent(
  prev: Partial<ImportJob> | null,
  event: Partial<ImportJob> & { jobId?: string },
  currentJobId: string | null,
): Partial<ImportJob> | null {
  if (event.jobId && currentJobId && event.jobId !== currentJobId) {
    return prev;
  }
  const next: Partial<ImportJob> = { ...(prev || {}), ...event };
  if (
    typeof prev?.completed === "number" &&
    typeof event.completed === "number"
  ) {
    next.completed = Math.max(prev.completed, event.completed);
  }
  if (typeof prev?.errors === "number" && typeof event.errors === "number") {
    next.errors = Math.max(prev.errors, event.errors);
  }
  return next;
}

/**
 * Live import-job status: seeds from GET /v1/import/status, then
 * applies `import:progress` socket deltas (the cloud re-emits every
 * agent report to the user room), with the SWR poll as a fallback for
 * tabs whose socket dropped. One hook, consumed by the onboarding
 * checklist, the dashboard card, the wizard's import step, and the
 * Settings panel — so all four read identical numbers.
 */
export function useImportStatus(): ImportStatusState {
  const { data, isLoading, mutate } = useApi<StatusResp>("/v1/import/status", {
    // Poll slowly as the socket fallback; the socket path delivers the
    // real-time feel.
    refreshInterval: importStatusRefreshInterval,
  });
  const [live, setLive] = useState<Partial<ImportJob> | null>(null);

  // Reset socket deltas when the underlying job changes.
  const jobIdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = data?.jobId ? String(data.jobId) : null;
    if (id !== jobIdRef.current) {
      jobIdRef.current = id;
      setLive(null);
    }
  }, [data?.jobId]);

  const handlers = useMemo(
    () => ({
      "import:progress": (payload: unknown) => {
        const p = payload as Partial<ImportJob> & { jobId?: string };
        if (!p || typeof p !== "object") return;
        // A progress event for a DIFFERENT job (agent auto-backfill
        // registered after a restart, or a stale reporter) — refetch
        // so the card switches to the authoritative job, and do NOT
        // merge its counters into the current one: cross-job merging
        // is what made the numbers run backwards and forwards.
        if (p.jobId && p.jobId !== jobIdRef.current) {
          void mutate();
          return;
        }
        setLive((prev) => mergeProgressEvent(prev, p, jobIdRef.current));
        if (typeof p.status === "string") void mutate();
      },
    }),
    [mutate],
  );
  useUserSocket(handlers);

  const job = useMemo<ImportJob | null>(() => {
    if (!data || !data.jobId) return null;
    const merged = { ...data, ...(live || {}) } as ImportJob;
    // Counters take the max of the REST snapshot and the socket
    // delta: whichever source lags (poll write-lag, dropped socket)
    // must never drag the bar backwards.
    merged.completed = Math.max(data.completed || 0, live?.completed ?? 0);
    merged.errors = Math.max(data.errors || 0, live?.errors ?? 0);
    // The socket payload mirrors reportProgress's fields; `done`
    // arrives as a flag rather than a status.
    if ((live as { done?: boolean } | null)?.done) merged.status = "done";
    return merged;
  }, [data, live]);

  const active = !!job && ACTIVE_STATUSES.has(String(job.status));

  const pct = useMemo(() => {
    if (!job) return 0;
    const processed = (job.completed || 0) + (job.errors || 0);
    const remaining =
      typeof job.remaining === "number" && Number.isFinite(job.remaining)
        ? Math.max(0, job.remaining)
        : Math.max(0, (job.total || 0) - processed);
    const total = Math.max(job.total || 0, processed + remaining);
    if (!total) return job.status === "done" ? 100 : 0;
    // An inventory recount can know that files were handled even when a
    // callback was missed. Use that resolved count for the bar, while the
    // card keeps accepted/errors as separately labelled confirmed counts.
    const resolved = Math.max(processed, total - remaining);
    return Math.max(0, Math.min(100, Math.round((resolved / total) * 100)));
  }, [job]);

  // Rolling recent-rate ETA. We deliberately do NOT divide processed by
  // (now - startedAt): the agent's in-memory counters reset toward 0
  // whenever the import job re-registers (agent restart / re-activation)
  // while the server keeps the original startedAt. That combination
  // divides a tiny post-reset `processed` by a huge elapsed span,
  // producing near-zero rates and absurd ETAs (~339h observed). Measuring
  // throughput over the last few reports instead is immune to the reset —
  // see `foldEtaSample`. (The 0.13.6 count-guard keeps the numbers
  // monotonic; this keeps the estimate sane.)
  const etaSamplesRef = useRef<ProgressSample[]>([]);
  const etaJobIdRef = useRef<string | null>(null);
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const etaJobId = job?.jobId ?? null;
  const etaProcessed = (job?.completed || 0) + (job?.errors || 0);
  const etaReportedTotal = job?.total || 0;
  const etaRemaining =
    typeof job?.remaining === "number" && Number.isFinite(job.remaining)
      ? Math.max(0, job.remaining)
      : Math.max(0, etaReportedTotal - etaProcessed);
  const etaEffectiveTotal = Math.max(
    etaReportedTotal,
    etaProcessed + etaRemaining,
  );
  useEffect(() => {
    if (!etaJobId || !active || !etaEffectiveTotal) {
      etaSamplesRef.current = [];
      etaJobIdRef.current = null;
      setEtaSeconds(null);
      return;
    }
    if (etaJobIdRef.current !== etaJobId) {
      etaSamplesRef.current = [];
      etaJobIdRef.current = etaJobId;
    }
    const sample = () => {
      const { samples, etaSeconds: next } = foldEtaSample(
        etaSamplesRef.current,
        {
          t: Date.now(),
          processed: etaProcessed,
          total: etaEffectiveTotal,
        },
      );
      etaSamplesRef.current = samples;
      setEtaSeconds(next);
    };
    sample();
    // The agent intentionally sends no unchanged heartbeats. Sample the
    // wall clock locally so upload backoff/quiet time slows (and eventually
    // hides) the ETA instead of preserving a stale burst rate forever.
    const timer = window.setInterval(sample, 5000);
    return () => window.clearInterval(timer);
  }, [
    active,
    etaEffectiveTotal,
    etaJobId,
    etaProcessed,
  ]);

  return {
    job,
    active,
    pct,
    etaSeconds,
    isLoading,
    refresh: () => void mutate(),
  };
}

/** One (wall-clock ms, cumulative processed-count) reading for the
 * rolling-rate ETA window. */
export type ProgressSample = { t: number; processed: number };

const ETA_WINDOW_MS = 5 * 60_000; // smooth bursty uploads over ~5 minutes
const ETA_MAX_SAMPLES = 60;

/**
 * Fold a fresh progress reading into the rolling ETA window and derive
 * "seconds remaining" from RECENT throughput rather than from the job's
 * startedAt.
 *
 * Why not startedAt: the agent's in-memory counters reset toward 0
 * whenever the import job re-registers (agent restart, or a fresh
 * import:start_request re-activation), while the server keeps the
 * original startedAt. `processed / elapsed-since-startedAt` then divides
 * a tiny post-reset `processed` by a huge elapsed span, yielding a
 * near-zero rate and absurd ETAs (~339h observed in the field). A
 * rolling window over the last few reports measures the rate the user is
 * actually seeing right now and is immune to the reset.
 *
 * Reset handling: a reading whose `processed` is LOWER than the newest
 * sample means the counter reset — we discard the stale window and start
 * measuring afresh, returning null until the new window shows movement.
 *
 * Pure and deterministic (no clock access of its own) so it can be unit
 * tested; the hook feeds it `Date.now()` and stores the returned window.
 */
export function foldEtaSample(
  prev: ProgressSample[],
  reading: { t: number; processed: number; total: number },
  opts: { windowMs?: number; maxSamples?: number } = {},
): { samples: ProgressSample[]; etaSeconds: number | null } {
  const windowMs = opts.windowMs ?? ETA_WINDOW_MS;
  const maxSamples = opts.maxSamples ?? ETA_MAX_SAMPLES;
  const samples = prev.slice();

  const newest = samples[samples.length - 1];
  if (newest && reading.processed < newest.processed) {
    // Counter reset (agent restart / re-activation): the old window no
    // longer describes the current run. Drop it and remeasure.
    samples.length = 0;
  }
  const tail = samples[samples.length - 1];
  if (!tail || reading.t > tail.t) {
    // Keep quiet polls too. Otherwise a long upload backoff is omitted
    // from the rate calculation and the ETA stays falsely optimistic.
    samples.push({ t: reading.t, processed: reading.processed });
  }
  // Age out samples older than the window, but always keep the two most
  // recent so a rate is still measurable, then cap the count.
  while (samples.length > 2 && reading.t - samples[0].t > windowMs) {
    samples.shift();
  }
  while (samples.length > maxSamples) samples.shift();

  return { samples, etaSeconds: rollingEtaSeconds(samples, reading.total) };
}

/** Seconds remaining from the rolling window, or null when the rate
 * can't be trusted yet: fewer than two points, no forward movement, or a
 * zero-length time span. */
function rollingEtaSeconds(
  samples: ProgressSample[],
  total: number,
): number | null {
  if (!total || samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dProcessed = last.processed - first.processed;
  const dSec = (last.t - first.t) / 1000;
  if (dProcessed <= 0 || dSec <= 0) return null;
  const rate = dProcessed / dSec; // files/sec, measured over the window
  const remaining = Math.max(0, total - last.processed);
  return Math.round(remaining / rate);
}

/** "~6 min left" style formatting for the ETA. */
export function fmtEta(seconds: number | null): string | null {
  if (seconds == null) return null;
  if (seconds < 60) return "under a minute left";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `~${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem ? `~${hours}h ${rem}m left` : `~${hours}h left`;
}
