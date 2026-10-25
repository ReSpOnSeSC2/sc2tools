"use client";

import { useEffect, useRef, useState } from "react";
import { createOverlaySocket, type OverlayConnectionStatus } from "@/components/overlay/overlayResilience";
import { sanitizeStudioState, type StudioState } from "./useStudioState";
import type { LiveGameEnvelope, LiveGamePayload } from "@/components/overlay/types";
import { mergeLiveGameStreamerHistory, type StickyStreamerHistory } from "@/components/overlay/mergeLiveGameStreamerHistory";
import { newerSession } from "./sessionSnapshot";
export type DockGameStatus = { gameKey: string | null; phase: LiveGameEnvelope["phase"]; isReplay: boolean; verified: boolean };
type StudioLiveFacts = { gameStatus: DockGameStatus | null; engagementEvent: unknown; token: string; liveGame: LiveGameEnvelope | null; lastLiveAt: number | null; session: LiveGamePayload["session"] | null };

/** Timestamp ordering shared by the two manual control surfaces. */
export function newestStudioSnapshot(current: StudioState | null, next: StudioState): StudioState {
  if (!current) return next;
  const currentAt = current.updatedAt ? Date.parse(current.updatedAt) : NaN;
  const nextAt = next.updatedAt ? Date.parse(next.updatedAt) : NaN;
  return Number.isFinite(currentAt) && (!Number.isFinite(nextAt) || nextAt < currentAt)
    ? current
    : next;
}

/**
 * Lightweight token-authenticated studio subscription. Control surfaces keep
 * their existing GET fallback; this connection supplies immediate saved-state
 * updates without reconnecting when drafts or callback identities change.
 */
export function useStudioUpdates(token: string, onUpdate: (state: StudioState) => void, enabled = true, controlOnly = false): { status: OverlayConnectionStatus; liveGame: LiveGameEnvelope | null; lastLiveAt: number | null; session: LiveGamePayload["session"] | null; gameStatus: DockGameStatus | null; engagementEvent: unknown } {
  const [connection, setConnection] = useState<{ token: string; status: OverlayConnectionStatus }>({ token, status: "connecting" });
  const [facts, setFacts] = useState<StudioLiveFacts>({ token, liveGame: null, lastLiveAt: null, session: null, gameStatus: null, engagementEvent: null });
  const callbackRef = useRef({ token, onUpdate });
  callbackRef.current = { token, onUpdate };
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let sticky: StickyStreamerHistory | null = null;
    const current = () => !cancelled && callbackRef.current.token === token;
    const clearFacts = () => {
      sticky = null;
      if (current()) setFacts({ token, liveGame: null, lastLiveAt: null, session: null, gameStatus: null, engagementEvent: null });
    };
    const connection = createOverlaySocket(token, { surface: "dock", auth: controlOnly ? { controlOnly: true } : undefined, onStatus: (status) => setConnection({ token, status }) });
    const socket = connection.socket;
    const receive = (raw: unknown) => {
      // A late callback from the previous token can occur before effect
      // cleanup. Never forward it into the new token's latest callback.
      if (cancelled || callbackRef.current.token !== token || !raw || typeof raw !== "object" || Array.isArray(raw)) return;
      callbackRef.current.onUpdate(sanitizeStudioState(raw));
    };
    socket.on("overlay:multichat", receive);
    const receiveLive = (raw: unknown) => {
      if (!current() || !raw || typeof raw !== "object" || Array.isArray(raw)) return;
      const value = raw as LiveGameEnvelope;
      if (value.type !== "liveGameState" || !["idle", "menu", "match_loading", "match_started", "match_in_progress", "match_ended"].includes(value.phase)) return;
      const active = ["match_loading", "match_started", "match_in_progress"].includes(value.phase) && !value.isReplay;
      const merged = active ? mergeLiveGameStreamerHistory(value, sticky) : null; sticky = merged?.sticky ?? null;
      const gameKey = typeof value.gameKey === "string" && value.gameKey.length <= 120 ? value.gameKey : null;
      setFacts(previous => ({ ...(previous.token === token ? previous : { token, session: null, engagementEvent: null }), liveGame: merged?.envelope ?? null, lastLiveAt: Date.now(),
        gameStatus: { gameKey, phase: value.phase, isReplay: value.isReplay === true, verified: previous.token === token && previous.gameStatus?.gameKey === gameKey && previous.gameStatus.verified === true } }));
    };
    const receiveSession = (raw: unknown) => {
      if (!current() || !raw || typeof raw !== "object" || Array.isArray(raw)) return;
      const value = raw as NonNullable<LiveGamePayload["session"]>;
      if (![value.wins, value.losses, value.games].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 100_000)) return;
      const session: NonNullable<LiveGamePayload["session"]> = { wins: value.wins, losses: value.losses, games: value.games };
      for (const key of ["mmrStart", "mmrCurrent"] as const) if (typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] > 0 && value[key] < 100_000) session[key] = value[key];
      if (value.streak && ["win", "loss"].includes(value.streak.kind) && Number.isSafeInteger(value.streak.count) && value.streak.count > 0) session.streak = { kind: value.streak.kind, count: Math.min(value.streak.count, 100_000) };
      if (typeof value.sessionStartedAt === "string" && Number.isFinite(Date.parse(value.sessionStartedAt))) session.sessionStartedAt = value.sessionStartedAt;
      if (typeof value.sessionAnchorAt === "string" && Number.isFinite(Date.parse(value.sessionAnchorAt))) session.sessionAnchorAt = value.sessionAnchorAt;
      setFacts(previous => ({ ...(previous.token === token ? previous : { token, liveGame: null, lastLiveAt: null, gameStatus: null, engagementEvent: null }), session: newerSession(previous.token === token ? previous.session ?? null : null, session) }));
    };
    const receiveVerified = (raw: unknown) => {
      if (!current() || !raw || typeof raw !== "object" || Array.isArray(raw)) return;
      const value = raw as Record<string, unknown>;
      if (!["win", "loss"].includes(String(value.result)) || typeof value.gameKey !== "string") return;
      setFacts(previous => previous.token === token && previous.gameStatus && previous.gameStatus.gameKey === value.gameKey
        ? { ...previous, gameStatus: { ...previous.gameStatus, verified: true } } : previous);
    };
    const receiveEngagement = (raw: unknown) => {
      if (current() && raw && typeof raw === "object" && !Array.isArray(raw)) setFacts(previous => previous.token === token ? { ...previous, engagementEvent: raw } : previous);
    };
    socket.on("overlay:live", receiveVerified);
    socket.on("overlay:engagement", receiveEngagement);
    const outgoing = (event: string) => { if (event === "overlay:resync") clearFacts(); };
    socket.on("overlay:liveGame", receiveLive);
    socket.on("overlay:session", receiveSession);
    socket.on("connect", clearFacts);
    socket.on("disconnect", clearFacts);
    socket.onAnyOutgoing?.(outgoing);
    return () => {
      cancelled = true;
      socket.off("overlay:multichat", receive);
      socket.off("overlay:live", receiveVerified); socket.off("overlay:engagement", receiveEngagement);
      socket.off("overlay:liveGame", receiveLive); socket.off("overlay:session", receiveSession);
      socket.off("connect", clearFacts); socket.off("disconnect", clearFacts);
      socket.offAnyOutgoing?.(outgoing);
      connection.dispose();
    };
  }, [token, enabled, controlOnly]);
  return { status: connection.token === token ? connection.status : "connecting",
    liveGame: enabled && facts.token === token ? facts.liveGame : null,
    lastLiveAt: enabled && facts.token === token ? facts.lastLiveAt : null,
    session: enabled && facts.token === token ? facts.session : null,
    gameStatus: enabled && facts.token === token ? facts.gameStatus : null,
    engagementEvent: enabled && facts.token === token ? facts.engagementEvent : null };
}
