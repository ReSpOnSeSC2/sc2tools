"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
  type ReactNode,
} from "react";
import { OverlayLocalPreviewFrame, localPreviewRandomizer } from "@/components/overlay/OverlayLocalPreviewFrame";
import { CompositeTestWidgets } from "@/components/overlay/CompositeTestWidgets";
import { useOverlayTestLayer, type TestClear } from "@/components/overlay/useOverlayTestLayer";
import type { Socket } from "socket.io-client";
import type {
  LiveGameEnvelope,
  LiveGamePayload,
} from "@/components/overlay/types";
import {
  ALL_WIDGETS,
  extendStartWindow,
  payloadTargetsWidget,
  resolveWidgetDurationMs,
  type WidgetId,
} from "@/components/overlay/widgetLifecycle";
import type { RandomizerWindowAnchor } from "@/components/overlay/buildIntentGate";
import {
  useOverlayBuildIntents,
  useRandomizerCheckin,
} from "@/components/overlay/useRandomizerCheckin";
import {
  useVoiceReadout,
  type VoicePrefs,
} from "@/components/overlay/useVoiceReadout";
import { useClearStalePostGameOnGameKeyChange } from "@/components/overlay/useClearStalePostGameOnGameKeyChange";
import {
  useGameStartTriggerKey,
  useScoutingStartTriggerKey,
} from "@/components/overlay/gameStartTrigger";
import {
  attachOverlayResilience,
  createOverlaySocket,
  hasActiveOverlayGame,
  type OverlayConnectionStatus,
} from "@/components/overlay/overlayResilience";
import { OverlaySetupCard, OverlayCheckBadge } from "@/components/overlay/OverlaySetupCard";
import { ReconnectDot } from "@/components/overlay/ReconnectDot";
import { VoiceGestureBanner } from "@/components/overlay/VoiceGestureBanner";
import { OverlayCredit } from "@/components/overlay/OverlayCredit";
import { OpponentWidget } from "@/components/overlay/widgets/OpponentWidget";
import { MatchResultWidget } from "@/components/overlay/widgets/MatchResultWidget";
import { PostGameWidget } from "@/components/overlay/widgets/PostGameWidget";
import { MmrDeltaWidget } from "@/components/overlay/widgets/MmrDeltaWidget";
import { StreakWidget } from "@/components/overlay/widgets/StreakWidget";
import { CheeseWidget } from "@/components/overlay/widgets/CheeseWidget";
import { RematchWidget } from "@/components/overlay/widgets/RematchWidget";
import { RivalWidget } from "@/components/overlay/widgets/RivalWidget";
import { RankWidget } from "@/components/overlay/widgets/RankWidget";
import { MetaWidget } from "@/components/overlay/widgets/MetaWidget";
import { TopBuildsWidget } from "@/components/overlay/widgets/TopBuildsWidget";
import { FavOpeningWidget } from "@/components/overlay/widgets/FavOpeningWidget";
import { BestAnswerWidget } from "@/components/overlay/widgets/BestAnswerWidget";
import { ScoutingWidget } from "@/components/overlay/widgets/ScoutingWidget";
import {
  SessionWidget,
  type SessionSummary,
} from "@/components/overlay/widgets/SessionWidget";
import { RandomizerWidget } from "@/components/overlay/widgets/RandomizerWidget";
import type { RandomizerConfig } from "@/lib/randomizer/types";
import { sanitizeRandomizerConfig } from "@/lib/randomizer/config";
import { useRevealAudioUnlock } from "@/components/randomizer/reveals/revealSound";
import { decodeOverlayTheme, themeToCssVars } from "@/lib/overlayTheme";
import { useOverlayProfile, type OverlayProfileConfig } from "@/lib/useOverlayProfile";
import type { OverlayProfile } from "@/lib/overlayProfile";
import {
  mergeLiveGameStreamerHistory,
  type StickyStreamerHistory,
} from "@/components/overlay/mergeLiveGameStreamerHistory";
import { hasLiveIntel, LIVE_INTEL_WIDGETS, liveIntelPayload } from "@/components/overlay/liveIntelPayload";

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
export function OverlayClient(props: Parameters<typeof ConnectedOverlayClient>[0] & { demo?: LiveGamePayload }) {
  if (props.demo) return <LocalCompositePreview sample={props.demo} themeParam={props.themeParam} />;
  return <ConnectedOverlayClient key={props.token} {...props} />;
}

function LocalCompositePreview({ sample, themeParam }: { sample: LiveGamePayload; themeParam?: string | null }) {
  const randomizer = useMemo(localPreviewRandomizer, []);
  const theme = useMemo(() => themeToCssVars(decodeOverlayTheme(themeParam || null)), [themeParam]);
  return <div className="relative h-screen w-screen" style={theme as CSSProperties}><OverlayLocalPreviewFrame sample={sample}>{(live) => <CompositeTestWidgets live={live} session={live.session as SessionSummary || null} randomizer={randomizer} targets={() => true} />}</OverlayLocalPreviewFrame></div>;
}

function ConnectedOverlayClient({
  token,
  themeParam = null,
  showCredit,
}: {
  token: string;
  /**
   * Raw ``?theme=`` search param forwarded by the server page. Decoded
   * once (strict validation — hostile/malformed values fall back to the
   * stock look) and applied as ``--ov-*`` CSS custom properties on the
   * overlay root, where every WidgetShell picks them up.
   */
  themeParam?: string | null;
  /**
   * Show the "Overlay by sc2tools.com" credit while widgets are on
   * screen (default). The server page turns it off for ``?credit=0``.
   */
  showCredit?: boolean;
}) {
  const [live, setLive] = useState<LiveGamePayload | null>(null);
  const { themeVars, optionsRef, receiveProfile } = useOverlayProfile(token, themeParam);
  const testLayer = useOverlayTestLayer(token, optionsRef);
  const [liveGame, setLiveGame] = useState<LiveGameEnvelope | null>(null);
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [enabled, setEnabled] = useState<Set<WidgetId>>(
    () => new Set(ALL_WIDGETS),
  );
  const [voicePrefs, setVoicePrefs] = useState<VoicePrefs | null>(null);
  const [randomizer, setRandomizer] = useState<RandomizerConfig | null>(null);
  // Per-widget "currently visible" set. Cleared by the per-widget
  // timeouts scheduled in `useWidgetTimers`.
  const [visibleLive, setVisibleLive] = useState<Set<WidgetId>>(new Set());
  const [sessionVisible, setSessionVisible] = useState<boolean>(false);
  const [connectionStatus, setConnectionStatus] =
    useState<OverlayConnectionStatus>("connecting");
  const [buildIntents, onBuildIntent] = useOverlayBuildIntents(token);

  const socketRef = useOverlaySocket(
    token,
    setLive,
    setLiveGame,
    setSession,
    setEnabled,
    setVoicePrefs,
    setRandomizer,
    testLayer.receiveLive,
    testLayer.receiveSession,
    testLayer.clear,
    setConnectionStatus,
    onBuildIntent,
    receiveProfile,
  );

  // Mirror the per-widget client's stale-clear behaviour so the
  // all-in-one overlay also drops a stale post-game ``live`` payload
  // when the agent's envelope reports a new gameKey. Shared hook keeps
  // the two clients in lockstep.
  useClearStalePostGameOnGameKeyChange(liveGame, live, setLive);

  // A per-widget Test for another source must not reach the randomizer.
  const randomizerTargeted = payloadTargetsWidget(live, "randomizer");
  const randomizerLive = randomizerTargeted ? live : null;
  const randomizerLiveGame = randomizerTargeted ? liveGame : null;
  const randomizerCheckin = useRandomizerCheckin(
    socketRef,
    randomizerLive,
    randomizerLiveGame,
    buildIntents,
  );

  useWidgetTimers({
    live,
    liveGame,
    session,
    setVisibleLive,
    setSessionVisible,
    randomizerAnchor: randomizerCheckin.windowAnchor,
    optionsRef,
  });

  // Single-widget mode (OBS users place each widget in its own
  // Browser Source). Read from URL search param, defaulting to "all".
  const singleWidget = useMemo<WidgetId | null>(() => {
    if (typeof window === "undefined") return null;
    const w = new URLSearchParams(window.location.search).get("w");
    if (!w) return null;
    return ALL_WIDGETS.includes(w as WidgetId) ? (w as WidgetId) : null;
  }, []);

  // Voice readout is owned by exactly one Browser Source per stream so
  // the streamer never hears the same scouting line twice. In all-in-one
  // mode that's the unfiltered overlay; in single-widget mode it's the
  // ``?w=scouting`` source. Any other ``?w=`` filter explicitly opts out
  // — those are sibling Browser Sources that share the room.
  const enableVoiceHere = singleWidget === null || singleWidget === "scouting";
  const voice = useVoiceReadout(
    enableVoiceHere ? testLayer.targets("scouting") ? testLayer.live : live : null,
    enableVoiceHere ? voicePrefs : null,
    // Plumb the agent's envelope so the voice line fires when the match
    // starts, without waiting for the replay-derived ``live`` payload.
    // Mirrors the per-widget ``OverlayWidgetClient`` for the same
    // readout whether they wired the all-in-one URL or the dedicated
    // scouting Browser Source.
    enableVoiceHere ? liveGame : null,
  );

  // Pre-warm the reveal AudioContext whenever this overlay could render
  // the randomizer, so the streamer's first Test fire isn't silent on a
  // cold page (see useRevealAudioUnlock).
  useRevealAudioUnlock(singleWidget === null || singleWidget === "randomizer");

  function shouldShow(id: WidgetId): boolean {
    if (singleWidget && singleWidget !== id) return false;
    // The all-in-one source shares the same token room as every
    // dedicated source. A per-widget Test must render only its target;
    // Ghost Build is dedicated-only, so its probe leaves this composite
    // source transparent instead of firing generic neighbouring cards.
    if (!payloadTargetsWidget(live, id)) return false;
    if (!enabled.has(id)) return false;
    if (id === "session") return sessionVisible;
    return visibleLive.has(id);
  }

  const intel = liveIntelPayload(live, liveGame);
  const testTargets = (id: WidgetId) => enabled.has(id) && (!singleWidget || singleWidget === id) && testLayer.targets(id);
  const realSlot = (id: WidgetId, card: ReactNode) => <div data-overlay-real={id} style={{ display: testTargets(id) ? "none" : undefined }}>{card}</div>;

  if (connectionStatus === "invalid") return <><OverlaySetupCard reason="invalid-token" /><OverlayCheckBadge status="invalid" /></>;

  return (
    <div
      className="relative h-screen w-screen"
      style={{ background: "transparent", ...themeVars } as CSSProperties}
    >
      <OverlayCheckBadge status={connectionStatus} live={hasActiveOverlayGame(liveGame)} />
      {shouldShow("opponent") && realSlot("opponent", <OpponentWidget live={live} liveGame={liveGame} />)}
      {shouldShow("match-result") && realSlot("match-result", <MatchResultWidget live={live} />)}
      {shouldShow("post-game") && realSlot("post-game", <PostGameWidget live={live} />)}
      {shouldShow("mmr-delta") && realSlot("mmr-delta", <MmrDeltaWidget live={live} />)}
      {shouldShow("streak") && realSlot("streak", <StreakWidget live={intel} />)}
      {shouldShow("cheese") && realSlot("cheese", <CheeseWidget live={intel} />)}
      {shouldShow("rematch") && realSlot("rematch", <RematchWidget live={intel} />)}
      {shouldShow("rival") && realSlot("rival", <RivalWidget live={intel} />)}
      {shouldShow("rank") && realSlot("rank", <RankWidget live={live} />)}
      {shouldShow("meta") && realSlot("meta", <MetaWidget live={intel} />)}
      {shouldShow("topbuilds") && realSlot("topbuilds", <TopBuildsWidget live={intel} />)}
      {shouldShow("fav-opening") && realSlot("fav-opening", <FavOpeningWidget live={intel} />)}
      {shouldShow("best-answer") && realSlot("best-answer", <BestAnswerWidget live={intel} />)}
      {shouldShow("scouting") && realSlot("scouting", <ScoutingWidget live={live} liveGame={liveGame} />)}
      {shouldShow("session") && realSlot("session", <SessionWidget live={live} session={session} />)}
      {/* Preserve the spin ledger through timed hides and brief bridge
          interruptions, so recovering the same match cannot replay it. */}
      {enabled.has("randomizer") && (!singleWidget || singleWidget === "randomizer") && (
        <div data-overlay-real="randomizer" style={{ display: shouldShow("randomizer") && !testTargets("randomizer") ? "block" : "none" }}>
          <RandomizerWidget
            live={randomizerLive}
            liveGame={randomizerLiveGame}
            config={randomizer}
            visible={shouldShow("randomizer")}
            intent={randomizerCheckin.intent}
            onSpin={randomizerCheckin.onSpin}
          />
        </div>
      )}
      <CompositeTestWidgets live={testLayer.live} session={testLayer.session} randomizer={randomizer} targets={testTargets} />
      {/* A refused first handshake has no widget payload to make visible. */}
      {connectionStatus === "reconnecting" ? (
        <ReconnectDot />
      ) : null}
      {voice.needsGesture ? (
        <VoiceGestureBanner onClick={voice.onUserGesture} />
      ) : null}
      <OverlayCredit placement="top-left" visible={compositeCreditVisible(showCredit, singleWidget, (id) => shouldShow(id) || testTargets(id))} />
    </div>
  );
}

/**
 * The credit rides along only while this composite source actually shows
 * a widget, so a between-games scene stays fully transparent. Dedicated
 * ``?w=`` sources never show it (several would stack up). An unset
 * ``showCredit`` means shown, the default.
 */
function compositeCreditVisible(
  showCredit: boolean | undefined,
  singleWidget: WidgetId | null,
  shouldShow: (id: WidgetId) => boolean,
): boolean {
  return showCredit !== false && singleWidget === null && COMPOSITE_WIDGETS.some(shouldShow);
}

/** The widgets this all-in-one source renders (keep in step with the JSX above). */
const COMPOSITE_WIDGETS: ReadonlyArray<WidgetId> = [
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
  "randomizer",
];

/**
 * Subscribe to the overlay socket and push the event streams into the
 * supplied React state setters. The setters are guaranteed stable by
 * React, so the effect's dependency on them never causes a reconnect.
 *
 * Four channels:
 *
 *   * ``overlay:live`` — post-game payload derived from the
 *     freshly-uploaded replay (``LiveGamePayload``).
 *   * ``overlay:liveGame`` — pre/in-game envelope fanned out by the
 *     cloud's ``LiveGameBroker`` (``LiveGameEnvelope``). Plumbed
 *     through so the voice readout + scouting widget can fire at match
 *     start instead of waiting for the replay parse minutes later.
 *   * ``overlay:session`` — today's session aggregate.
 *   * ``overlay:config`` — enabled widgets + voice prefs snapshot.
 *   * ``overlay:buildIntent`` — build check-in hold/suppress state that
 *     gates the randomizer's spin.
 *
 * Returns the live socket so the randomizer can report its roll on it.
 */
function useOverlaySocket(
  token: string,
  setLive: (msg: LiveGamePayload | null) => void,
  setLiveGame: (msg: LiveGameEnvelope | null) => void,
  setSession: (msg: SessionSummary | null) => void,
  setEnabled: (next: Set<WidgetId>) => void,
  setVoicePrefs: (prefs: VoicePrefs | null) => void,
  setRandomizer: (cfg: RandomizerConfig | null) => void,
  onTestLive: (msg: LiveGamePayload) => void,
  onTestSession: (msg: SessionSummary) => void,
  onClear: (msg: TestClear) => void,
  setConnectionStatus: (status: OverlayConnectionStatus) => void,
  onBuildIntent: (msg: unknown) => void,
  receiveProfile: (msg: OverlayProfileConfig) => void,
): RefObject<Socket | null> {
  const socketRef = useRef<Socket | null>(null);
  // Sticky cache of the latest enriched ``streamerHistory`` keyed by
  // gameKey + normalized opponent name. The cloud's ``LiveGameBroker``
  // fans every 1 Hz envelope
  // tick out twice — first as a partial (no ``streamerHistory``) and
  // then enriched (with ``streamerHistory``). Without preserving the
  // enriched block across the partial tick, the scouting + opponent
  // widgets flicker between the rich card and the thin pre-game
  // placeholder once per second of the match.
  const stickyHistoryRef = useRef<StickyStreamerHistory | null>(null);
  // Latest gameKey observed from either channel — the heartbeat drift
  // check in ``attachOverlayResilience`` compares the cloud's view
  // against this to detect silently-dropped events.
  const gameKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const connection = createOverlaySocket(token, { surface: "all-in-one", onStatus: setConnectionStatus });
    const socket = connection.socket;
    socketRef.current = socket;
    socket.on("overlay:live", (msg: LiveGamePayload) => {
      if (msg?.isTest) { onTestLive(msg); return; }
      setLive(msg);
      if (msg && typeof msg.gameKey === "string") {
        gameKeyRef.current = msg.gameKey;
      }
    });
    socket.on("overlay:liveGame", (msg: LiveGameEnvelope) => {
      if (!msg || typeof msg !== "object") return;
      // IDLE/MENU phases mean "no game" — clear so the widgets and
      // voice readout's per-gameKey state reset for the next match.
      if (msg.phase === "idle" || msg.phase === "menu") {
        setLiveGame(null);
        stickyHistoryRef.current = null;
        return;
      }
      if (typeof msg.gameKey === "string") {
        gameKeyRef.current = msg.gameKey;
      }
      // Preserve partial/enriched tick pairs only when the direct opponent
      // identity also agrees. A gameKey alone is not safe on older agents.
      const merged = mergeLiveGameStreamerHistory(
        msg,
        stickyHistoryRef.current,
      );
      stickyHistoryRef.current = merged.sticky;
      setLiveGame(merged.envelope);
    });
    socket.on("overlay:session", (msg: SessionSummary) => {
      if (msg?.isTest) { onTestSession(msg); return; }
      if (msg && typeof msg === "object") setSession(msg);
    });
    socket.on(
      "overlay:config",
      (msg: {
        enabledWidgets?: string[];
        voicePrefs?: VoicePrefs;
        randomizer?: unknown;
      } & OverlayProfileConfig) => {
        receiveProfile(msg);
        if (msg && Array.isArray(msg.enabledWidgets)) {
          setEnabled(new Set(msg.enabledWidgets as WidgetId[]));
        }
        if (msg && msg.voicePrefs && typeof msg.voicePrefs === "object") {
          setVoicePrefs(msg.voicePrefs);
        }
        if (msg && msg.randomizer && typeof msg.randomizer === "object") {
          setRandomizer(sanitizeRandomizerConfig(msg.randomizer));
        }
      },
    );
    // Replayed by the cloud on connect and resync, like the envelope.
    socket.on("overlay:buildIntent", onBuildIntent);
    socket.on("overlay:clear", onClear);
    // Reconnect resync + heartbeat/drift detection + connection
    // status — shared with the per-widget OverlayWidgetClient via
    // ``attachOverlayResilience``. This client previously had NONE of
    // this and relied solely on the server's connect-replay, so a
    // transient drop left every widget silently stale until the next
    // game tick.
    const detachResilience = attachOverlayResilience(socket, {
      latestGameKey: () => gameKeyRef.current,
    });
    return () => {
      detachResilience();
      connection.dispose();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [
    token,
    setLive,
    setLiveGame,
    setSession,
    setEnabled,
    setVoicePrefs,
    setRandomizer,
    onTestLive,
    onTestSession,
    onClear,
    setConnectionStatus,
    onBuildIntent,
    receiveProfile,
  ]);
  return socketRef;
}

/**
 * Manage per-widget visibility timers. Each new `live` or `session`
 * payload schedules its own auto-hide based on the durations in
 * `widgetLifecycle.ts`. Test fires (`isTest: true`) force a short
 * timer onto normally-persistent widgets too.
 *
 * The hook is split out so both the all-in-one and per-widget overlay
 * clients can share the same lifecycle rules. A held randomizer reveal
 * gets its full window from ``randomizerAnchor`` (spin start or hold end).
 */
function useWidgetTimers({
  live,
  liveGame,
  session,
  setVisibleLive,
  setSessionVisible,
  randomizerAnchor,
  optionsRef,
}: {
  live: LiveGamePayload | null;
  liveGame: LiveGameEnvelope | null;
  session: SessionSummary | null;
  setVisibleLive: (updater: (prev: Set<WidgetId>) => Set<WidgetId>) => void;
  setSessionVisible: (visible: boolean) => void;
  randomizerAnchor: RandomizerWindowAnchor | null;
  optionsRef: RefObject<OverlayProfile["widgetOptions"]>;
}) {
  // Track all in-flight timeouts so we can cancel them on unmount AND
  // when a fresh payload supersedes the previous one. Per-widget
  // because a streamer queueing two games in quick succession should
  // re-arm each widget's timer from the new payload, not let the old
  // one fire mid-game.
  const liveTimers = useRef(new Map<WidgetId, number>());
  // Hide time of each armed timer, so a start window can be extended.
  const liveDeadlines = useRef(new Map<WidgetId, number>());
  const sessionTimer = useRef<number | null>(null);
  // Keep consumed starts on the overlay host, which outlives the timed
  // widgets. The bridge can briefly return to menu and resync the same
  // game after a card has hidden; that is still the original start.
  const consumedStarts = useRef(new Map<WidgetId, Set<string>>());
  const randomizerStartKey = useGameStartTriggerKey(live, liveGame);
  const scoutingStartKey = useScoutingStartTriggerKey(live, liveGame);
  const intel = liveIntelPayload(live, liveGame);
  const consumeStart = useCallback((id: WidgetId, key: string): boolean => {
    let keys = consumedStarts.current.get(id);
    if (!keys) {
      keys = new Set<string>();
      consumedStarts.current.set(id, keys);
    }
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  }, []);
  const scheduleHide = useCallback((id: WidgetId, deadline: number) => {
    const existing = liveTimers.current.get(id);
    if (existing !== undefined) window.clearTimeout(existing);
    const handle = window.setTimeout(() => {
      setVisibleLive((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      liveTimers.current.delete(id);
      liveDeadlines.current.delete(id);
    }, Math.max(0, deadline - Date.now()));
    liveTimers.current.set(id, handle);
    liveDeadlines.current.set(id, deadline);
  }, [setVisibleLive]);
  const armTimer = useCallback((id: WidgetId, isTest: boolean) => {
    const existing = liveTimers.current.get(id);
    if (existing !== undefined) window.clearTimeout(existing);
    liveTimers.current.delete(id);
    liveDeadlines.current.delete(id);
    const duration = resolveWidgetDurationMs(id, isTest, optionsRef.current);
    if (duration === null) return;
    scheduleHide(id, Date.now() + duration);
  }, [scheduleHide, optionsRef]);

  // Back-to-back queues can rotate keys without passing through menu.
  const liveGameKey =
    liveGame && typeof liveGame.gameKey === "string"
      ? liveGame.gameKey
      : null;
  // Opponent and randomizer can appear during loading. Scouting uses
  // its own confirmed-start key so loading cannot consume its window.
  const isActivePhase =
    !!liveGame
    && (liveGame.phase === "match_loading"
      || liveGame.phase === "match_started"
      || liveGame.phase === "match_in_progress");

  useEffect(() => {
    if (!live) return;
    const isTest = Boolean(live.isTest);
    // Widgets the live payload feeds — every widget except `session`,
    // which is driven off its own socket event.
    const liveWidgets: ReadonlyArray<WidgetId> = ALL_WIDGETS.filter((id) => {
      if (id === "session") return false;
      // Start widgets have their own persistent dedupe ledger. Replayed
      // payload objects and phase changes must not restart their timers.
      if (id === "randomizer" || id === "scouting") return false;
      return true;
    });
    const freshStarts = new Set<WidgetId>();
    for (const [id, key] of [
      ["scouting", scoutingStartKey],
      ["randomizer", randomizerStartKey],
    ] as const) {
      if (key && payloadTargetsWidget(live, id)
        && consumeStart(id, key)) {
        freshStarts.add(id);
        armTimer(id, isTest);
      }
    }
    setVisibleLive((prev) => {
      const next = new Set(liveWidgets);
      for (const id of ["scouting", "randomizer"] as const) {
        // Preserve an already-running start window on a duplicate, with
        // its original deadline. A real result closes the pre-game wave.
        if (freshStarts.has(id) || (prev.has(id) && (!live.result || isTest))) next.add(id);
      }
      return next;
    });
    for (const id of liveWidgets) {
      // While the bridge reports an active match phase, the opponent
      // widget pins through gameplay (see the liveGame effect below).
      // Skip arming a natural timer that would race the pin and hide
      // the widget mid-game — the pin is the source of truth until
      // ``match_ended`` clears it.
      if (id === "opponent" && isActivePhase) {
        const existing = liveTimers.current.get(id);
        if (existing !== undefined) window.clearTimeout(existing);
        liveTimers.current.delete(id);
        continue;
      }
      armTimer(id, isTest);
    }
  }, [live, isActivePhase, scoutingStartKey, randomizerStartKey, consumeStart, armTimer, setVisibleLive]);

  // Mirror the per-widget client's ``useWidgetVisibility`` for the
  // widgets that consume the agent's pre/in-game envelope. Without
  // this effect the all-in-one client would only ever render the
  // opponent + scouting cards in the 15s post-game window after a
  // ``live`` payload landed — the entire active phase of the *next*
  // match would render nothing because ``live`` is cleared by the
  // gameKey-change effect the moment the new loading screen arrives.
  // Pinning keeps the opponent identity chip on screen through gameplay.
  // Scouting and randomizer get one timed window per actual match key.
  useEffect(() => {
    if (!isActivePhase) return;
    // Opponent pins for the whole active phase — no natural timer.
    const oppTimer = liveTimers.current.get("opponent");
    if (oppTimer !== undefined) {
      window.clearTimeout(oppTimer);
      liveTimers.current.delete("opponent");
    }
    const freshStarts = new Set<WidgetId>();
    for (const [id, key] of [
      ["scouting", scoutingStartKey],
      ["randomizer", randomizerStartKey],
    ] as const) {
      if (key && payloadTargetsWidget(live, id)
        && consumeStart(id, key)) {
        freshStarts.add(id);
        armTimer(id, Boolean(live?.isTest));
      }
    }
    setVisibleLive((prev) => {
      const next = new Set(prev);
      next.add("opponent");
      for (const id of freshStarts) next.add(id);
      return next;
    });
  }, [isActivePhase, liveGameKey, scoutingStartKey, randomizerStartKey, live, consumeStart, armTimer, setVisibleLive]);

  // A held randomizer reveal runs its full window from the spin (or hold
  // end), not from when the match's start key first armed it.
  const anchorAtMs = randomizerAnchor?.key === randomizerStartKey
    ? randomizerAnchor.atMs
    : null;
  useEffect(() => {
    if (anchorAtMs === null) return;
    const deadline = liveDeadlines.current.get("randomizer");
    const duration = resolveWidgetDurationMs("randomizer", false, optionsRef.current);
    if (deadline === undefined || duration === null) return;
    const extended = extendStartWindow(deadline, anchorAtMs, duration, Date.now());
    if (extended !== deadline) scheduleHide("randomizer", extended);
  }, [anchorAtMs, randomizerStartKey, scheduleHide, optionsRef]);

  // The cloud already enriches active envelopes with these cards' data.
  // Open each card once when its content arrives, without restarting its
  // deadline on the agent's subsequent 1 Hz updates or reconnect replay.
  useEffect(() => {
    if (!scoutingStartKey || !liveGame || live?.isTest || intel?.result) return;
    const fresh = LIVE_INTEL_WIDGETS.filter((id) => hasLiveIntel(id, intel)
      && consumeStart(id, scoutingStartKey));
    if (!fresh.length) return;
    for (const id of fresh) armTimer(id, false);
    setVisibleLive((prev) => new Set([...prev, ...fresh]));
  }, [scoutingStartKey, liveGame, live, intel, consumeStart, armTimer, setVisibleLive]);

  useEffect(() => {
    if (!session) return;
    setSessionVisible(true);
    if (sessionTimer.current !== null) {
      window.clearTimeout(sessionTimer.current);
      sessionTimer.current = null;
    }
    const isTest = Boolean(session.isTest);
    const duration = resolveWidgetDurationMs("session", isTest, optionsRef.current);
    if (duration === null) return;
    sessionTimer.current = window.setTimeout(() => {
      setSessionVisible(false);
      sessionTimer.current = null;
    }, duration);
  }, [session, setSessionVisible, optionsRef]);

  // Drain any in-flight timers when the host component unmounts so
  // a fast scene swap in OBS doesn't leak timeouts past the lifetime
  // of the React tree.
  useEffect(() => {
    const liveTimerMap = liveTimers.current;
    const liveDeadlineMap = liveDeadlines.current;
    return () => {
      for (const handle of liveTimerMap.values()) {
        window.clearTimeout(handle);
      }
      liveTimerMap.clear();
      liveDeadlineMap.clear();
      if (sessionTimer.current !== null) {
        window.clearTimeout(sessionTimer.current);
        sessionTimer.current = null;
      }
    };
  }, []);
}
