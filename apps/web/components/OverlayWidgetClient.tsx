"use client";

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { API_BASE } from "@/lib/clientApi";
import type {
  LiveGameEnvelope,
  LiveGamePayload,
} from "@/components/overlay/types";
import { clientTimezone } from "@/lib/timeseries";
import {
  resolveWidgetDurationMs,
  type WidgetId,
} from "@/components/overlay/widgetLifecycle";
import {
  useVoiceReadout,
  type VoicePrefs,
} from "@/components/overlay/useVoiceReadout";
import { useClearStalePostGameOnGameKeyChange } from "@/components/overlay/useClearStalePostGameOnGameKeyChange";
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
  const [liveGame, setLiveGame] = useState<LiveGameEnvelope | null>(null);
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [enabled, setEnabled] = useState<boolean>(true);
  const [visible, setVisible] = useState<boolean>(false);
  const [voicePrefs, setVoicePrefs] = useState<VoicePrefs | null>(null);

  useOverlayWidgetSocket(
    token,
    widget,
    setLive,
    setLiveGame,
    setSession,
    setEnabled,
    setVoicePrefs,
  );
  useClearStalePostGameOnGameKeyChange(liveGame, live, setLive);
  useWidgetVisibility(
    widget as WidgetId,
    live,
    liveGame,
    session,
    setVisible,
  );

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
    // Pass the agent's pre-game envelope as a secondary trigger so the
    // scouting readout fires the moment the loading screen lands —
    // before the post-game replay-derived ``LiveGamePayload`` would
    // have been able to fire it minutes later.
    enableVoiceHere ? liveGame : null,
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
      <WidgetRenderer
        widget={widget as WidgetId}
        live={live}
        liveGame={liveGame}
        session={session}
      />
      {voice.needsGesture ? (
        <VoiceGestureBanner onClick={voice.onUserGesture} />
      ) : null}
    </div>
  );
}

function WidgetRenderer({
  widget,
  live,
  liveGame,
  session,
}: {
  widget: WidgetId;
  live: LiveGamePayload | null;
  liveGame: LiveGameEnvelope | null;
  session: SessionSummary | null;
}) {
  switch (widget) {
    case "opponent":
      // Opponent widget is the primary surface for the agent's pre-game
      // envelope — render it from ``liveGame`` when no post-game data
      // has landed yet, so the streamer's OBS scene shows the opponent
      // identity from the loading screen onward instead of staying blank
      // until the replay parses ~30 s after the match ends.
      return <OpponentWidget live={live} liveGame={liveGame} />;
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
      // Scouting widget — same priority rule as opponent: post-game
      // payload is authoritative, fall back to the agent's envelope.
      return <ScoutingWidget live={live} liveGame={liveGame} />;
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
  setLiveGame: (msg: LiveGameEnvelope | null) => void,
  setSession: (msg: SessionSummary | null) => void,
  setEnabled: (on: boolean) => void,
  setVoicePrefs: (prefs: VoicePrefs | null) => void,
) {
  // The latest gameKey we've observed in either ``live`` or
  // ``liveGame``. Used by the heartbeat reply handler to decide
  // whether the cloud's view has drifted from ours and a resync is
  // warranted. Living in a ref keeps the socket effect's dependency
  // list tiny — re-establishing the connection on every state tick
  // would defeat the resilience gains the resync flow provides.
  const gameKeyRef = useRef<string | null>(null);
  // Mirror the latest live envelope's gameKey for the
  // ``match_ended``-different-key clear branch. We can't read state
  // synchronously inside the socket handler so a ref is the simplest
  // way to get the previous value without re-binding the listener.
  const liveGameKeyRef = useRef<string | null>(null);
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
    socket.on("overlay:live", (msg: LiveGamePayload) => {
      setLive(msg);
      if (msg && typeof msg.gameKey === "string") {
        gameKeyRef.current = msg.gameKey;
      }
    });
    // Pre-game / in-game envelope from the desktop agent, fanned out
    // by the cloud's LiveGameBroker. Each envelope is a delta carrying
    // the same gameKey through MATCH_LOADING → MATCH_STARTED →
    // MATCH_IN_PROGRESS → MATCH_ENDED, with the opponent profile
    // sub-object filling in once Pulse responds.
    socket.on("overlay:liveGame", (msg: LiveGameEnvelope) => {
      if (!msg || typeof msg !== "object") return;
      // IDLE/MENU phases mean "no game" — clear the local cache so
      // widgets that had been showing pre-game data vanish on the
      // next render.
      if (msg.phase === "idle" || msg.phase === "menu") {
        setLiveGame(null);
        liveGameKeyRef.current = null;
        return;
      }
      // ``match_ended`` with a NEW gameKey means the previous match's
      // post-game ``live`` is stale — drop it so the next match's
      // post-game payload arrives onto a clean slate. The gameKey-
      // change effect handles the loading-screen path; this handles
      // the (rare but real) case of two ``match_ended`` events
      // arriving back-to-back without a ``match_loading`` between
      // them, e.g. a Browser Source that reconnected mid-score-screen
      // for the previous match and then immediately saw the new one.
      if (
        msg.phase === "match_ended"
        && typeof msg.gameKey === "string"
        && liveGameKeyRef.current
        && liveGameKeyRef.current !== msg.gameKey
      ) {
        setLive(null);
      }
      if (typeof msg.gameKey === "string") {
        liveGameKeyRef.current = msg.gameKey;
        gameKeyRef.current = msg.gameKey;
      }
      setLiveGame(msg);
    });
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
            setLiveGame(null);
            gameKeyRef.current = null;
            liveGameKeyRef.current = null;
          }
        }
      },
    );
    // Reconnect resync. After a transient network drop, OBS / SLOBS
    // socket.io clients auto-reconnect — but the cloud's broker would
    // only replay its single cached envelope. That's enough on the
    // happy path, but in practice the freshly-reconnected client also
    // wants the latest ``overlay:session`` and a synthetic
    // ``match_loading`` prelude (so the gameKey-change effect fires
    // when ``match_loading`` was the missed event). The cloud's
    // ``overlay:resync`` handler emits all three current snapshots in
    // one round-trip; rate-limited cloud-side to once per 2 s per
    // socket so a flapping connection can't pound the aggregations.
    socket.on("connect", () => {
      // ``connect`` fires for every successful (re-)connection,
      // including the first. The handler is safe to call on first
      // connect too — the cloud's resync emits the same data the
      // initial connect replay would, just slightly later.
      socket.emit("overlay:resync");
    });
    socket.on("reconnect", () => {
      // Some socket.io versions emit ``reconnect`` instead of
      // ``connect`` on a re-establishment; bind both to be safe.
      socket.emit("overlay:resync");
    });
    // Heartbeat. The cloud responds with ``{gameKey, ts}``; if the
    // gameKey doesn't match our latest, trigger a resync. This catches
    // the Streamlabs-cache-held-page failure mode where the socket
    // looks alive but somehow no recent envelope ever reached us
    // (their internal proxy sometimes delays event delivery while the
    // page is backgrounded). 30 s is gentle enough to be invisible
    // and tight enough that a rolled-back state recovers within one
    // game cycle.
    const heartbeatInterval = window.setInterval(() => {
      socket.emit("overlay:heartbeat");
    }, 30_000);
    socket.on(
      "overlay:heartbeat",
      (reply: { gameKey?: string | null } | undefined) => {
        const cloudKey =
          reply && typeof reply.gameKey === "string" ? reply.gameKey : null;
        if (cloudKey && cloudKey !== gameKeyRef.current) {
          socket.emit("overlay:resync");
        }
      },
    );
    return () => {
      window.clearInterval(heartbeatInterval);
      socket.disconnect();
    };
  }, [
    token,
    widget,
    setLive,
    setLiveGame,
    setSession,
    setEnabled,
    setVoicePrefs,
  ]);
}

// Re-export the shared stale-clear hook so existing test imports from
// this module keep working after the move. Two overlay clients consume
// it now (this file's per-widget client and the all-in-one
// ``OverlayClient``), and pulling the definition into a sibling module
// kept this file under 600 lines.
export { useClearStalePostGameOnGameKeyChange } from "@/components/overlay/useClearStalePostGameOnGameKeyChange";

/**
 * Re-arm the widget's auto-hide timer every time a fresh payload
 * arrives. The payload feed differs per widget — `session` reads from
 * the dedicated `overlay:session` event, every other widget reads
 * from the merged `overlay:live` payload — and each payload's
 * `isTest` flag picks production vs. test durations.
 *
 * Pre/in-game envelope handling (``liveGame``):
 *   The opponent and scouting widgets get a second source of
 *   visibility — the agent's pre-game ``overlay:liveGame`` envelope.
 *   While the bridge is reporting an ACTIVE match phase
 *   (``match_loading`` / ``match_started`` / ``match_in_progress``),
 *   the widget stays pinned and the auto-hide timer is suppressed —
 *   that's how the opponent dossier survives a 20-minute match instead
 *   of timing out at the per-widget natural duration.
 *
 *   Once the bridge flips to ``match_ended`` (SC2 reported a result)
 *   we DROP the suppression and let the natural per-widget timer run.
 *   Real-stream repro: a streamer can sit on the SC2 score screen for
 *   30 s – several minutes after a game; under the prior "any non-idle
 *   phase suppresses the timer" rule, the scouting widget would stay
 *   pinned that whole time. Letting ``match_ended`` use the natural
 *   22 s scouting timer lines up with the post-game card the cloud
 *   ships when the replay parses (typically within ~30 s of game end).
 *
 *   ``idle`` / ``menu`` envelopes are also handled by the socket layer
 *   clearing ``liveGame`` to null entirely, so the widget falls through
 *   to whatever ``live`` has cached and uses its natural timer.
 */
export function useWidgetVisibility(
  widget: WidgetId,
  live: LiveGamePayload | null,
  liveGame: LiveGameEnvelope | null,
  session: SessionSummary | null,
  setVisible: (visible: boolean) => void,
) {
  const timerRef = useRef<number | null>(null);

  // Widgets that participate in the agent's pre-game flow get a
  // second source of visibility ("the bridge says we're in a match").
  // Other widgets continue to derive visibility purely from the
  // post-game ``overlay:live`` payload.
  const consumesLiveGame = widget === "opponent" || widget === "scouting";
  // Active match phases — used to count the live envelope as a
  // render source. ``match_ended`` deliberately drops out so the
  // widget falls through to the post-game ``live`` payload (or hides
  // naturally if neither is set).
  const isActivePhase =
    !!liveGame
    && (liveGame.phase === "match_loading"
      || liveGame.phase === "match_started"
      || liveGame.phase === "match_in_progress");
  const liveGameActive = consumesLiveGame && isActivePhase;
  // Pin only the OPPONENT widget through gameplay so viewers see who
  // their streamer's playing for the whole match. Scouting deliberately
  // is NOT pinned — it's a giant intel dossier meant for the loading
  // screen + first 20s of the match; pinning it for 15 minutes of
  // gameplay would dominate the OBS scene. Streamer feedback after the
  // first ladder test: "scouting stays on the screen way too long."
  const pinThroughMatch = widget === "opponent" && isActivePhase;

  const sourceForWidget = widget === "session" ? session : live;
  const isTest = Boolean(
    widget === "session" ? session?.isTest : live?.isTest,
  );
  const hasAnySource = Boolean(sourceForWidget) || Boolean(liveGameActive);
  // Identity of the current match. When this changes between renders
  // we MUST re-arm the visibility timer even if ``hasAnySource`` is
  // unchanged: the scouting widget's natural 15 s timer expires
  // mid-match and leaves ``visible=false``; on the next match's
  // ``match_loading`` envelope the boolean ``hasAnySource`` stays
  // ``true`` (post-game ``live`` and the new ``liveGame`` overlap for
  // a moment around the gameKey-clear effect) so without a fresh
  // identity dependency the effect would never re-fire and the
  // streamer's scouting card would stay hidden until they refresh
  // the OBS Browser Source — exactly the bug we hit.
  //
  // Prefer the live envelope's gameKey because it's the freshest signal
  // mid-match; fall back to the post-game payload's gameKey when we
  // only have the latter (replay-only path). ``null`` covers the brief
  // window between page boot and the first envelope where neither
  // identity is known.
  const currentGameKey = liveGame?.gameKey ?? live?.gameKey ?? null;

  useEffect(() => {
    // No source at all (e.g. after the streamer cancelled a Test fire
    // AND the bridge has cleared back to idle) — hide immediately and
    // drop the pending visibility timer so a stale tick can't flip the
    // widget back on.
    if (!hasAnySource) {
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
    // Pin the opponent widget through active gameplay so viewers see
    // who their streamer is playing for the whole match — scouting
    // deliberately does NOT get this pin (see comment on
    // ``pinThroughMatch``). The natural timer fires for everything
    // else, including the scouting card during gameplay.
    if (pinThroughMatch) return;
    const duration = resolveWidgetDurationMs(widget, isTest);
    if (duration === null) return;
    timerRef.current = window.setTimeout(() => {
      setVisible(false);
      timerRef.current = null;
    }, duration);
  }, [widget, hasAnySource, pinThroughMatch, isTest, currentGameKey, setVisible]);

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
