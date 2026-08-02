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

import { useEffect, useMemo, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { API_BASE } from "@/lib/clientApi";
import { clientTimezone } from "@/lib/timeseries";
import { useStudioState } from "@/lib/multichat/useStudioState";
import type {
  LiveGameEnvelope,
  LiveGamePayload,
} from "@/components/overlay/types";
import {
  SC2BackdropScene,
  accentForRace,
  DEFAULT_BACKDROP_ACCENT,
  type BackdropVariant,
} from "./SC2BackdropScene";

/** Countdown repaint cadence. 4 Hz is smooth enough for MM:SS. */
const TICK_MS = 250;

export function OverlaySceneClient({
  token,
  scene,
  staticMode = false,
  demo = false,
}: {
  token: string;
  scene: BackdropVariant;
  staticMode?: boolean;
  demo?: boolean;
}) {
  const [liveGame, setLiveGame] = useState<LiveGameEnvelope | null>(null);
  const [live, setLive] = useState<LiveGamePayload | null>(null);
  const [studioEvent, setStudioEvent] = useState<unknown>(null);

  useEffect(() => {
    if (demo) return;
    const socket: Socket = io(API_BASE, {
      // The Browser Source carries no Clerk session; the overlay token
      // is the auth. Same contract as OverlayWidgetClient.
      auth: { overlayToken: token, timezone: clientTimezone() },
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
    });

    socket.on("overlay:liveGame", (msg: LiveGameEnvelope) => {
      if (!msg || typeof msg !== "object") return;
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
      setLive(msg);
    });

    socket.on("overlay:multichat", (msg: unknown) => setStudioEvent(msg));

    return () => {
      socket.removeAllListeners();
      socket.close();
    };
  }, [token, demo]);

  const studio = useStudioState(token, studioEvent);

  // The dock's scene buttons win over the URL's variant: the streamer
  // pressed a button just now, and that is a more recent statement of
  // intent than whatever the Browser Source URL was set to weeks ago.
  const dockScene = demo ? null : studio.scene;
  const variant: BackdropVariant = dockScene
    ? dockScene.mode === "brb"
      ? "brb"
      : "starting-soon"
    : scene;

  const accent = useMemo(() => {
    if (demo) return accentForRace("zerg");
    const race = liveGame?.opponent?.race ?? live?.oppRace ?? null;
    return race ? accentForRace(race) : DEFAULT_BACKDROP_ACCENT;
  }, [demo, liveGame?.opponent?.race, live?.oppRace]);

  // Only tick while a countdown is actually on screen.
  const countdownEndsAt = demo
    ? Date.now() + 5 * 60_000
    : (dockScene?.countdownEndsAt ?? null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (countdownEndsAt == null) return;
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, [countdownEndsAt]);

  const countdownMs =
    countdownEndsAt == null ? null : Math.max(0, countdownEndsAt - nowMs);

  return (
    <SC2BackdropScene
      variant={variant}
      accent={accent}
      message={dockScene?.message || null}
      countdownMs={countdownMs}
      staticMode={staticMode}
    />
  );
}
