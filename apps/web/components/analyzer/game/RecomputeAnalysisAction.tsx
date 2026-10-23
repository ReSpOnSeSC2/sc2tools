"use client";

import { useEffect, useState } from "react";
import { RefreshCcw } from "lucide-react";
import { useApi } from "@/lib/clientApi";
import { agentPresence } from "@/lib/agentPresence";
import { Button } from "@/components/ui/Button";

import { RECOMPUTE_ANALYSIS_HINT } from "@/lib/analysisRecompute";

export function useRecomputeAvailability(gameId: string | null) {
  const me = useApi<{ agentLastSeenAt?: string | null }>(gameId ? "/v1/me" : null, { refreshInterval: 60_000, revalidateOnFocus: true });
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!gameId) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [gameId]);
  if (me.error) return "Desktop connection could not be checked. Retry when the connection is available.";
  if (!me.data) return "Checking the desktop connection…";
  return agentPresence(me.data.agentLastSeenAt, now) === "online" ? null : "Open your paired SC2 Tools desktop app to recompute this replay.";
}

export function RecomputeAnalysisAction({ onRecompute, busy, disabledReason, message }: { onRecompute: () => void; busy: boolean; disabledReason?: string | null; message?: string | null }) {
  return <span className="inline-flex max-w-full flex-wrap items-center gap-2">
    <Button variant="secondary" size="sm" onClick={onRecompute} loading={busy} disabled={busy || Boolean(disabledReason)} title={disabledReason || RECOMPUTE_ANALYSIS_HINT} iconLeft={<RefreshCcw className="h-4 w-4" aria-hidden />}>Recompute analysis</Button>
    {disabledReason ? <span className="max-w-xs text-micro font-normal normal-case tracking-normal text-text-muted">{disabledReason}</span> : null}
    {message ? <span role="status" className="max-w-sm text-micro font-normal normal-case tracking-normal text-text-muted">{message}</span> : null}
  </span>;
}
