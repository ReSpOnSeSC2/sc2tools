"use client";

import type { Socket } from "socket.io-client";

export type OverlayConnectionStatus = "connected" | "reconnecting";

const DEFAULT_HEARTBEAT_MS = 30_000;
// Socket.io reconnects most transient drops within a second or two;
// flipping the on-stream indicator instantly would make every OBS
// scene-switch flash a dot. Only report "reconnecting" after the drop
// has persisted past this debounce.
const DEFAULT_STATUS_DEBOUNCE_MS = 5_000;

/**
 * Attach the overlay socket's resilience behaviours — extracted from
 * the per-widget Browser Source client so the all-in-one overlay page
 * gets identical treatment (it previously had NONE of this and relied
 * solely on the server's connect-replay):
 *
 *  - emit ``overlay:resync`` on every (re-)connect, so a freshly
 *    reconnected client pulls the full current snapshot set (config,
 *    session, live envelope with synthetic prelude) in one round trip;
 *  - emit ``overlay:heartbeat`` every 30 s and compare the cloud's
 *    gameKey against ours — drift means events were silently dropped
 *    (the Streamlabs backgrounded-page failure mode) and triggers a
 *    resync;
 *  - surface a debounced connection status for a broadcast-safe
 *    "reconnecting" indicator.
 *
 * Call inside the same effect that creates the socket; the returned
 * cleanup clears the timers (the caller's ``socket.disconnect()``
 * retires the handlers with the socket).
 */
export function attachOverlayResilience(
  socket: Socket,
  opts: {
    /** Latest gameKey observed from live/liveGame payloads. */
    latestGameKey: () => string | null;
    /** Debounced connection-status reporter (for the on-stream dot). */
    onStatus?: (status: OverlayConnectionStatus) => void;
    heartbeatIntervalMs?: number;
    statusDebounceMs?: number;
  },
): () => void {
  const heartbeatMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
  const debounceMs = opts.statusDebounceMs ?? DEFAULT_STATUS_DEBOUNCE_MS;

  let statusTimer: number | null = null;
  const clearStatusTimer = () => {
    if (statusTimer != null) {
      window.clearTimeout(statusTimer);
      statusTimer = null;
    }
  };

  const reportConnected = () => {
    clearStatusTimer();
    opts.onStatus?.("connected");
  };

  socket.on("connect", () => {
    // ``connect`` fires for every successful (re-)connection,
    // including the first. Resync on first connect is safe — the
    // cloud emits the same data the initial connect replay would,
    // just slightly later.
    socket.emit("overlay:resync");
    reportConnected();
  });
  socket.on("reconnect", () => {
    // Some socket.io versions emit ``reconnect`` instead of
    // ``connect`` on a re-establishment; bind both to be safe.
    socket.emit("overlay:resync");
    reportConnected();
  });
  socket.on("disconnect", () => {
    if (!opts.onStatus) return;
    clearStatusTimer();
    statusTimer = window.setTimeout(() => {
      statusTimer = null;
      opts.onStatus?.("reconnecting");
    }, debounceMs);
  });

  // Heartbeat + gameKey drift detection. The cloud replies with
  // ``{gameKey, ts}``; a mismatch against our latest means envelopes
  // were dropped while the socket looked alive.
  //
  // Loop guard: resync AT MOST ONCE per distinct mismatched cloud
  // key. A resync replays the cloud's snapshots — if the keys STILL
  // disagree afterwards, the difference is structural (e.g. the
  // cached post-game payload is stamped with its gameId fallback
  // while the heartbeat advertises the envelope key), and repeating
  // the resync would re-fire the same widgets on stream every 30 s
  // forever. One attempt recovers every genuinely-missed-events case;
  // the guard resets when the keys agree or the cloud moves on to a
  // new game.
  let resyncedForCloudKey: string | null = null;
  const heartbeatInterval = window.setInterval(() => {
    // Emits while disconnected get buffered by socket.io and flushed
    // as a burst on reconnect — skip them; the connect handler's
    // resync already covers reconnection recovery. Only an explicit
    // ``false`` skips (test fakes may not define the property).
    if (socket.connected !== false) socket.emit("overlay:heartbeat");
  }, heartbeatMs);
  socket.on(
    "overlay:heartbeat",
    (reply: { gameKey?: string | null } | undefined) => {
      const cloudKey =
        reply && typeof reply.gameKey === "string" ? reply.gameKey : null;
      if (!cloudKey || cloudKey === opts.latestGameKey()) {
        resyncedForCloudKey = null;
        return;
      }
      if (resyncedForCloudKey === cloudKey) return;
      resyncedForCloudKey = cloudKey;
      socket.emit("overlay:resync");
    },
  );

  return () => {
    window.clearInterval(heartbeatInterval);
    clearStatusTimer();
  };
}
