"use client";

import { useEffect, useState } from "react";
import { useRealtimeStatus } from "@/components/realtime/RealtimeProvider";
import { Button } from "@/components/ui/Button";

/** REST remains authoritative, including while the shared socket is offline. */
export function AdminLiveStatus({ onRefresh, data }: { onRefresh: () => unknown; data: unknown }) {
  const { status, lastConnectedAt } = useRealtimeStatus();
  const [updatedAt, setUpdatedAt] = useState<number | null>(() => data ? Date.now() : null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (data) setUpdatedAt(Date.now()); }, [data]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const age = updatedAt ?? lastConnectedAt;
  const label = status === "connected" ? "● Live"
    : status === "connecting" || status === "reconnecting" ? "↻ Reconnecting…"
      : `Offline · ${age == null ? "not updated yet" : `updated ${Math.max(0, Math.floor((now - age) / 1000))}s ago`}`;
  return <span className="inline-flex flex-wrap items-center gap-2 text-caption text-text-muted">
    <span role="status" aria-live="polite" title={age == null ? undefined : new Date(age).toLocaleString()}>{label}</span>
    {status !== "connected" ? <Button variant="secondary" size="sm" onClick={onRefresh}>Refresh</Button> : null}
  </span>;
}
