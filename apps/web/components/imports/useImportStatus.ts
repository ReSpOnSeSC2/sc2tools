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
  status: "pending" | "scanning" | "running" | "done" | "cancelled" | "error" | "idle" | string;
  phase: string | null;
  folder: string | null;
  total: number;
  completed: number;
  errors: number;
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
  rejected_by_server: "The server rejected the upload.",
  file_unstable: "The file never finished writing (cloud-sync lag?).",
  analyzer_unavailable: "The agent's parser couldn't load — restart the agent.",
};

export type ImportStatusState = {
  /** Latest job (any status), or null before the first job ever. */
  job: ImportJob | null;
  /** True while a job is scanning/running. */
  active: boolean;
  /** 0–100, counting errors as processed so the bar always finishes. */
  pct: number;
  /** Seconds remaining, null until the rate stabilises (≥20 files). */
  etaSeconds: number | null;
  isLoading: boolean;
  refresh: () => void;
};

const ACTIVE_STATUSES = new Set(["scanning", "running", "pending"]);

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
    refreshInterval: (latest?: StatusResp) =>
      latest && ACTIVE_STATUSES.has(String(latest.status)) ? 5000 : 0,
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
        // A progress event for a NEW job (agent auto-backfill) — pull
        // the full doc so kind/startedAt are right.
        if (p.jobId && p.jobId !== jobIdRef.current) {
          void mutate();
        }
        setLive((prev) => ({ ...(prev || {}), ...p }));
        if ((p as { done?: boolean }).done) void mutate();
      },
    }),
    [mutate],
  );
  useUserSocket(handlers);

  const job = useMemo<ImportJob | null>(() => {
    if (!data || !data.jobId) return null;
    const merged = { ...data, ...(live || {}) } as ImportJob;
    // The socket payload mirrors reportProgress's $set fields; `done`
    // arrives as a flag rather than a status.
    if ((live as { done?: boolean } | null)?.done) merged.status = "done";
    return merged;
  }, [data, live]);

  const active = !!job && ACTIVE_STATUSES.has(String(job.status));

  const pct = useMemo(() => {
    if (!job || !job.total) return 0;
    const processed = (job.completed || 0) + (job.errors || 0);
    return Math.max(0, Math.min(100, Math.round((processed / job.total) * 100)));
  }, [job]);

  const etaSeconds = useMemo(() => {
    if (!job || !active || !job.startedAt || !job.total) return null;
    const processed = (job.completed || 0) + (job.errors || 0);
    if (processed < 20) return null; // rate too noisy to promise an ETA
    const elapsedSec = (Date.now() - new Date(job.startedAt).getTime()) / 1000;
    if (elapsedSec <= 0) return null;
    const rate = processed / elapsedSec;
    if (rate <= 0) return null;
    const remaining = Math.max(0, job.total - processed);
    return Math.round(remaining / rate);
  }, [job, active]);

  return {
    job,
    active,
    pct,
    etaSeconds,
    isLoading,
    refresh: () => void mutate(),
  };
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
