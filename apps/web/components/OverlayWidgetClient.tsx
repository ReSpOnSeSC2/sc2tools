"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { io, type Socket } from "socket.io-client";
import { API_BASE } from "@/lib/clientApi";
import type {
  LiveGameEnvelope,
  LiveGamePayload,
} from "@/components/overlay/types";
import { clientTimezone } from "@/lib/timeseries";
import {
  payloadTargetsWidget,
  resolveWidgetDurationMs,
  type WidgetId,
} from "@/components/overlay/widgetLifecycle";
import {
  useVoiceReadout,
  type VoicePrefs,
} from "@/components/overlay/useVoiceReadout";
import { useClearStalePostGameOnGameKeyChange } from "@/components/overlay/useClearStalePostGameOnGameKeyChange";
import {
  mergeLiveGameStreamerHistory,
  type StickyStreamerHistory,
} from "@/components/overlay/mergeLiveGameStreamerHistory";
import {
  attachOverlayResilience,
  type OverlayConnectionStatus,
} from "@/components/overlay/overlayResilience";
import { ReconnectDot } from "@/components/overlay/ReconnectDot";
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
  RandomizerWidget,
  GhostBuildWidget,
  MultiChatWidget,
  ChatHighlightWidget,
  ChatPollWidget,
  ChatAlertsWidget,
  StreamGoalsWidget,
  ChatOracleWidget,
  ClipFlagWidget,
  LowerThirdWidget,
  StatsTickerWidget,
  CountdownTimerWidget,
  SessionRecapWidget,
  StreamSceneWidget,
  SupporterWallWidget,
  type SessionSummary,
} from "@/components/overlay/widgets/PrePostFlow";
import type { RandomizerConfig } from "@/lib/randomizer/types";
import { sanitizeRandomizerConfig } from "@/lib/randomizer/config";
import { useRevealAudioUnlock } from "@/components/randomizer/reveals/revealSound";
import { decodeOverlayTheme, themeToCssVars } from "@/lib/overlayTheme";
import {
  decodeGhostBuildConfig,
  decodeGhostTarget,
  readGhostBuildParamFromHash,
} from "@/lib/ghostBuild";

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
  themeParam = null,
  ghostParam = null,
}: {
  token: string;
  widget: string;
  /**
   * Raw ``?theme=`` search param forwarded by the server page. Decoded
   * once (strict validation — hostile/malformed values fall back to the
   * stock look) and applied as ``--ov-*`` CSS custom properties on the
   * widget frame, where WidgetShell picks them up.
   */
  themeParam?: string | null;
  /**
   * Raw legacy ``?ghost=`` search param forwarded by the server page.
   * New v2 loadouts are read from ``#ghost=`` in this client so their
   * potentially large payload is never sent to the server. Both paths are
   * strict-validated; malformed values behave exactly like "not armed".
   */
  ghostParam?: string | null;
}) {
  const [live, setLive] = useState<LiveGamePayload | null>(null);
  const [liveGame, setLiveGame] = useState<LiveGameEnvelope | null>(null);
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [enabled, setEnabled] = useState<boolean>(true);
  const [visible, setVisible] = useState<boolean>(false);
  const [voicePrefs, setVoicePrefs] = useState<VoicePrefs | null>(null);
  const [randomizer, setRandomizer] = useState<RandomizerConfig | null>(null);
  // Latest raw ``overlay:multichat`` studio payload — validated by the
  // studio widgets themselves (useStudioState re-sanitizes it).
  const [studioEvent, setStudioEvent] = useState<unknown>(null);
  // Latest raw ``overlay:engagement`` payload — re-sanitized by the
  // engagement widgets themselves (useEngagementState).
  const [engagementEvent, setEngagementEvent] = useState<unknown>(null);
  const [fragmentGhostParam, setFragmentGhostParam] = useState<string | null>(
    null,
  );
  const [connectionStatus, setConnectionStatus] =
    useState<OverlayConnectionStatus>("connected");

  useOverlayWidgetSocket(
    token,
    widget,
    setLive,
    setLiveGame,
    setSession,
    setEnabled,
    setVoicePrefs,
    setRandomizer,
    setStudioEvent,
    setEngagementEvent,
    setConnectionStatus,
  );
  useClearStalePostGameOnGameKeyChange(liveGame, live, setLive);
  useWidgetVisibility(
    widget as WidgetId,
    live,
    liveGame,
    session,
    setVisible,
  );
  // Pre-warm the reveal AudioContext the moment the randomizer source
  // loads — well before a Test fire — so the streamer's first Test isn't
  // silent on a cold page (see useRevealAudioUnlock).
  useRevealAudioUnlock(widget === "randomizer");

  // URL fragments never reach Next/Vercel, so v2 Ghost loadouts must be read
  // after hydration. Keep listening for hash changes so replacing a Browser
  // Source URL in-place updates the coach without a server navigation.
  useEffect(() => {
    if (widget !== "ghost-build") return;
    const refresh = () => {
      setFragmentGhostParam(readGhostBuildParamFromHash(window.location.hash));
    };
    refresh();
    window.addEventListener("hashchange", refresh);
    return () => window.removeEventListener("hashchange", refresh);
  }, [widget]);

  // A valid v2 fragment wins when both forms exist. Falling back to the
  // server-forwarded query value keeps every previously copied ?ghost= URL
  // working, including legacy single-build links that show migration guidance.
  const effectiveGhostParam =
    widget === "ghost-build" ? fragmentGhostParam ?? ghostParam : ghostParam;

  // Theme vars, decoded once at mount. Default theme → empty object →
  // zero style overrides, so untouched URLs render exactly as before.
  const themeVars = useMemo(() => {
    return themeToCssVars(decodeOverlayTheme(themeParam));
  }, [themeParam]);

  // Ghost Build is a URL-armed persistent HUD: a valid Ghost URL value
  // IS the opt-in, so it bypasses two gates the other widgets
  // sit behind —
  //   * the payload-driven visibility timer (it must render its idle
  //     "armed" card between games, when no payload exists at all);
  //   * the server's enabledWidgets list (the cloud's widget registry
  //     predates this widget and, by design, needed zero server
  //     changes to ship it).
  // Without a valid target the widget follows the normal machinery
  // (a Test fire shows its placement hint for the standard window).
  const ghostArmed = useMemo(
    () =>
      widget === "ghost-build"
      && (
        decodeGhostBuildConfig(effectiveGhostParam) !== null
        || decodeGhostTarget(effectiveGhostParam) !== null
      ),
    [widget, effectiveGhostParam],
  );
  const effectiveEnabled = widget === "ghost-build" ? true : enabled;

  // Multichat and the Stream Studio widgets are persistent, fully
  // self-driven HUDs: multichat opens its own chat connections
  // (Twitch IRC / Kick Pusher / cloud relays), and the studio widgets
  // gate themselves on the ``overlay:multichat`` studio state — none
  // consume game payloads, so the payload-driven visibility timer
  // must not gate them. The server's enabledWidgets toggle still
  // applies via ``effectiveEnabled``.
  const alwaysVisible = SELF_DRIVEN_WIDGETS.has(widget as WidgetId);

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

  if (!effectiveEnabled || (!visible && !ghostArmed && !alwaysVisible)) {
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
      style={
        {
          position: "relative",
          minHeight: "100vh",
          width: "100%",
          background: "transparent",
          ...themeVars,
        } as CSSProperties
      }
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
        token={token}
        live={live}
        liveGame={liveGame}
        session={session}
        randomizer={randomizer}
        ghostParam={effectiveGhostParam}
        studioEvent={studioEvent}
        engagementEvent={engagementEvent}
      />
      {/* Only mounted while widget content is on screen (this branch)
          — a transparent between-games scene stays fully transparent
          even when the socket is down. */}
      {connectionStatus === "reconnecting" ? <ReconnectDot /> : null}
      {voice.needsGesture ? (
        <VoiceGestureBanner onClick={voice.onUserGesture} />
      ) : null}
    </div>
  );
}

/**
 * Widgets that bypass the payload-driven visibility timer entirely —
 * they render transparent on their own when there's nothing to show.
 */
const SELF_DRIVEN_WIDGETS: ReadonlySet<WidgetId> = new Set<WidgetId>([
  "multichat",
  "chat-highlight",
  "chat-poll",
  "chat-alerts",
  "stream-goals",
  "session-recap",
  "stream-scene",
  "chat-oracle",
  "supporter-wall",
  "clip-flag",
  "stats-ticker",
  "countdown-timer",
]);

function WidgetRenderer({
  widget,
  token,
  live,
  liveGame,
  session,
  randomizer,
  ghostParam,
  studioEvent,
  engagementEvent,
}: {
  widget: WidgetId;
  token: string;
  live: LiveGamePayload | null;
  liveGame: LiveGameEnvelope | null;
  session: SessionSummary | null;
  randomizer: RandomizerConfig | null;
  ghostParam: string | null;
  studioEvent: unknown;
  engagementEvent: unknown;
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
    case "randomizer":
      return (
        <RandomizerWidget live={live} liveGame={liveGame} config={randomizer} />
      );
    case "ghost-build":
      // Practice coach — the target build rides in this Browser
      // Source's own validated Ghost URL value, not in any payload.
      return (
        <GhostBuildWidget live={live} liveGame={liveGame} ghostParam={ghostParam} />
      );
    case "multichat":
      // Unified Twitch/Kick/YouTube/TikTok chat — self-driven; the
      // token is its auth for the cloud chat relays. ``live`` is read
      // only for the Settings Test-fire flag.
      return (
        <MultiChatWidget
          token={token}
          live={live}
          studioEvent={studioEvent}
        />
      );
    case "chat-highlight":
      // Stream Studio family — all gated on the studio state pushed
      // as ``overlay:multichat`` (and fetched at boot); each renders
      // transparent until the Stream Dock gives it content. ``live``
      // is read only for the Settings Test-fire flag.
      return (
        <ChatHighlightWidget token={token} studioEvent={studioEvent} live={live} />
      );
    case "chat-poll":
      return <ChatPollWidget token={token} studioEvent={studioEvent} live={live} />;
    case "chat-alerts":
      return (
        <ChatAlertsWidget token={token} studioEvent={studioEvent} live={live} />
      );
    case "stream-goals":
      return (
        <StreamGoalsWidget token={token} studioEvent={studioEvent} live={live} />
      );
    case "session-recap":
      return (
        <SessionRecapWidget
          token={token}
          studioEvent={studioEvent}
          session={session}
          live={live}
        />
      );
    case "stream-scene":
      // Full-screen BRB / Starting Soon scene — driven entirely by
      // the Stream Dock's Scenes panel via the studio state.
      return (
        <StreamSceneWidget token={token} studioEvent={studioEvent} live={live} />
      );
    case "chat-oracle":
      // Engagement family — gated on the ``overlay:engagement``
      // stream (and the boot summary); ``live`` is Test-fire only.
      return (
        <ChatOracleWidget token={token} engagementEvent={engagementEvent} live={live} />
      );
    case "supporter-wall":
      return (
        <SupporterWallWidget token={token} engagementEvent={engagementEvent} live={live} />
      );
    case "clip-flag":
      return (
        <ClipFlagWidget token={token} engagementEvent={engagementEvent} live={live} />
      );
    case "lower-third":
      // Broadcast-style post-game bar — payload-driven, standard
      // visibility timer slides it away between games.
      return <LowerThirdWidget live={live} />;
    case "countdown-timer":
      // Standalone dock-set countdown — studio-driven, show anytime.
      return (
        <CountdownTimerWidget token={token} studioEvent={studioEvent} live={live} />
      );
    case "stats-ticker":
      // Persistent scrolling bottom line — self-driven, composes
      // session/result/goals/engagement/opponent-intel/career-facts
      // into an endless marquee. ``liveGame`` powers the in-game
      // opponent segments (H2H, cheese watch, scouted opener).
      return (
        <StatsTickerWidget
          token={token}
          studioEvent={studioEvent}
          engagementEvent={engagementEvent}
          live={live}
          liveGame={liveGame}
          session={session}
        />
      );
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
  setRandomizer: (cfg: RandomizerConfig | null) => void,
  setStudioEvent: (msg: unknown) => void,
  setEngagementEvent: (msg: unknown) => void,
  setConnectionStatus: (status: OverlayConnectionStatus) => void,
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
  // Sticky cache of the latest enriched ``streamerHistory`` keyed by
  // gameKey + normalized opponent name. The cloud's ``LiveGameBroker``
  // fans every 1 Hz envelope
  // tick out twice — first as a partial (no ``streamerHistory``) and
  // then enriched (with ``streamerHistory``). Without preserving the
  // enriched block across the partial tick, the scouting + opponent
  // widgets flicker between the rich card and the thin pre-game
  // placeholder once per second of the match. Clearing on a gameKey
  // change keeps the next match from inheriting the previous one's
  // history.
  const stickyHistoryRef = useRef<StickyStreamerHistory | null>(null);
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
      // A token's Browser Sources all share this room. Per-widget Test
      // events carry their destination so neighbouring sources do not
      // light up (Ghost Build used to trigger the full layout here).
      if (!payloadTargetsWidget(msg, widget as WidgetId)) return;
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
        stickyHistoryRef.current = null;
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
      // Merge partial/enriched tick pairs only when both gameKey and
      // opponent identity agree. Older agents could reuse a key across
      // opponents, so key-only caching can attach the finished player's
      // history to the next match.
      const merged = mergeLiveGameStreamerHistory(
        msg,
        stickyHistoryRef.current,
      );
      stickyHistoryRef.current = merged.sticky;
      setLiveGame(merged.envelope);
    });
    socket.on(
      "overlay:config",
      (msg: {
        enabledWidgets?: string[];
        voicePrefs?: VoicePrefs;
        randomizer?: unknown;
      }) => {
        if (msg && Array.isArray(msg.enabledWidgets)) {
          setEnabled(msg.enabledWidgets.includes(widget));
        }
        if (msg && msg.voicePrefs && typeof msg.voicePrefs === "object") {
          setVoicePrefs(msg.voicePrefs);
        }
        if (msg && msg.randomizer && typeof msg.randomizer === "object") {
          setRandomizer(sanitizeRandomizerConfig(msg.randomizer));
        }
      },
    );
    socket.on("overlay:session", (msg: SessionSummary) => {
      if (msg && typeof msg === "object") setSession(msg);
    });
    // Stream Studio state (highlight / poll / goals / recap trigger) —
    // stored raw; the studio widgets defensively re-sanitize it via
    // useStudioState before rendering anything.
    socket.on("overlay:multichat", (msg: unknown) => {
      if (msg && typeof msg === "object") setStudioEvent(msg);
    });
    socket.on("overlay:engagement", (msg: unknown) => {
      if (msg && typeof msg === "object") setEngagementEvent(msg);
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
            stickyHistoryRef.current = null;
          }
        }
      },
    );
    // Reconnect resync + heartbeat/drift detection + connection
    // status — shared with the all-in-one OverlayClient via
    // ``attachOverlayResilience`` (see that module for the rationale:
    // resync on every (re-)connect, 30 s heartbeat with gameKey drift
    // check for the Streamlabs backgrounded-page failure mode, and a
    // debounced status for the broadcast-safe reconnect dot).
    const detachResilience = attachOverlayResilience(socket, {
      latestGameKey: () => gameKeyRef.current,
      onStatus: setConnectionStatus,
    });
    return () => {
      detachResilience();
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
    setRandomizer,
    setStudioEvent,
    setConnectionStatus,
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
  const consumesLiveGame =
    widget === "opponent" || widget === "scouting" || widget === "randomizer";
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
  // The randomizer is a game-START reveal driven by the agent's active-
  // phase envelope (and test fires). A real post-game ``live`` payload —
  // one carrying a ``result`` — must NOT count as a visibility source for
  // it: the mid-match timer already unmounted the widget, and re-showing
  // it on the post-game payload remounts it with a fresh spin-dedupe ref,
  // producing a duplicate spin at game END. The agent-offline pre-game
  // path (a ``live`` with no result) still shows it.
  const liveCountsAsSource =
    widget !== "randomizer" || isTest || !live?.result;
  const hasAnySource =
    (Boolean(sourceForWidget) && liveCountsAsSource) || Boolean(liveGameActive);
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
  // Test payloads deliberately have no gameKey. The API stamps every Test
  // click with a nonce so the dedicated randomizer source can distinguish a
  // fresh replay from the still-cached payload whose timer already expired.
  // Keep this randomizer-only: other widgets retain their established
  // visibility identity, while the composite client already re-arms from the
  // complete `live` object.
  const randomizerTestNonce =
    widget === "randomizer" && isTest ? (live?.testNonce ?? null) : null;

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
  }, [
    widget,
    hasAnySource,
    pinThroughMatch,
    isTest,
    currentGameKey,
    randomizerTestNonce,
    setVisible,
  ]);

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
