"use client";

import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { useApi } from "@/lib/clientApi";
import { SYNC_HEALTH_SETTINGS_HREF, syncHealthItems, syncHealthStatus, type SyncHealthResponse } from "@/lib/syncHealth";

const DOT = { error: "bg-danger", warn: "bg-warning", info: "border border-text-dim", ok: "bg-success" } as const;
const SHOWN = 3;

/**
 * The agent pill's sync-health lines. AgentSyncPill loads this only when its
 * details open, so the pill adds no code or request to the pages it sits on.
 * Count-only: no player name, toon handle or PC name.
 */
export function SyncHealthSummary({ onNavigate }: { onNavigate: () => void }) {
  const health = useApi<SyncHealthResponse>("/v1/me/sync-health", { revalidateOnFocus: false, revalidateOnReconnect: false });
  if (health.error && !health.data) {
    return <p className="flex flex-wrap items-center gap-2 text-text-muted">Couldn&apos;t check sync health.
      <Button variant="ghost" size="sm" onClick={() => { void health.mutate(); }}>Retry</Button></p>;
  }
  if (!health.data) return <p role="status" className="text-text-muted">Checking sync health…</p>;
  const items = syncHealthItems(health.data);
  const status = syncHealthStatus(health.data, items);
  return <div className="space-y-1">
    <p className="font-semibold">Sync health: {status.title}</p>
    {status.sentence ? <p className="text-text-muted">{status.sentence}</p> : null}
    {items.length ? <ul className="space-y-1">{items.slice(0, SHOWN).map((item) => <li key={item.key} className="flex items-start gap-2">
      <span aria-hidden className={`mt-1.5 inline-flex h-2 w-2 shrink-0 rounded-full ${DOT[item.tone]}`} />
      <span className="min-w-0"><span className="font-semibold">{item.title}.</span> {item.sentence}</span>
    </li>)}</ul> : null}
    {items.length > SHOWN ? <p className="text-text-muted">{items.length - SHOWN} more in Sync health.</p> : null}
    <Link href={SYNC_HEALTH_SETTINGS_HREF} onClick={onNavigate} className="inline-flex min-h-11 items-center font-semibold text-accent-cyan underline underline-offset-2">Open Sync health</Link>
  </div>;
}
