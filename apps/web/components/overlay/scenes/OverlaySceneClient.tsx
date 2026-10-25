"use client";

/**
 * OverlaySceneClient — data feed for the full-canvas backdrop scenes.
 *
 * A deliberately thin sibling of ``OverlayWidgetClient``. That
 * component carries thirty widgets, a visibility timer, voice readout,
 * ghost-build state and post-game merge logic; a backdrop needs none
 * of it. Reimplementing the three subscriptions it *does* need is a
 * fraction of the code — and, more to the point, keeps a source that
 * runs for the entire broadcast off the heaviest client in the app.
 *
 * Three real inputs, no mock data. Anything we don't actually know
 * simply isn't rendered:
 *
 *   1. ``overlay:liveGame`` — the agent's pre/in-game envelope. Drives
 *      the race accent from the live opponent, and tells us when a
 *      match is running.
 *   2. ``overlay:live``     — the cloud's post-game payload. Also
 *      carries ``oppRace``, and outlives the envelope after a match.
 *   3. ``overlay:multichat``— the Stream Dock's studio state, so the
 *      existing "Starting soon" / "BRB" buttons drive this backdrop
 *      exactly the way they already drive ``StreamSceneWidget``.
 *
 * A ``?demo=1`` escape hatch renders a sample accent + countdown so
 * the Settings preview and the offline render script have something
 * to show. It is opt-in and never reachable from a real game.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useOverlayProfile, type OverlayProfileConfig } from "@/lib/useOverlayProfile";
import type { OverlayTheme } from "@/lib/overlayTheme";
import { attachOverlayResilience, createOverlaySocket, hasActiveOverlayGame, type OverlayConnectionStatus } from "../overlayResilience";
import { OverlayCheckBadge, OverlaySetupCard } from "../OverlaySetupCard";
import { ReconnectDot } from "../ReconnectDot";
import { useStudioState } from "@/lib/multichat/useStudioState";
import type {
  LiveGameEnvelope,
  LiveGamePayload,
} from "@/components/overlay/types";
import { useOverlayBuildRefresh } from "@/components/overlay/useOverlayBuildRefresh";
import {
  SC2BackdropScene,
  accentForRace,
  DEFAULT_BACKDROP_ACCENT,
  VARIANT_LAYOUT,
  type BackdropVariant,
} from "./SC2BackdropScene";
import { OverlayCredit } from "../OverlayCredit";
import { CinematicBackgroundScene } from "./CinematicBackgroundScene";
import { STUDIO_SCENE_HEADLINES } from "@/lib/multichat/sceneModes";
import { StreamSceneCanvas } from "../widgets/StreamSceneWidget";
import { useBrollAudioOwner } from "../widgets/brollAudio";
import {
  isStreamBackgroundId,
  type StreamBackgroundId,
} from "@/lib/streamBackgrounds";

/**
 * ``manual`` is the transparent-until-selected cover used by the OBS
 * scene builder. Unlike the named backdrop variants, it renders no pixels
 * while the Stream Dock is Live and becomes a full-canvas Starting Soon / BRB
 * scene only after the streamer explicitly presses one of those buttons.
 */
type DockDrivenSceneVariant = BackdropVariant | "manual";
export type OverlaySceneVariant = DockDrivenSceneVariant | StreamBackgroundId;

/** Countdown repaint cadence. 4 Hz is smooth enough for MM:SS. */
const TICK_MS = 250;

/**
 * Sample countdown for ``?demo=1``. A frozen value, not a running
 * clock, for two reasons:
 *
 *   - the Settings preview is captioned "sample values" — the real
 *     number comes from the Stream Dock, and
 *   - ``scripts/render-scene.mjs`` exports its seamless MP4 loop
 *     through this same flag. A ticking clock would leave frame 0 and
 *     frame N showing different digits and put a visible jump at the
 *     loop seam.
 *
 * It also means demo mode arms no timer and schedules no repaints.
 */
const DEMO_COUNTDOWN_MS = 5 * 60_000;

export function OverlaySceneClient({
  token,
  scene,
  staticMode = false,
  demo = false,
  showCredit = true,
  themeParam = null,
}: {
  token: string;
  scene: OverlaySceneVariant;
  staticMode?: boolean;
  demo?: boolean;
  /**
   * "Overlay by sc2tools.com" on the full-canvas Starting Soon / BRB /
   * Intermission cards (never on the Between Games frame, a virtual set,
   * or the transparent manual cover). Off for ``?credit=0``.
   */
  showCredit?: boolean;
  themeParam?: string | null;
}) {
  // Virtual sets are deliberately independent of live-game and Stream Dock
  // state. Their named URL always paints the same camera backdrop and opens no
  // socket or polling loop, which makes seven long-lived OBS sources cheap.
  if (isStreamBackgroundId(scene)) {
    return <CinematicBackgroundScene backgroundId={scene} />;
  }

  return (
    <DockDrivenOverlaySceneClient
      key={token}
      token={token}
      scene={scene}
      staticMode={staticMode}
      demo={demo}
      showCredit={showCredit}
      themeParam={themeParam}
    />
  );
}

type DockSceneProps = { token: string; scene: DockDrivenSceneVariant; staticMode: boolean; demo: boolean; showCredit: boolean; themeParam?: string | null };
function DockDrivenOverlaySceneClient(props: DockSceneProps) {
  const { themeVars, theme, receiveProfile } = useOverlayProfile(props.token, props.themeParam);
  return <div data-overlay-scene-frame style={themeVars as CSSProperties}><DockDrivenSceneContent {...props} theme={theme} receiveProfile={receiveProfile} /></div>;
}
function DockDrivenSceneContent({ token, scene, staticMode, demo, showCredit, theme, receiveProfile }: DockSceneProps & { theme: OverlayTheme; receiveProfile: (message: OverlayProfileConfig) => void }) {
  const [liveGame, setLiveGame] = useState<LiveGameEnvelope | null>(null);
  const [live, setLive] = useState<LiveGamePayload | null>(null);
  const [studioEvent, setStudioEvent] = useState<unknown>(null);
  const [connectionStatus, setConnectionStatus] = useState<OverlayConnectionStatus>("connecting");
  const gameKeyRef = useRef<string | null>(null);
  const brollAudioOwner = useBrollAudioOwner();

  useEffect(() => {
    if (demo) return;
    setLiveGame(null); setLive(null); setStudioEvent(null); gameKeyRef.current = null;
    const connection = createOverlaySocket(token, { surface: "scene", widget: scene, onStatus: setConnectionStatus });
    const socket = connection.socket;
    socket.on("overlay:config", receiveProfile);
    const detachResilience = attachOverlayResilience(socket, { latestGameKey: () => gameKeyRef.current });

    socket.on("overlay:liveGame", (msg: LiveGameEnvelope) => {
      if (!msg || typeof msg !== "object") return;
      if (typeof msg.gameKey === "string") gameKeyRef.current = msg.gameKey;
      // idle/menu mean "no game" — drop the accent back to stock
      // rather than leaving the last opponent's race tinting an empty
      // downtime screen.
      if (msg.phase === "idle" || msg.phase === "menu") {
        setLiveGame(null);
        return;
      }
      setLiveGame(msg);
    });

    socket.on("overlay:live", (msg: LiveGamePayload) => {
      if (!msg || typeof msg !== "object") return;
      if (typeof msg.gameKey === "string") gameKeyRef.current = msg.gameKey;
      setLive(msg);
    });

    socket.on("overlay:multichat", (msg: unknown) => setStudioEvent(msg));

    return () => {
      detachResilience();
      socket.removeAllListeners();
      connection.dispose();
    };
  }, [token, demo, scene, receiveProfile]);

  // Demo renders sample values and never consults the dock, so there
  // is nothing for the studio poll to feed.
  const studio = useStudioState(token, studioEvent, { enabled: !demo });

  // The dock's scene buttons win over the URL's variant: the streamer
  // pressed a button just now, and that is a more recent statement of
  // intent than whatever the Browser Source URL was set to weeks ago.
  const dockScene = demo ? null : studio.scene;
  useOverlayBuildRefresh({
    enabled: scene === "manual" && !demo,
    safeToReload: !dockScene,
  });
  const fallbackVariant: BackdropVariant =
    scene === "manual" ? "starting-soon" : scene;
  const variant: BackdropVariant = fallbackVariant;

  const accent = useMemo(() => {
    if (theme.accent) return theme.accent;
    if (demo) return accentForRace("zerg");
    const race = liveGame?.opponent?.race ?? live?.oppRace ?? null;
    return race ? accentForRace(race) : DEFAULT_BACKDROP_ACCENT;
  }, [demo, liveGame?.opponent?.race, live?.oppRace, theme.accent]);

  // Only a real dock countdown ticks, and only while it is on screen.
  //
  // Deriving this from ``Date.now()`` during a demo render would hand
  // the effect below a brand-new deadline on every single render: it
  // would tear down and re-arm the interval each time, call setState
  // from the effect, and re-render — a self-feeding loop one slow
  // frame away from React's "Maximum update depth exceeded". A
  // constant is both correct for a sample value and cheap.
  const countdownEndsAt = demo ? null : (dockScene?.countdownEndsAt ?? null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (countdownEndsAt == null) return;
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, [countdownEndsAt]);

  const countdownMs = demo
    ? DEMO_COUNTDOWN_MS
    : countdownEndsAt == null
      ? null
      : Math.max(0, countdownEndsAt - nowMs);

  // The builder places this source above every camera, capture and widget in
  // each scene it creates. It therefore has to be genuinely transparent while
  // Live: hiding just the headline would still leave an opaque backdrop over
  // the broadcast. Demo mode intentionally shows Starting Soon so Settings can
  // preview the otherwise-invisible source.
  if (!demo && (connectionStatus === "invalid" || connectionStatus === "replaced")) return <><OverlaySetupCard reason={connectionStatus === "replaced" ? "replaced" : "invalid-token"} /><OverlayCheckBadge status={connectionStatus} /></>;
  const checkBadge = <OverlayCheckBadge status={demo ? "connected" : connectionStatus} live={hasActiveOverlayGame(liveGame)} />;
  if (scene === "manual" && !demo && !dockScene) {
    return (
      <>{checkBadge}{connectionStatus === "reconnecting" ? <ReconnectDot /> : null}<div
        aria-hidden="true"
        data-variant="manual-inactive"
        style={{ width: "100vw", height: "100vh", background: "transparent" }}
      /></>
    );
  }

  // The agent-created horizontal layouts use ``/scene/manual`` as their
  // topmost Stream Dock cover, while vertical canvases use the standalone
  // ``/widget/stream-scene`` source. Once the Dock activates either BRB or
  // Starting Soon, always route the manual source through the exact same
  // canvas. Keeping even the empty-library fallback on this shared path means
  // the two OBS copies cannot silently diverge because one render took the
  // legacy SC2 backdrop branch before its b-roll snapshot arrived.
  if (scene === "manual" && !demo && dockScene) {
    return (
      <>
        {checkBadge}
        {connectionStatus === "reconnecting" ? <ReconnectDot /> : null}
        <StreamSceneCanvas
          scene={dockScene}
          broll={studio.broll}
          remainMs={countdownMs}
          brollAudioOwner={brollAudioOwner}
          videoFormat="horizontal"
        />
        <OverlayCredit placement="bottom-center" visible={showCredit} />
      </>
    );
  }

  return (
    <>
      {checkBadge}
      {connectionStatus === "reconnecting" ? <ReconnectDot /> : null}
      <SC2BackdropScene
        variant={variant}
        headline={dockScene ? STUDIO_SCENE_HEADLINES[dockScene.mode] : undefined}
        layout={dockScene ? "full" : undefined}
        accent={accent}
        message={dockScene?.message || null}
        countdownMs={countdownMs}
        staticMode={staticMode}
      />
      <OverlayCredit placement="bottom-center" visible={backdropCreditVisible(showCredit, variant)} />
    </>
  );
}

/**
 * Only the full-canvas cards (Starting Soon / BRB / Intermission) carry the
 * credit: the Between Games frame sits behind the streamer's camera and
 * stays unbranded.
 */
function backdropCreditVisible(showCredit: boolean, variant: BackdropVariant): boolean {
  return showCredit && VARIANT_LAYOUT[variant] === "full";
}
