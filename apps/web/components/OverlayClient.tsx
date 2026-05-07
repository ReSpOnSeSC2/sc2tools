"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { API_BASE } from "@/lib/clientApi";
import type { LiveGamePayload } from "@/components/overlay/types";
import { clientTimezone } from "@/lib/timeseries";
import {
  ALL_WIDGETS,
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
 * Public OBS overlay (all-in-one). The token IS the auth — we trade
 * it for a per-overlay socket subscription. No Clerk session here.
 *
 * Widget visibility is managed per-widget through `widgetLifecycle.ts`:
 *
 *  - Most widgets are "event chips" that auto-hide after their natural
 *    duration (15s for match-result, 22s for scouting, 8s for streak,
 *    etc.) so the streamer's scene stays clean between games.
 *  - `session` and `topbuilds` are persistent HUDs that stay on screen
 *    indefinitely.
 *  - Test fires (`isTest: true` on the payload) cap every widget at
 *    `TEST_DURATION_MS` so a Test click never pins sample data to the
 *    scene.
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
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [enabled, setEnabled] = useState<Set<WidgetId>>(
    () => new Set(ALL_WIDGETS),
  );
  const [voicePrefs, setVoicePrefs] = useState<VoicePrefs | null>(null);
  // Per-widget "currently visible" set. Cleared by the per-widget
  // timeouts scheduled in `useWidgetTimers`.
  const [visibleLive, setVisibleLive] = useState<Set<WidgetId>>(new Set());
  const [sessionVisible, setSessionVisible] = useState<boolean>(false);

  // Stable callback so the socket effect doesn't reconnect on every
  // render. State setters from useState are reference-stable, so this
  // closure has no dependencies that need tracking.
  const onClear = useCallback(() => {
    setLive(null);
    setSession(null);
    setVisibleLive(new Set());
    setSessionVisible(false);
  }, []);

  useOverlaySocket(
    token,
    setLive,
    setSession,
    setEnabled,
    setVoicePrefs,
    onClear,
  );

  useWidgetTimers({
    live,
    session,
    setVisibleLive,
    setSessionVisible,
  });

  const voice = useVoiceReadout(live, voicePrefs);

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
    if (!enabled.has(id)) return false;
    if (id === "session") return sessionVisible;
    return visibleLive.has(id);
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
      {shouldShow("session") && (
        <SessionWidget live={live} session={session} />
      )}
      {voice.needsGesture ? (
        <VoiceGestureBanner onClick={voice.onUserGesture} />
      ) : null}
    </div>
  );
}

/**
 * Subscribe to the overlay socket and push the three event streams
 * into the supplied React state setters. The setters are guaranteed
 * stable by React, so the effect's dependency on them never causes a
 * reconnect.
 */
function useOverlaySocket(
  token: string,
  setLive: (msg: LiveGamePayload | null) => void,
  setSession: (msg: SessionSummary | null) => void,
  setEnabled: (next: Set<WidgetId>) => void,
  setVoicePrefs: (prefs: VoicePrefs | null) => void,
  onClear: () => void,
) {
  useEffect(() => {
    const socket: Socket = io(API_BASE, {
      // The OBS Browser Source has no Clerk session — the token IS the
      // auth. We also pass the browser's IANA timezone so the server's
      // session aggregate aligns to the streamer's wall-clock "today",
      // not UTC.
      auth: { overlayToken: token, timezone: clientTimezone() },
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
    });
    socket.on("overlay:live", (msg: LiveGamePayload) => setLive(msg));
    socket.on("overlay:session", (msg: SessionSummary) => {
      if (msg && typeof msg === "object") setSession(msg);
    });
    socket.on(
      "overlay:config",
      (msg: { enabledWidgets?: string[]; voicePrefs?: VoicePrefs }) => {
        if (msg && Array.isArray(msg.enabledWidgets)) {
          setEnabled(new Set(msg.enabledWidgets as WidgetId[]));
        }
        if (msg && msg.voicePrefs && typeof msg.voicePrefs === "object") {
          setVoicePrefs(msg.voicePrefs);
        }
      },
    );
    // Streamer cancelled the test fire — drop every payload + visible
    // flag so the scene snaps clean instead of waiting for the natural
    // visibility timers to expire on each panel.
    socket.on("overlay:clear", () => onClear());
    return () => {
      socket.disconnect();
    };
  }, [token, setLive, setSession, setEnabled, setVoicePrefs, onClear]);
}

/**
 * Manage per-widget visibility timers. Each new `live` or `session`
 * payload schedules its own auto-hide based on the durations in
 * `widgetLifecycle.ts`. Test fires (`isTest: true`) force a short
 * timer onto normally-persistent widgets too.
 *
 * The hook is split out so both the all-in-one and per-widget overlay
 * clients can share the same lifecycle rules.
 */
function useWidgetTimers({
  live,
  session,
  setVisibleLive,
  setSessionVisible,
}: {
  live: LiveGamePayload | null;
  session: SessionSummary | null;
  setVisibleLive: (updater: (prev: Set<WidgetId>) => Set<WidgetId>) => void;
  setSessionVisible: (visible: boolean) => void;
}) {
  // Track all in-flight timeouts so we can cancel them on unmount AND
  // when a fresh payload supersedes the previous one. Per-widget
  // because a streamer queueing two games in quick succession should
  // re-arm each widget's timer from the new payload, not let the old
  // one fire mid-game.
  const liveTimers = useRef(new Map<WidgetId, number>());
  const sessionTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!live) return;
    const isTest = Boolean(live.isTest);
    // Widgets the live payload feeds — every widget except `session`,
    // which is driven off its own socket event.
    const liveWidgets: ReadonlyArray<WidgetId> = ALL_WIDGETS.filter(
      (id) => id !== "session",
    );
    setVisibleLive(() => new Set(liveWidgets));
    for (const id of liveWidgets) {
      const existing = liveTimers.current.get(id);
      if (existing !== undefined) window.clearTimeout(existing);
      const duration = resolveWidgetDurationMs(id, isTest);
      if (duration === null) continue;
      const handle = window.setTimeout(() => {
        setVisibleLive((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        liveTimers.current.delete(id);
      }, duration);
      liveTimers.current.set(id, handle);
    }
  }, [live, setVisibleLive]);

  useEffect(() => {
    if (!session) return;
    setSessionVisible(true);
    if (sessionTimer.current !== null) {
      window.clearTimeout(sessionTimer.current);
      sessionTimer.current = null;
    }
    const isTest = Boolean(session.isTest);
    const duration = resolveWidgetDurationMs("session", isTest);
    if (duration === null) return;
    sessionTimer.current = window.setTimeout(() => {
      setSessionVisible(false);
      sessionTimer.current = null;
    }, duration);
  }, [session, setSessionVisible]);

  // Drain any in-flight timers when the host component unmounts so
  // a fast scene swap in OBS doesn't leak timeouts past the lifetime
  // of the React tree.
  useEffect(() => {
    const liveTimerMap = liveTimers.current;
    return () => {
      for (const handle of liveTimerMap.values()) {
        window.clearTimeout(handle);
      }
      liveTimerMap.clear();
      if (sessionTimer.current !== null) {
        window.clearTimeout(sessionTimer.current);
        sessionTimer.current = null;
      }
    };
  }, []);
}
