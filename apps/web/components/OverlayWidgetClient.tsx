"use client";

import { useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { API_BASE } from "@/lib/clientApi";
import type { LiveGamePayload } from "@/components/overlay/types";
import { clientTimezone } from "@/lib/timeseries";
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
  type SessionSummary,
} from "@/components/overlay/widgets/PrePostFlow";

type WidgetId =
  | "opponent"
  | "match-result"
  | "post-game"
  | "mmr-delta"
  | "streak"
  | "cheese"
  | "rematch"
  | "rival"
  | "rank"
  | "meta"
  | "topbuilds"
  | "fav-opening"
  | "best-answer"
  | "scouting"
  | "session";

/**
 * Per-widget Browser Source.
 *
 * Architecture mirrors the offline app: one URL per widget, transparent
 * background, sized for the widget's content. The streamer drops each
 * URL they care about into OBS as a separate Browser Source and
 * positions it independently.
 *
 * Each widget connects its own Socket.io subscription to the overlay
 * room. That's a few extra sockets per stream, but each is a long-lived
 * websocket pushing tiny JSON — cheap. Sharing a single socket would
 * require an in-process bus only OBS can't help us with: every Browser
 * Source is a separate Chromium instance.
 *
 * Widgets render at their own dimensions; the page wrapper is just a
 * transparent block container. Slot positioning from the all-in-one
 * overlay is overridden so the widget hugs the top-left of its frame.
 */
export function OverlayWidgetClient({
  token,
  widget,
}: {
  token: string;
  widget: string;
}) {
  const [live, setLive] = useState<LiveGamePayload | null>(null);
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [enabled, setEnabled] = useState<boolean>(true);

  useEffect(() => {
    const socket: Socket = io(API_BASE, {
      // The OBS Browser Source carries no Clerk session; the token IS
      // the auth. We also send the browser's IANA timezone so the
      // server's session-record aggregation anchors "today" to the
      // streamer's wall clock instead of UTC.
      auth: { overlayToken: token, timezone: clientTimezone() },
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
    });
    socket.on("overlay:live", (msg: LiveGamePayload) => setLive(msg));
    socket.on("overlay:config", (msg: { enabledWidgets?: string[] }) => {
      if (msg && Array.isArray(msg.enabledWidgets)) {
        setEnabled(msg.enabledWidgets.includes(widget));
      }
    });
    socket.on("overlay:session", (msg: SessionSummary) => {
      if (msg && typeof msg === "object") setSession(msg);
    });
    return () => {
      socket.disconnect();
    };
  }, [token, widget]);

  if (!enabled) return <div style={{ background: "transparent" }} />;

  // In solo mode, override the WidgetShell's slot positioning so the
  // widget hugs the top-left of its Browser Source frame. The streamer
  // positions the whole frame in OBS — they don't want our slot offsets
  // shifting it down 40px or centring it inside an invisible frame.
  return (
    <div
      style={{
        position: "relative",
        minHeight: "100vh",
        width: "100%",
        background: "transparent",
      }}
      className="overlay-widget-frame"
    >
      <style>{`
        .overlay-widget-frame .widget-shell {
          top: 0 !important;
          left: 0 !important;
          right: auto !important;
          bottom: auto !important;
          transform: none !important;
        }
      `}</style>
      <WidgetRenderer widget={widget as WidgetId} live={live} session={session} />
    </div>
  );
}

function WidgetRenderer({
  widget,
  live,
  session,
}: {
  widget: WidgetId;
  live: LiveGamePayload | null;
  session: SessionSummary | null;
}) {
  switch (widget) {
    case "opponent":
      return <OpponentWidget live={live} />;
    case "match-result":
      return <MatchResultWidget live={live} />;
    case "post-game":
      return <PostGameWidget live={live} />;
    case "mmr-delta":
      return <MmrDeltaWidget live={live} />;
    case "streak":
      return <StreakWidget live={live} />;
    case "cheese":
      return <CheeseWidget live={live} />;
    case "rematch":
      return <RematchWidget live={live} />;
    case "rival":
      return <RivalWidget live={live} />;
    case "rank":
      return <RankWidget live={live} />;
    case "meta":
      return <MetaWidget live={live} />;
    case "topbuilds":
      return <TopBuildsWidget live={live} />;
    case "fav-opening":
      return <FavOpeningWidget live={live} />;
    case "best-answer":
      return <BestAnswerWidget live={live} />;
    case "scouting":
      return <ScoutingWidget live={live} />;
    case "session":
      return <SessionWidget live={live} session={session} />;
    default:
      return null;
  }
}
