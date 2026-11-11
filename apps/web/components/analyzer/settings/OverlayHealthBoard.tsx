"use client";
import Link from "next/link";
import { useOverlayHealth } from "@/components/overlay/OverlayHealthContext";
import { widgetPresence } from "@/lib/overlayPresence";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { StreamReadinessChecks } from "@/components/stream-studio/StreamReadinessChecks";
import type { StreamToken } from "@/lib/streamReadiness";
import { useStreamReadiness } from "@/lib/useStreamReadiness";

export function OverlayHealthBoard({ token }: { token: StreamToken }) {
  const health = useOverlayHealth();
  const { checks, retry } = useStreamReadiness(health?.active === true, {
    token, snapshot: health?.snapshot ?? null, failed: !!health?.error, refresh: () => health?.refresh(),
  });
  if (!health) return null;
  const { snapshot, loading, error, refresh } = health;
  const stale = !snapshot || !!error || Date.now() - Date.parse(snapshot.sampledAt) > 35_000;
  const unknown = snapshot?.surfaces.unknown?.count ?? 0;
  return <section aria-label="Overlay health" className="min-w-0 space-y-3 rounded-xl border border-border bg-bg-surface p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-body-lg font-semibold">Ready to go live?</h2><Button variant="secondary" size="sm" onClick={refresh} disabled={loading} className="min-h-11">Refresh sources</Button></div>
    <p className="text-caption text-text-muted">Connections include source pages opened in a browser. A connection does not confirm that a source is visible or audible in OBS.</p>
    {error ? <p role="status" className="text-caption text-warning">Couldn’t refresh source connections. Retry in a few seconds; any counts below are from the previous check.</p> : !snapshot ? <p role="status" className="text-caption text-text-muted">{loading ? "Checking source connections…" : "Source connections have not been checked."}</p> : null}
    <StreamReadinessChecks checks={checks} retry={retry} />
    {snapshot ? <p className="text-caption text-text-muted">Checked <time dateTime={snapshot.sampledAt}>{new Date(snapshot.sampledAt).toLocaleTimeString()}</time>. {stale ? "Refresh to confirm current status. " : ""}{unknown ? `${unknown} unknown source${unknown === 1 ? "" : "s"}; refresh older Browser Sources to identify them. ` : ""}{snapshot.lastLiveAt ? <>Recent game update: <time dateTime={snapshot.lastLiveAt}>{new Date(snapshot.lastLiveAt).toLocaleTimeString()}</time>.</> : "No recent game update is retained. This can be expected before a replay arrives or after the API restarts."}</p> : null}
    <Link href="/help/overlay-health" className="inline-flex min-h-11 items-center text-caption text-accent underline">Check my overlay setup</Link>
  </section>;
}

export function WidgetPresenceBadge({ widget, enabled }: { widget: string; enabled: boolean }) {
  const health = useOverlayHealth(); if (!health) return null;
  if (!health.snapshot || health.error || Date.now() - Date.parse(health.snapshot.sampledAt) > 35_000) return <Badge variant="neutral">Connection unknown</Badge>;
  const state = widgetPresence(health.snapshot, widget, enabled);
  return <div className="my-2 space-y-1"><Badge variant={state.audio ? "warning" : state.count ? "success" : "neutral"}>{state.audio ? `Duplicate audio · ${state.count} sources` : state.count ? `In OBS ×${state.count}` : state.unknown ? "Unknown source" : "Not added"}</Badge>{state.audio ? <p className="text-caption text-warning">Multiple sources can play this audio. Keep only one copy audible.</p> : null}</div>;
}
