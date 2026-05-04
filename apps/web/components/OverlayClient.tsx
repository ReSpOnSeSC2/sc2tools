"use client";

import { useEffect, useMemo, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { API_BASE } from "@/lib/clientApi";
import type { LiveGamePayload } from "@/components/overlay/types";
import {
  OpponentWidget,
  MatchResultWidget,
  PostGameWidget,
  MmrDeltaWidget,
  StreakWidget,
  CheeseWidget,
  RematchWidget,
  RivalWidget,
  RankWidget,
  MetaWidget,
  TopBuildsWidget,
  FavOpeningWidget,
  BestAnswerWidget,
  ScoutingWidget,
  SessionWidget,
} from "@/components/overlay/widgets/PrePostFlow";

const ALL_WIDGETS = [
  "opponent",
  "match-result",
  "post-game",
  "mmr-delta",
  "streak",
  "cheese",
  "rematch",
  "rival",
  "rank",
  "meta",
  "topbuilds",
  "fav-opening",
  "best-answer",
  "scouting",
  "session",
] as const;

type WidgetId = (typeof ALL_WIDGETS)[number];

/**
 * Public OBS overlay. The token IS the auth — we trade it for a
 * per-overlay socket subscription. No Clerk session here.
 *
 * Each widget is gated by the user's `enabledWidgets` toggle (settable
 * from /settings → Overlay) so streamers can hide widgets they don't
 * want without scripting OBS visibility per-source.
 *
 * Layout supports two view modes:
 *  - default (`?w=` not set): all enabled widgets render, slot-positioned.
 *  - single-widget (`?w=<id>`): only that one widget renders, top-left.
 *    OBS users can put each widget in its own Browser Source this way
 *    so they can position them independently — same trick the legacy
 *    HTML overlay used.
 */
export function OverlayClient({ token }: { token: string }) {
  const [live, setLive] = useState<LiveGamePayload | null>(null);
  const [enabled, setEnabled] = useState<Set<WidgetId>>(
    () => new Set(ALL_WIDGETS),
  );

  useEffect(() => {
    const socket: Socket = io(API_BASE, {
      auth: { overlayToken: token },
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
    });
    socket.on("overlay:live", (msg: LiveGamePayload) => setLive(msg));
    socket.on("overlay:config", (msg: { enabledWidgets?: string[] }) => {
      if (msg && Array.isArray(msg.enabledWidgets)) {
        setEnabled(new Set(msg.enabledWidgets as WidgetId[]));
      }
    });
    return () => {
      socket.disconnect();
    };
  }, [token]);

  // Single-widget mode (OBS users place each widget in its own
  // Browser Source). Read from URL search param, defaulting to "all".
  const singleWidget = useMemo<WidgetId | null>(() => {
    if (typeof window === "undefined") return null;
    const w = new URLSearchParams(window.location.search).get("w");
    if (!w) return null;
    return ALL_WIDGETS.includes(w as WidgetId) ? (w as WidgetId) : null;
  }, []);

  function shouldShow(id: WidgetId): boolean {
    if (singleWidget && singleWidget !== id) return false;
    return enabled.has(id);
  }

  if (!live) {
    return (
      <div className="flex h-screen items-center justify-center">
        <span className="text-sm text-text-muted">Waiting for next game…</span>
      </div>
    );
  }

  return (
    <div
      className="relative h-screen w-screen"
      style={{ background: "transparent" }}
    >
      {shouldShow("opponent") && <OpponentWidget live={live} />}
      {shouldShow("match-result") && <MatchResultWidget live={live} />}
      {shouldShow("post-game") && <PostGameWidget live={live} />}
      {shouldShow("mmr-delta") && <MmrDeltaWidget live={live} />}
      {shouldShow("streak") && <StreakWidget live={live} />}
      {shouldShow("cheese") && <CheeseWidget live={live} />}
      {shouldShow("rematch") && <RematchWidget live={live} />}
      {shouldShow("rival") && <RivalWidget live={live} />}
      {shouldShow("rank") && <RankWidget live={live} />}
      {shouldShow("meta") && <MetaWidget live={live} />}
      {shouldShow("topbuilds") && <TopBuildsWidget live={live} />}
      {shouldShow("fav-opening") && <FavOpeningWidget live={live} />}
      {shouldShow("best-answer") && <BestAnswerWidget live={live} />}
      {shouldShow("scouting") && <ScoutingWidget live={live} />}
      {shouldShow("session") && <SessionWidget live={live} />}
    </div>
  );
}
