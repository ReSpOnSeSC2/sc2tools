"use client";
import Link from "next/link";
import { useOverlayHealth } from "@/components/overlay/OverlayHealthContext";
import { widgetPresence } from "@/lib/overlayPresence";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { WIDGET_GUIDES } from "@/lib/streamStudioLearn";

export function OverlayHealthBoard() {
  const health = useOverlayHealth(); if (!health) return null;
  const { snapshot, loading, error, refresh } = health;
  const stale = !snapshot || !!error || Date.now() - Date.parse(snapshot.sampledAt) > 35_000;
  const count = (id: string) => snapshot?.surfaces[id]?.count ?? 0;
  const game = count("all-in-one") + WIDGET_GUIDES.filter(guide => ["game", "results", "practice"].includes(guide.group)).reduce((total, guide) => total + (snapshot?.widgets[guide.id]?.count ?? 0), 0);
  const chat = snapshot ? widgetPresence(snapshot, "multichat", health.enabledWidgets.includes("multichat")).count : 0;
  const checks = [
    { label: "Agent", ready: snapshot?.agent.online, value: snapshot?.agent.online ? "Connected" : "No connected agent" },
    { label: "Game overlay", ready: game > 0, value: game ? `${game} connected` : count("unknown") ? "Unknown source" : "Not added" },
    { label: "Chat source", ready: chat > 0, value: chat ? `${chat} connected` : count("unknown") ? "Optional · unknown source" : "Optional · not added" },
    { label: "Stream Dock", ready: count("dock") > 0, value: count("dock") ? `${count("dock")} connected` : count("unknown") ? "Optional · unknown source" : "Optional · not open" },
  ];
  return <section aria-label="Overlay health" className="min-w-0 space-y-3 rounded-xl border border-border bg-bg-surface p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-body-lg font-semibold">Ready to go live?</h2><Button variant="secondary" size="sm" onClick={refresh} disabled={loading} className="min-h-11">Refresh sources</Button></div>
    <p className="text-caption text-text-muted">Connections include source pages opened in a browser. A connection does not confirm that a source is visible or audible in OBS.</p>
    {error ? <p role="status" className="text-caption text-warning">Couldn’t refresh source connections. Retry in a few seconds; any counts below are from the previous check.</p> : !snapshot ? <p role="status" className="text-caption text-text-muted">{loading ? "Checking source connections…" : "Source connections have not been checked."}</p> : null}
    <ul className="grid min-w-0 gap-2 sm:grid-cols-2">{checks.map(check => <li key={check.label} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-caption"><span className="font-semibold">{check.label}</span><Badge variant={!stale && check.ready ? "success" : "neutral"}>{snapshot ? check.value : "Unknown"}</Badge></li>)}</ul>
    {snapshot ? <p className="text-caption text-text-muted">Checked <time dateTime={snapshot.sampledAt}>{new Date(snapshot.sampledAt).toLocaleTimeString()}</time>. {stale ? "Refresh to confirm current status. " : ""}{count("unknown") ? `${count("unknown")} unknown source${count("unknown") === 1 ? "" : "s"}; refresh older Browser Sources to identify them. ` : ""}{snapshot.lastLiveAt ? <>Recent game update: <time dateTime={snapshot.lastLiveAt}>{new Date(snapshot.lastLiveAt).toLocaleTimeString()}</time>.</> : "No recent game update is retained. This can be expected before a replay arrives or after the API restarts."}</p> : null}
    <Link href="/help/overlay-health" className="inline-flex min-h-11 items-center text-caption text-accent underline">Check my overlay setup</Link>
  </section>;
}

export function WidgetPresenceBadge({ widget, enabled }: { widget: string; enabled: boolean }) {
  const health = useOverlayHealth(); if (!health) return null;
  if (!health.snapshot || health.error || Date.now() - Date.parse(health.snapshot.sampledAt) > 35_000) return <Badge variant="neutral">Connection unknown</Badge>;
  const state = widgetPresence(health.snapshot, widget, enabled);
  return <div className="my-2 space-y-1"><Badge variant={state.audio ? "warning" : state.count ? "success" : "neutral"}>{state.audio ? `Duplicate audio · ${state.count} sources` : state.count ? `In OBS ×${state.count}` : state.unknown ? "Unknown source" : "Not added"}</Badge>{state.audio ? <p className="text-caption text-warning">Multiple sources can play this audio. Keep only one copy audible.</p> : null}</div>;
}
