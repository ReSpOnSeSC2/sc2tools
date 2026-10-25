"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LiveGameEnvelope, LiveGamePayload } from "@/components/overlay/types";
import { projectDockScouting } from "@/lib/liveScouting";
import { formatCountdown } from "@/lib/multichat/countdown";
import { STUDIO_SCENE_LABELS } from "@/lib/multichat/sceneModes";
import type { StudioState } from "@/lib/multichat/useStudioState";
import { DockPresenceStrip } from "./DockPresenceStrip";

export function sessionRecord(session: LiveGamePayload["session"] | null) {
  if (!session) return "Session not checked yet";
  const delta = typeof session.mmrStart === "number" && typeof session.mmrCurrent === "number" ? session.mmrCurrent - session.mmrStart : null;
  return `${session.wins}W–${session.losses}L${delta !== null ? ` · ${delta > 0 ? "+" : ""}${delta} MMR` : " · MMR change unavailable"}`;
}

/** Sticky at every scroll position. Opponent data uses the same public allowlist
 * as Scout; counts have no connection identities or private diagnostic details. */
export function DockStatusHeader({ token, studio, ready, live, lastLiveAt, session, status, onHeight, children }: {
  token: string; studio: StudioState; ready: boolean; live: LiveGameEnvelope | null;
  lastLiveAt: number | null; session: LiveGamePayload["session"] | null; status: string;
  onHeight: (height: number) => void; children: ReactNode;
}) {
  const host = useRef<HTMLElement>(null), [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const node = host.current; if (!node) return;
    const measure = () => onHeight(Math.ceil(node.getBoundingClientRect().height));
    measure(); if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure); observer.observe(node); return () => observer.disconnect();
  }, [onHeight]);
  const received = typeof live?.receivedAt === "number" ? live.receivedAt : lastLiveAt;
  const opponent = projectDockScouting(received !== null && now - received <= 30_000 ? live : null);
  const remaining = studio.scene?.countdownEndsAt ? Math.max(0, studio.scene.countdownEndsAt - now) : null;
  const scene = !ready ? "Loading scene…" : studio.scene ? `${STUDIO_SCENE_LABELS[studio.scene.mode]}${remaining !== null ? ` ${formatCountdown(remaining)}` : ""}` : "Live";
  const race = ({ P: "protoss", T: "terran", Z: "zerg", R: "random" } as Record<string, string>)[opponent?.race?.[0]?.toUpperCase() ?? ""] ?? "random";
  return <header ref={host} data-dock-status-header className="sticky top-0 z-20 -mx-2 mb-2 space-y-1 border-b border-border bg-bg px-2 pt-1">
    <h1 className="sr-only">Stream Dock</h1>
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-caption">
      <span className="rounded border border-border px-1.5 py-0.5 font-semibold">{scene}</span>
      <span>{sessionRecord(session)}</span>
      <span role="status" className="text-text">{status === "connected" ? "Connected" : "Reconnecting…"}</span>
      {studio.gameWidgetsPaused ? <span className="text-text">Game widgets hidden</span> : null}
    </div>
    {opponent ? <p aria-label="Current opponent" className="min-w-0 break-words text-caption">
      {/* Existing four static race assets; avoid loading the unit icon registry in the header. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/icons/sc2/races/${race}.svg`} alt="" aria-hidden width={18} height={18} className="mr-1 inline-block align-middle" />
      <strong>{opponent.name || "Identifying opponent…"}</strong> · {opponent.race}{opponent.mmr !== null ? ` · ${opponent.mmr} MMR` : ""}{opponent.h2h ? ` · H2H ${opponent.h2h.wins}W–${opponent.h2h.losses}L` : ""}</p> : null}
    <DockPresenceStrip token={token} />
    {children}
  </header>;
}
