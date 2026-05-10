"use strict";

// Session-refresher worker.
//
// The session widget's "today" aggregate (W-L, MMR, region) is normally
// pushed to overlay sockets only at three points: on connect, on
// ``overlay:set_timezone``, and after every ``POST /v1/games`` ingest.
// That covers the busy path — a streamer who's actively queueing — but
// leaves a gap when the streamer steps away. The 4-hour-inactivity
// reset baked into ``GamesService.todaySession`` only takes effect when
// SOMETHING re-asks the service for a fresh aggregate. Without this
// worker the widget would happily sit on yesterday's "1W — 1L" past
// dawn until the streamer queues a new game (which is precisely when
// the reset is least useful).
//
// The worker walks every connected overlay socket on a fixed interval
// and re-emits ``overlay:session`` per socket. Per-tick caching keeps a
// streamer with multiple overlays (OBS + Streamlabs + a phone preview)
// from triggering N parallel Mongo aggregations for the same userId/tz
// pair. Best-effort: a single bad socket or a Mongo blip is logged
// and swallowed so the rest of the fan-out still completes.

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;

/**
 * @typedef {{
 *   start: () => void,
 *   stop: () => Promise<void>,
 *   isRunning: () => boolean,
 *   tickNow: () => Promise<number>,
 * }} SessionRefresherWorker
 */

/**
 * @param {{
 *   io: import('socket.io').Server | null | undefined,
 *   games: { todaySession: (userId: string, tz?: string) => Promise<any> } | null | undefined,
 *   intervalMs?: number,
 *   logger?: import('pino').Logger,
 * }} opts
 * @returns {SessionRefresherWorker}
 */
function buildSessionRefresher(opts) {
  const io = opts.io || null;
  const games = opts.games || null;
  const logger = opts.logger
    ? opts.logger.child({ component: "session_refresher" })
    : null;
  const intervalMs = clampInterval(opts.intervalMs);

  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  /** @type {Promise<number> | null} */
  let inFlight = null;

  function start() {
    if (timer) return;
    if (!io || !games) {
      if (logger) logger.info("session_refresher_disabled");
      return;
    }
    if (logger) logger.info({ intervalMs }, "session_refresher_started");
    timer = setInterval(() => {
      tickNow().catch(() => {});
    }, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  async function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        // tickNow already logged
      }
    }
  }

  function isRunning() {
    return timer !== null;
  }

  /**
   * Walk overlay sockets once and re-emit ``overlay:session``. Resolves
   * with the number of overlays that received an emit. Concurrent calls
   * coalesce onto the same in-flight promise so a slow tick can't pile
   * up overlapping fan-outs.
   *
   * @returns {Promise<number>}
   */
  function tickNow() {
    if (!io || !games) return Promise.resolve(0);
    if (inFlight) return inFlight;
    inFlight = runTick(io, games, logger).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return { start, stop, isRunning, tickNow };
}

/**
 * One pass over the overlay sockets. Pulled out of ``buildSessionRefresher``
 * so the closure stays under the per-function line cap and the work is
 * unit-testable in isolation.
 *
 * @param {import('socket.io').Server} io
 * @param {{ todaySession: (userId: string, tz?: string) => Promise<any> }} games
 * @param {import('pino').Logger | null} logger
 * @returns {Promise<number>}
 */
async function runTick(io, games, logger) {
  let emitted = 0;
  try {
    /** @type {any[]} */
    const sockets = await io.fetchSockets();
    // Per-tick (userId|tz) cache so multiple overlays for the same
    // streamer don't each round-trip Mongo. Cleared at the end of
    // the tick so a TZ change between ticks isn't masked.
    /** @type {Map<string, any>} */
    const cache = new Map();
    for (const socket of sockets) {
      const data = socket && socket.data;
      if (!data || data.kind !== "overlay") continue;
      const userId = data.overlayUserId;
      if (!userId || typeof userId !== "string") continue;
      const tz = typeof data.timezone === "string" ? data.timezone : "";
      const key = `${userId}|${tz}`;
      let session = cache.get(key);
      if (session === undefined) {
        try {
          session = await games.todaySession(userId, tz || undefined);
        } catch (err) {
          session = null;
          if (logger) {
            logger.warn(
              { err, userId },
              "session_refresher_resolve_failed",
            );
          }
        }
        cache.set(key, session);
      }
      if (session) {
        try {
          socket.emit("overlay:session", session);
          emitted += 1;
        } catch (err) {
          if (logger) {
            logger.warn(
              { err, userId },
              "session_refresher_emit_failed",
            );
          }
        }
      }
    }
    if (logger && emitted > 0) {
      logger.debug({ emitted }, "session_refresher_tick");
    }
  } catch (err) {
    if (logger) {
      logger.warn({ err }, "session_refresher_tick_failed");
    }
  }
  return emitted;
}

/**
 * @param {number|undefined} raw
 * @returns {number}
 */
function clampInterval(raw) {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_INTERVAL_MS;
  }
  return Math.max(MIN_INTERVAL_MS, Math.floor(raw));
}

module.exports = {
  buildSessionRefresher,
  __internal: { clampInterval, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS },
};
