"use strict";

const { verifyToken } = require("@clerk/backend");
const { sha256 } = require("../util/hash");

/** Min interval (ms) between accepted ``overlay:resync`` requests on
 * one socket. Tighter than 2 s would let a misbehaving client trigger
 * a Mongo aggregation per tick; looser would feel laggy when the
 * streamer manually refreshes. The 2 s figure is the spec floor. */
const RESYNC_MIN_INTERVAL_MS = 2000;

/**
 * Authenticate Socket.io connections. Three flavours of caller:
 *
 *  - **Web app** sends `auth.token = <Clerk JWT>` and joins the
 *    private user room (so `games:changed` ticks live).
 *  - **OBS overlay** sends `auth.overlayToken = <token>`. The token IS
 *    the auth — there's no Clerk session on a Browser Source. The
 *    socket joins `overlay:<token>` so the agent's live-parse payload
 *    can be broadcast to one specific overlay. The handshake may also
 *    carry an `auth.timezone` IANA tz string so the cloud-driven
 *    session widget anchors "today" to the streamer's wall clock.
 *  - **Desktop agent** sends `auth.deviceToken = <token>`. The token
 *    is the same long-lived value used for REST `Authorization:
 *    Bearer …` calls; the cloud joins the agent into `user:<userId>`
 *    so per-game recompute events (`macro:recompute_request`,
 *    `opp_build_order:recompute_request`) reach the right machine
 *    without requiring the agent to poll.
 *
 * **Overlay events emitted by this module:**
 *
 *   * ``overlay:config`` — per-token enabled-widgets + voice prefs
 *     (one-shot on connect / resync).
 *   * ``overlay:session`` — today's W-L aggregate (one-shot on
 *     connect / set_timezone / resync).
 *   * ``overlay:liveGame`` — replayed once on overlay connect /
 *     resync from ``LiveGameBroker.replayLatestForOverlay``;
 *     prepended by a ``synthetic: true`` ``match_loading`` prelude
 *     when the cached envelope is past the loading screen so the
 *     client's gameKey-change effect always has a chance to fire.
 *   * ``overlay:live`` — replayed once on overlay connect / resync
 *     from ``LiveGameBroker.latestOverlayLive`` (the post-game
 *     payload built by ``OverlayLiveService.buildFromGame``).
 *   * ``overlay:heartbeat`` — reply to a client-initiated
 *     ``overlay:heartbeat`` ping. Carries
 *     ``{ gameKey: string|null, ts: number }`` so the client can
 *     detect a disagreement (different gameKey or ``ts`` drift) and
 *     trigger an ``overlay:resync``. Idempotent.
 *
 * **Overlay events received by this module:**
 *
 *   * ``overlay:set_timezone`` — late-binding tz from
 *     ``Intl.DateTimeFormat`` once the page renders.
 *   * ``overlay:resync`` — client-driven re-emit request. Fired on
 *     reconnect or when the heartbeat reveals a gameKey drift.
 *     Rate-limited to once per 2 s per socket.
 *   * ``overlay:heartbeat`` — periodic 30 s ping from the client.
 *     The cloud responds with the broker's current gameKey.
 *
 * @param {import('socket.io').Server} io
 * @param {{
 *   secretKey: string,
 *   issuer?: string,
 *   audience?: string,
 *   resolveOverlayToken?: (token: string) => Promise<{userId: string, label: string, enabledWidgets?: string[]}|null>,
 *   resolveDeviceToken?: (tokenHash: string) => Promise<{userId: string}|null>,
 *   resolveSession?: (userId: string, timezone?: string) => Promise<{
 *     wins: number, losses: number, games: number,
 *     mmrStart?: number, mmrCurrent?: number,
 *   }>,
 *   resolveVoicePrefs?: (userId: string) => Promise<Record<string, unknown> | null>,
 *   resolveLiveSnapshot?: (userId: string) => {
 *     prelude?: object|null,
 *     envelope?: object|null,
 *     overlayLive?: object|null,
 *     gameKey?: string|null,
 *   } | null,
 *   resolveClerkUser?: (clerkUserId: string) => Promise<{userId: string}|null>,
 * }} opts
 *
 * ``resolveClerkUser`` (web flavour, optional but recommended): maps a
 * Clerk session ``sub`` to the internal ``userId``. When provided, the
 * web handshake resolves it during auth and auto-joins ``user:<userId>``
 * on connect — so games:changed / import:progress / macro:recompute_request
 * fan-outs reach the right tab without the client having to claim the
 * user id itself. Also locks down ``subscribe:user`` to the resolved
 * id (the legacy free-form join survives only when this resolver is
 * not wired, for backward compatibility with the bare-bones test setups).
 */
function attachSocketAuth(io, opts) {
  io.use(async (socket, next) => {
    try {
      const overlayToken = socket.handshake?.auth?.overlayToken;
      if (overlayToken && typeof overlayToken === "string") {
        if (!opts.resolveOverlayToken) {
          next(new Error("overlay_unsupported"));
          return;
        }
        const hit = await opts.resolveOverlayToken(overlayToken);
        if (!hit) {
          next(new Error("invalid_overlay_token"));
          return;
        }
        socket.data.overlayToken = overlayToken;
        socket.data.overlayUserId = hit.userId;
        socket.data.kind = "overlay";
        // Stash the OBS Browser Source's IANA timezone so the
        // session-widget aggregation can anchor "today" to the
        // streamer's wall clock. Defaults to UTC at the
        // service-method layer when missing or malformed.
        const tz = socket.handshake?.auth?.timezone;
        if (typeof tz === "string" && tz.length > 0 && tz.length <= 64) {
          socket.data.timezone = tz;
        }
        next();
        return;
      }

      const deviceToken = socket.handshake?.auth?.deviceToken;
      if (deviceToken && typeof deviceToken === "string") {
        if (!opts.resolveDeviceToken) {
          next(new Error("device_unsupported"));
          return;
        }
        const tokenHash = sha256(deviceToken);
        const hit = await opts.resolveDeviceToken(tokenHash);
        if (!hit) {
          next(new Error("invalid_device_token"));
          return;
        }
        socket.data.userId = hit.userId;
        socket.data.kind = "device";
        next();
        return;
      }

      const token = socket.handshake?.auth?.token;
      if (!token || typeof token !== "string") {
        next(new Error("missing_token"));
        return;
      }
      const claims = await verifyToken(
        token,
        /** @type {any} */ ({
          secretKey: opts.secretKey,
          ...((opts.issuer ? { issuer: opts.issuer } : {})),
          ...((opts.audience ? { audience: opts.audience } : {})),
        }),
      );
      if (!claims || !claims.sub) {
        next(new Error("invalid_token"));
        return;
      }
      socket.data.clerkUserId = claims.sub;
      socket.data.kind = "web";
      // Resolve internal userId in the handshake so the connect handler
      // can auto-join ``user:<userId>`` without an async hop. Same
      // ``ensureFromClerk`` semantics as the REST middleware so a
      // brand-new sign-in lands a user document and a stable userId
      // before any per-user fan-out (games:changed, import:progress,
      // macro:recompute_request) can race the lookup.
      if (opts.resolveClerkUser) {
        try {
          const hit = await opts.resolveClerkUser(claims.sub);
          if (hit && typeof hit.userId === "string" && hit.userId.length > 0) {
            socket.data.userId = hit.userId;
          }
        } catch (_err) {
          // Resolution failures are non-fatal: the socket still
          // connects, the client can fall back to subscribe:user.
        }
      }
      next();
    } catch (err) {
      next(/** @type {Error} */ (err));
    }
  });

  io.on("connection", (socket) => {
    if (socket.data.kind === "overlay") {
      const t = socket.data.overlayToken;
      const u = socket.data.overlayUserId;
      if (t) socket.join(`overlay:${t}`);
      if (u) socket.join(`user:${u}`);
      // Push the per-token config (enabled widgets + voice prefs) so
      // the overlay can immediately hide disabled widgets and prime its
      // voice-readout layer without waiting for the next pre-game
      // payload. Voice prefs are stored on the user document, not the
      // overlay token, so we resolve them in parallel and merge.
      if (t && opts.resolveOverlayToken) {
        opts
          .resolveOverlayToken(t)
          .then(async (info) => {
            if (!info) return;
            /** @type {{ enabledWidgets?: string[], voicePrefs?: Record<string, unknown> }} */
            const config = {};
            if (Array.isArray(info.enabledWidgets)) {
              config.enabledWidgets = info.enabledWidgets;
            }
            if (opts.resolveVoicePrefs) {
              try {
                const prefs = await opts.resolveVoicePrefs(info.userId);
                if (prefs && typeof prefs === "object") {
                  config.voicePrefs = prefs;
                }
              } catch {
                // Voice prefs are optional — never fail the connect on
                // a preferences-table miss.
              }
            }
            if (config.enabledWidgets || config.voicePrefs) {
              socket.emit("overlay:config", config);
            }
          })
          .catch(() => {});
      }
      // Cloud-driven session card. The session-record widget shows
      // today's W-L (and MMR delta when myMmr is populated on game
      // rows) and is derived purely from cloud-stored games — so it
      // works whether or not the local agent is currently posting
      // pre/post-game live events. Push the latest aggregate as soon
      // as the overlay socket connects so OBS isn't staring at a blank
      // panel waiting for the first ``overlay:live`` to arrive.
      if (u && opts.resolveSession) {
        opts
          .resolveSession(u, socket.data.timezone)
          .then((session) => {
            if (session) socket.emit("overlay:session", session);
          })
          .catch(() => {});
      }
      // Replay the latest live state to the freshly-connected overlay.
      // Without this, a Browser Source that reconnects mid-match
      // (transient network blip; OBS scene swap; Streamlabs page
      // refresh) would sit on a blank panel until the agent's next
      // poll tick — up to 1 s for in-progress, indefinitely for the
      // post-game ``overlay:live`` payload (which only emits on
      // ingest). The synthetic prelude in ``replayLatestForOverlay``
      // ensures the gameKey-change effect on the client fires even
      // when the original ``match_loading`` event was missed.
      if (u && opts.resolveLiveSnapshot) {
        replayOverlayLiveSnapshot(socket, opts.resolveLiveSnapshot, u);
      }
      // Allow OBS to refresh its tz late (e.g. after detecting it via
      // ``Intl.DateTimeFormat().resolvedOptions().timeZone`` on first
      // render). We honour it for the very next session emission.
      socket.on(
        "overlay:set_timezone",
        /** @param {unknown} tz */
        (tz) => {
          if (
            typeof tz === "string"
            && tz.length > 0
            && tz.length <= 64
            && opts.resolveSession
            && socket.data.overlayUserId
          ) {
            socket.data.timezone = tz;
            opts
              .resolveSession(socket.data.overlayUserId, tz)
              .then((session) => {
                if (session) socket.emit("overlay:session", session);
              })
              .catch(() => {});
          }
        },
      );
      // Client-driven resync. Fired on socket reconnect, on Browser
      // Source page reload, or when the heartbeat reveals a gameKey
      // drift. Rate-limited so a misbehaving client can't trigger a
      // Mongo aggregation per tick.
      socket.on("overlay:resync", () => {
        const now = Date.now();
        const last =
          typeof socket.data.lastResyncMs === "number"
            ? socket.data.lastResyncMs
            : 0;
        if (now - last < RESYNC_MIN_INTERVAL_MS) return;
        socket.data.lastResyncMs = now;
        const userId = socket.data.overlayUserId;
        if (!userId) return;
        if (opts.resolveSession) {
          opts
            .resolveSession(userId, socket.data.timezone)
            .then((session) => {
              if (session) socket.emit("overlay:session", session);
            })
            .catch(() => {});
        }
        if (opts.resolveLiveSnapshot) {
          replayOverlayLiveSnapshot(socket, opts.resolveLiveSnapshot, userId);
        }
      });
      // 30-second heartbeat the client uses to detect when its cached
      // gameKey has drifted from the cloud's view (e.g. Streamlabs
      // held the page from getting fresh socket events). The reply is
      // unconditional so a client can't be left wondering whether its
      // ping landed; the client compares its own ``liveGame.gameKey``
      // against the reply and triggers a resync on mismatch.
      socket.on("overlay:heartbeat", () => {
        const userId = socket.data.overlayUserId;
        let gameKey = null;
        if (userId && opts.resolveLiveSnapshot) {
          try {
            const snap = opts.resolveLiveSnapshot(userId);
            gameKey = snap && typeof snap.gameKey === "string"
              ? snap.gameKey
              : null;
          } catch {
            gameKey = null;
          }
        }
        socket.emit("overlay:heartbeat", { gameKey, ts: Date.now() });
      });
      return;
    }
    if (socket.data.kind === "device") {
      const u = socket.data.userId;
      if (u) socket.join(`user:${u}`);
      // The agent emits this once per startup so the cloud can mark
      // the device as "online" and surface that in the dashboard.
      socket.emit("device:hello", { ok: true });
      return;
    }
    const cid = socket.data.clerkUserId;
    if (cid) socket.join(`clerk:${cid}`);
    // Auto-join the resolved user room so cloud-emitted events like
    // ``games:changed`` reach this tab without the client having to
    // claim its own userId. The dashboard's auto-refresh on ingest
    // depends on this room membership — see
    // ``apps/web/lib/useUserSocket.ts``.
    const resolvedUserId = socket.data.userId;
    if (typeof resolvedUserId === "string" && resolvedUserId.length > 0) {
      socket.join(`user:${resolvedUserId}`);
    }
    // ``subscribe:user`` predates ``resolveClerkUser`` and let any
    // authenticated web client join any user room. When we DO have a
    // resolved userId we lock the join down to the caller's own id;
    // when we don't, we keep the legacy free-form join so tests and
    // tiny deployments without the resolver wired still work.
    socket.on("subscribe:user", (userId) => {
      if (typeof userId !== "string" || userId.length === 0) return;
      if (
        typeof resolvedUserId === "string"
        && resolvedUserId.length > 0
        && userId !== resolvedUserId
      ) {
        return;
      }
      socket.join(`user:${userId}`);
    });
  });
}

/**
 * Pull the broker's latest snapshot for ``userId`` and replay each
 * non-null piece to the supplied socket. Order matters:
 *
 *   1. ``overlay:liveGame`` synthetic prelude — clears stale ``live``
 *      via the gameKey-change effect.
 *   2. ``overlay:liveGame`` cached envelope — the agent's most recent
 *      pre/in-game state.
 *   3. ``overlay:live`` cached post-game payload — the most recent
 *      replay-derived dossier (when one exists).
 *
 * Synchronous (the resolver returns the broker's in-memory snapshot)
 * so a slow Mongo path can't starve the connect / resync flow.
 *
 * @param {{emit: (event: string, payload: unknown) => unknown}} socket
 * @param {(userId: string) => {
 *   prelude?: object|null,
 *   envelope?: object|null,
 *   overlayLive?: object|null,
 *   gameKey?: string|null,
 * }|null} resolveLiveSnapshot
 * @param {string} userId
 */
function replayOverlayLiveSnapshot(socket, resolveLiveSnapshot, userId) {
  let snap;
  try {
    snap = resolveLiveSnapshot(userId) || null;
  } catch {
    snap = null;
  }
  if (!snap) return;
  if (snap.prelude) {
    try {
      socket.emit("overlay:liveGame", snap.prelude);
    } catch {
      /* defensive — emit must not crash the connect loop */
    }
  }
  if (snap.envelope) {
    try {
      socket.emit("overlay:liveGame", snap.envelope);
    } catch {
      /* defensive — see above */
    }
  }
  if (snap.overlayLive) {
    try {
      socket.emit("overlay:live", snap.overlayLive);
    } catch {
      /* defensive — see above */
    }
  }
}

module.exports = { attachSocketAuth, RESYNC_MIN_INTERVAL_MS };
