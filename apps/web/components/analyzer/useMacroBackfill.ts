"use client";

import { useCallback, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi } from "@/lib/clientApi";

type BackfillJob = { status?: string; total?: number; done?: number; errors?: number };
export type MacroBackfill = { starting: boolean; running: boolean; error: string | null; job?: BackfillJob; start: () => Promise<void> };

/** One existing action and one active-job poll shared by the summary and
 * empty state. An idle Macro tab never polls a nonexistent backfill job. */
export function useMacroBackfill(onComplete: () => void): MacroBackfill {
  const { getToken } = useAuth();
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const { data: job } = useApi<BackfillJob>(jobId ? `/v1/macro/backfill/status?jobId=${encodeURIComponent(jobId)}` : null, {
    refreshInterval: (latest?: BackfillJob) => latest && latest.status !== "done" ? 4000 : 0,
    onSuccess: (latest: BackfillJob) => { if (latest?.status === "done") onComplete(); },
  });
  const start = useCallback(async () => {
    if (starting || jobId && job?.status !== "done") return;
    setStarting(true); setError(null);
    try {
      const result = await apiCall<{ jobId: string }>(getToken, "/v1/macro/backfill/start", { method: "POST", body: JSON.stringify({ reason: "macro_tab_backfill" }) });
      setJobId(result.jobId);
    } catch (error) { setError((error as { message?: string }).message || "Couldn't start the backfill."); }
    finally { setStarting(false); }
  }, [getToken, starting, jobId, job?.status]);
  return { starting, running: !!jobId && job?.status !== "done", error, job, start };
}
