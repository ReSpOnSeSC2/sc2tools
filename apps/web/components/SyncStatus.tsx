"use client";

import { Component, lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useApi } from "@/lib/clientApi";
import { agentPresence } from "@/lib/agentPresence";
import { useRealtimeEvents, useRealtimeState } from "@/components/realtime/RealtimeProvider";
import { gamesChanged } from "@/lib/realtime/gamesRefresh";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { Popover } from "@/components/ui/Popover";

// Sync health loads, and reads /v1/me/sync-health, only when the details
// open: the pill is on every page, and its status text stays /v1/me's.
const SyncHealthSummary = lazy(() => import("./SyncHealthSummary").then((mod) => ({ default: mod.SyncHealthSummary })));

type Me = { agentPaired?: boolean; agentLastSeenAt?: string | null; games?: { total: number; latest: string | null } };
// Legacy props remain accepted by the SyncStatus alias. /v1/me is authoritative.
type Props = { compact?: boolean; total?: number; latest?: string | null; userId?: string };
const CONNECTION = { connected: "Connected", connecting: "Connecting…", reconnecting: "Reconnecting", offline: "Offline" };
export function AgentSyncPill({ compact = false }: Props = {}) {
  const { data: me, error, mutate } = useApi<Me>("/v1/me", { refreshInterval: 60_000 });
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null); const id = useId();
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  const immediate = useMemo(() => ({ "games:changed": (payload: unknown) => {
    const value = gamesChanged(payload);
    if (value.inserted > 0) void mutate((current) => {
      const known = current ?? me;
      // /me.games.latest is the played time, not when a replay was imported.
      return known?.games ? { ...known, games: { ...known.games, total: known.games.total + value.inserted } } : known;
    }, { revalidate: false });
  } }), [mutate, me]);
  const coalesced = useMemo(() => ({ "games:changed": (payload: unknown) => { if (gamesChanged(payload).inserted > 0) void mutate(); }, connect: () => { void mutate(); } }), [mutate]);
  const realtime = useRealtimeState(immediate, true);
  useRealtimeEvents(coalesced);
  if (!me) return error ? <p className="text-caption text-text-muted">Desktop app status unavailable <button type="button" className="underline" onClick={() => { void mutate(); }}>Retry</button></p> : <span role="status" aria-label="Loading desktop app status" className="inline-block h-5 w-40 rounded-full bg-bg-elevated motion-safe:animate-pulse" />;
  const online = me.agentPaired && agentPresence(me.agentLastSeenAt, now) === "online";
  const total = typeof me.games?.total === "number" && Number.isFinite(me.games.total) ? new Intl.NumberFormat("en-US").format(me.games.total) : "—";
  const latestGame = me.games?.latest;
  const gameTimeText = latestGame ? formatRelative(latestGame, now) : me.games?.total === 0 ? "none yet" : "unavailable";
  const presence = !me.agentPaired ? "No desktop app linked" : online ? "Agent online" : "Agent offline";
  const sentence = !me.agentPaired ? presence : online ? `${presence} · ${total} games · latest game ${gameTimeText}` : `${presence} · last seen ${me.agentLastSeenAt ? formatRelative(me.agentLastSeenAt, now) : "unavailable"}`;
  const tone = !me.agentPaired ? "text-text-muted" : online ? "text-success" : "text-warning";
  const close = () => setOpen(false);
  return <div className="relative flex min-w-0 flex-wrap items-center gap-2 text-caption">
    <button ref={button} type="button" aria-label={sentence} aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)} className={`inline-flex min-h-9 max-w-full items-center gap-2 rounded-full px-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${compact ? "text-caption" : "border border-border bg-bg-elevated"}`}>
      <span aria-hidden className={`inline-flex h-2 w-2 shrink-0 rounded-full ${!me.agentPaired ? "border border-text-dim" : online ? "bg-success" : "bg-warning"}`} />
      <span aria-hidden className={`${tone} hidden sm:inline`} title={absoluteTime(latestGame)}>{sentence}</span>
      <span aria-hidden className="font-mono text-text sm:hidden">{total} games</span><span className="sr-only sm:hidden">{sentence}</span>
    </button>
    {!me.agentPaired || !online ? <Link href="/devices" className="hidden min-h-9 items-center text-accent-cyan underline underline-offset-2 sm:inline-flex">{me.agentPaired ? "Open Devices" : "Link your PC"}</Link> : null}
    {/* The shared nonmodal Popover: Escape and outside clicks close it, and a help sheet opened inside stays on top of it. */}
    <Popover open={open} onClose={close} anchorRef={button} label="Desktop app details" id={id} className="space-y-2 text-caption">
      <p className={`font-semibold ${tone}`}>{presence}</p><dl className="space-y-1"><div><dt className="inline text-text-muted">Last seen: </dt><dd className="inline">{absoluteTime(me.agentLastSeenAt) ?? "Unavailable"}</dd></div><div><dt className="inline text-text-muted">Total games: </dt><dd className="inline">{total}</dd></div><div><dt className="inline text-text-muted">Latest game: </dt><dd className="inline">{absoluteTime(latestGame) ? `${absoluteTime(latestGame)} · ${gameTimeText}` : gameTimeText}</dd></div></dl>
      <p className="text-text-muted">Realtime updates: {CONNECTION[realtime.status]}</p>
      <div className="border-t border-border pt-2"><SyncHealthBoundary><Suspense fallback={<p role="status" className="text-text-muted">Checking sync health…</p>}><SyncHealthSummary onNavigate={close} /></Suspense></SyncHealthBoundary></div>
      <Link href="/devices" onClick={close} className="inline-flex min-h-11 items-center font-semibold text-accent-cyan underline underline-offset-2">Open Devices</Link>
      <p className="flex flex-wrap gap-x-3 gap-y-1"><LazyHelpLink slug="desktop-app-status">What the status lights mean</LazyHelpLink><LazyHelpLink slug="my-game-didnt-show-up">Why didn&apos;t my game show up?</LazyHelpLink></p>
    </Popover>
    {realtime.bulk ? <span role="status" className="sr-only">Syncing — charts refresh every 30 s</span> : null}
  </div>;
}
export const SyncStatus = AgentSyncPill;
/** A summary chunk that fails to load leaves the rest of the details usable. */
class SyncHealthBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p className="text-text-muted">Sync health couldn&apos;t load. Reload the page to try again.</p> : this.props.children; }
}
export function absoluteTime(value: string | null | undefined): string | undefined {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : undefined;
}
export function formatRelative(iso: string, now: number): string {
  const time = Date.parse(iso); if (!Number.isFinite(time)) return "unavailable";
  const sec = Math.max(0, (now - time) / 1000);
  if (sec < 90) return `${Math.round(sec)}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} h ago`;
  return `${Math.floor(sec / 86400)} d ago`;
}
