"use client";

import Link from "next/link";
import { useApi } from "@/lib/clientApi";
import { agentPresence } from "@/lib/agentPresence";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import type { MacroBackfill } from "./useMacroBackfill";

export function MacroEmptyState({ backfill }: { backfill: MacroBackfill }) {
  // The application's existing heartbeat resource is deduplicated by useApi.
  const me = useApi<{ agentLastSeenAt?: string | null }>("/v1/me", { refreshInterval: 60_000 });
  const online = agentPresence(me.data?.agentLastSeenAt, Date.now()) === "online";
  return <Card><EmptyStatePanel title="No macro scores yet" description="Score older synced replays with your paired desktop app, or upload a new replay with a macro breakdown."
    action={backfill.running ? <p role="status">Scoring older games: {backfill.job?.done ?? 0}/{backfill.job?.total ?? "…"}</p> : online
      ? <Button variant="secondary" onClick={backfill.start} disabled={backfill.starting}>Score my older games</Button>
      : <Link href="/download" className="inline-flex min-h-11 items-center rounded-md border border-border px-4 text-caption font-semibold text-accent">Get the desktop app</Link>} />
    {backfill.error ? <p role="alert" className="text-caption text-danger">{backfill.error}</p> : null}
  </Card>;
}
