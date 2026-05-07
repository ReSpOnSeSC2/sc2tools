"use client";

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { API_BASE } from "@/lib/clientApi";
import type { LiveGamePayload } from "@/components/overlay/types";
import { clientTimezone } from "@/lib/timeseries";
import {
  resolveWidgetDurationMs,
  type WidgetId,
} from "@/components/overlay/widgetLifecycle";
import {
  useVoiceReadout,
  type VoicePrefs,
} from "@/components/overlay/useVoiceReadout";
import { VoiceGestureBanner } from "@/components/overlay/VoiceGestureBanner";
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
 * Visibility lifecycle is driven by `widgetLifecycle.ts`:
 *
 *  - Most widgets auto-hide after their natural per-widget duration
 *    (15s for match-result, 22s for scouting, etc.) so the streamer's
 *    scene clears between games.
 *  - `session` and `topbuilds` are persistent HUDs in production.
 *  - Test fires (`isTest: true` on the payload) cap every widget at
 *    `TEST_DURATION_MS` so the persistent panels don't sit on the
 *    scene forever after a Test click.
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
  const [visible, setVisible] = useState<boolean>(false);
  const [voicePrefs, setVoicePrefs] = useState<VoicePrefs | null>(null);

  useOverlayWidgetSocket(
    token,
    widget,
    setLive,
    setSession,
    setEnabled,
    setVoicePrefs,
  );
  useWidgetVisibility(widget as WidgetId, live, session, setVisible);

  // Voice readout is only run from the scouting widget when each
  // widget is its own Browser Source — otherwise every Source would
  // race to speak the same payload and the streamer would hear the
  // line two or three times. The all-in-one overlay (OverlayClient)
  // owns voice for that mode. Mirrors the legacy
  // `voice-readout.js` which was only included from scouting.html.
  const enableVoiceHere = widget === "scouting";
  const voice = useVoiceReadout(
    enableVoiceHere ? live : null,
    enableVoiceHere ? voicePrefs : null,
  );

  if (!enabled || !visible) {
    return (
      <>
        <div style={{ background: "transparent" }} />
        {voice.needsGesture ? (
          <VoiceGestureBanner onClick={voice.onUserGesture} />
        ) : null}
      </>
    );
  }

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
      {voice.needsGesture ? (
        <VoiceGestureBanner onClick={voice.onUserGesture} />
      ) : null}
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

/**
 * Subscribe to the overlay socket scoped to one widget id. The
 * configured-widgets event is filtered down to a single boolean so
 * the caller can short-circuit rendering when the streamer disables
 * this specific panel.
 */
function useOverlayWidgetSocket(
  token: string,
  widget: string,
  setLive: (msg: LiveGamePayload | null) => void,
  setSession: (msg: SessionSummary | null) => void,
  setEnabled: (on: boolean) => void,
  setVoicePrefs: (prefs: VoicePrefs | null) => void,
) {
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
    socket.on(
      "overlay:config",
      (msg: { enabledWidgets?: string[]; voicePrefs?: VoicePrefs }) => {
        if (msg && Array.isArray(msg.enabledWidgets)) {
          setEnabled(msg.enabledWidgets.includes(widget));
        }
        if (msg && msg.voicePrefs && typeof msg.voicePrefs === "object") {
          setVoicePrefs(msg.voicePrefs);
        }
      },
    );
    socket.on("overlay:session", (msg: SessionSummary) => {
      if (msg && typeof msg === "object") setSession(msg);
    });
    // Streamer cancelled the test fire — clear local state so the
    // widget vanishes immediately instead of waiting for the natural
    // visibility timer to expire. ``msg.widget`` narrows the clear to
    // a single widget id; null clears every panel on this token.
    socket.on(
      "overlay:clear",
      (msg: { widget?: string | null } | undefined) => {
        const target = msg?.widget;
        if (!target || target === widget) {
          if (widget === "session") {
            setSession(null);
          } else {
            setLive(null);
          }
        }
      },
    );
    return () => {
      socket.disconnect();
    };
  }, [token, widget, setLive, setSession, setEnabled, setVoicePrefs]);
}

/**
 * Re-arm the widget's auto-hide timer every time a fresh payload
 * arrives. The payload feed differs per widget — `session` reads from
 * the dedicated `overlay:session` event, every other widget reads
 * from the merged `overlay:live` payload — and each payload's
 * `isTest` flag picks production vs. test durations.
 */
function useWidgetVisibility(
  widget: WidgetId,
  live: LiveGamePayload | null,
  session: SessionSummary | null,
  setVisible: (visible: boolean) => void,
) {
  const timerRef = useRef<number | null>(null);
  const sourceForWidget = widget === "session" ? session : live;
  const isTest = Boolean(
    widget === "session" ? session?.isTest : live?.isTest,
  );

  useEffect(() => {
    // Source cleared (e.g. after the streamer cancelled a Test fire) —
    // hide immediately and drop the pending visibility timer so a
    // stale tick can't flip the widget back on.
    if (!sourceForWidget) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setVisible(false);
      return;
    }
    setVisible(true);
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const duration = resolveWidgetDurationMs(widget, isTest);
    if (duration === null) return;
    timerRef.current = window.setTimeout(() => {
      setVisible(false);
      timerRef.current = null;
    }, duration);
  }, [widget, sourceForWidget, isTest, setVisible]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    },
    [],
  );
}
