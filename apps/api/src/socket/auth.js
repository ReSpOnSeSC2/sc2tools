"use strict";

const { verifyToken } = require("@clerk/backend");
const { sha256 } = require("../util/hash");
const { updatePlaybackJob } = require("../services/replayPlaybackJobs");
const { scoutingDeviceRoom } = require("../services/agentScouting");
const { overlayHandshakeDescriptor } = require("../services/overlayPresence");

/** Min interval (ms) between accepted ``overlay:resync`` requests on
 * one socket. Tighter than 2 s would let a misbehaving client trigger
 * a Mongo aggregation per tick; looser would feel laggy when the
 * streamer manually refreshes. The 2 s figure is the spec floor. */
const RESYNC_MIN_INTERVAL_MS = 2000;

/** Randomizer roll reports one overlay socket may send per window. The
 * service separately caps accepted writes per user and live game. */
const ROLL_REPORTS_PER_WINDOW = 10;
const ROLL_REPORT_WINDOW_MS = 60_000;

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
 *   * ``overlay:multichat`` — persisted Stream Dock state (one-shot on
 *     connect / resync, with live updates broadcast elsewhere).
 *   * ``overlay:liveGame`` — replayed once on overlay connect /
 *     resync from ``LiveGameBroker.replayLatestForOverlay``;
 *     prepended by a ``synthetic: true`` ``match_loading`` prelude
 *     when the cached envelope is past the loading screen so the
 *     client's gameKey-change effect always has a chance to fire.
 *   * ``overlay:live`` — replayed once on overlay connect / resync
 *     from ``LiveGameBroker.latestOverlayLive`` (the post-game
 *     payload built by ``OverlayLiveService.buildFromGame``).
 *   * ``overlay:buildIntent`` — build check-in state of the current live
 *     game, ``{ gameKey, suppressRandomizer, holdRemainingMs }`` (never a
 *     build key or name), replayed on connect (before ``overlay:config``)
 *     and on resync via ``resolveBuildIntent``.
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
 *   * ``overlay:randomizer:rolled`` — ``{ gameKey, buildId }`` reported by
 *     the randomizer widget at spin time; handed to ``onRandomizerRolled``
 *     (which validates everything) at most 10 times a minute per socket.
 *
 * @param {import('socket.io').Server} io
 * @param {{
 *   secretKey: string,
 *   issuer?: string,
 *   audience?: string,
 *   resolveOverlayToken?: (token: string) => Promise<{userId: string, label: string, enabledWidgets?: string[],profile?:unknown,profileRevision?:number}|null>,
 *   isOverlayTokenReplaced?: (token:string) => Promise<boolean>,
 *   validateOverlayToken?: (userId: string, token: string) => Promise<boolean>,
 *   resolveDeviceToken?: (tokenHash: string) => Promise<{userId: string, deviceId?: string}|null>,
 *   resolveSession?: (userId: string, timezone?: string) => Promise<{
 *     wins: number, losses: number, games: number,
 *     mmrStart?: number, mmrCurrent?: number,
 *   }>,
 *   resolveVoicePrefs?: (userId: string) => Promise<Record<string, unknown> | null>,
 *   resolveRandomizerPrefs?: (userId: string) => Promise<Record<string, unknown> | null>,
 *   resolveGhostPrefs?: (userId: string) => Promise<Record<string, unknown> | null>,
 *   resolveStudioState?: (token: string) => Promise<Record<string, unknown> | null>,
 *   resolveSeries?: (token: string, owner: string) => Promise<Record<string, unknown> | null>,
 *   resolvePlatformEvents?: (userId: string) => Promise<Array<Record<string, unknown>>>,
 *   resolveLiveSnapshot?: (userId: string) => {
 *     prelude?: object|null,
 *     envelope?: object|null,
 *     overlayLive?: object|null,
 *     gameKey?: string|null,
 *   } | null,
 *   resolveBuildIntent?: (userId: string) => Promise<{
 *     gameKey: string,
 *     suppressRandomizer: boolean,
 *     holdRemainingMs: number,
 *   } | null>,
 *   onRandomizerRolled?: (userId: string, token: string, payload: unknown) => Promise<void>|void,
 *   resolveClerkUser?: (clerkUserId: string) => Promise<{userId: string}|null>,
 *   isAdminClerkId?: (clerkUserId: string) => boolean,
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
          next(new Error(await opts.isOverlayTokenReplaced?.(overlayToken) ? "overlay_token_replaced" : "invalid_overlay_token"));
          return;
        }
        socket.data.overlayToken = overlayToken;
        socket.data.overlayUserId = hit.userId;
        socket.data.kind = "overlay";
        socket.data.overlayPresence = overlayHandshakeDescriptor(socket.handshake?.auth);
        socket.data.overlayControlOnly = socket.handshake?.auth?.controlOnly === true;
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
        // Stable pairing identity survives reconnects; never expose bearer hashes.
        socket.data.deviceId = hit.deviceId;
        socket.data.obsAddSource = {
          supported: socket.handshake.auth.obsAddSource?.supported === true,
          enabled: socket.handshake.auth.obsAddSource?.enabled === true,
        };
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
        } catch {
          // Resolution failures are non-fatal for public/clerk-room events,
          // but the socket must not be allowed to claim a private user room.
        }
      }
      next();
    } catch (err) {
      next(/** @type {Error} */ (err));
    }
  });

  io.on("connection", (socket) => {
    if (socket.data.kind === "overlay") {
      socket.data.overlayConnectedAt = Date.now();
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
            /** @type {{ enabledWidgets?: string[], voicePrefs?: Record<string, unknown>, randomizer?: Record<string, unknown>,ghost?:Record<string, unknown>,profile?:unknown,profileRevision?:number }} */
            const config = {};
            if (Array.isArray(info.enabledWidgets)) {
              config.enabledWidgets = info.enabledWidgets;
            }
            if (info.profile) { config.profile = info.profile; config.profileRevision = info.profileRevision ?? 0; }
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
            if (opts.resolveRandomizerPrefs) {
              try {
                const prefs = await opts.resolveRandomizerPrefs(info.userId);
                if (prefs && typeof prefs === "object") {
                  config.randomizer = prefs;
                }
              } catch {
                // Randomizer prefs are optional — a missing config just
                // means the OBS widget stays dormant for this streamer.
              }
            }
            // The randomizer cannot spin before ``overlay:config``; sending
            // the check-in state first keeps a declared game's reveal from
            // flashing on a reconnect.
            if (opts.resolveBuildIntent) {
              await replayOverlayBuildIntent(socket, opts.resolveBuildIntent, info.userId);
            }
            if (opts.resolveGhostPrefs) {
              try {
                const ghost = await opts.resolveGhostPrefs(info.userId);
                if (ghost) config.ghost = ghost;
              } catch { /* Optional; legacy fragment URLs still work. */ }
            }
            if (socket.connected === false) return;
            if (config.enabledWidgets || config.voicePrefs || config.randomizer || config.profile || config.ghost) {
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
      // Stream Dock state normally arrives as a live socket broadcast. Replay
      // its persisted snapshot on every Browser Source connection as well, so
      // a source that was offline when Starting Soon / BRB (or Go live) was
      // pressed cannot reveal stale content until the next safety poll.
      if (t && opts.resolveStudioState) {
        replayOverlayStudioState(socket, opts.resolveStudioState, t);
      }
      if (t && u && opts.resolveSeries) replayOverlaySeries(socket, opts.resolveSeries, t, u);
      if (u && opts.resolvePlatformEvents) {
        replayOverlayPlatformEvents(socket, opts.resolvePlatformEvents, u);
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
      socket.on("overlay:resync", async () => {
        const now = Date.now();
        const last =
          typeof socket.data.lastResyncMs === "number"
            ? socket.data.lastResyncMs
            : 0;
        if (now - last < RESYNC_MIN_INTERVAL_MS) return;
        socket.data.lastResyncMs = now;
        const userId = socket.data.overlayUserId;
        if (!userId) return;
        // The token may have been revoked after this socket's handshake. Use
        // the fresh ownership validator when the production service provides
        // one (rather than its short-lived resolve cache), and fail closed on
        // lookup errors. The revoke route also disconnects the room promptly;
        // this check protects cross-process sockets and disconnect races.
        let stillValid = false;
        try {
          if (t && opts.validateOverlayToken) {
            stillValid = await opts.validateOverlayToken(userId, t);
          } else if (t && opts.resolveOverlayToken) {
            const current = await opts.resolveOverlayToken(t);
            stillValid = current?.userId === userId;
          }
        } catch {
          // Do not replay private state while token validity is unknown. Keep
          // the socket connected so a transient database issue can recover.
          return;
        }
        if (!stillValid) {
          try {
            socket.disconnect(true);
          } catch {
            // A raced transport close is already equivalent to disconnect.
          }
          return;
        }
        if (socket.connected === false) return;
        if (opts.resolveGhostPrefs) {
          try {
            const ghost = await opts.resolveGhostPrefs(userId);
            if (ghost && !socket.disconnected) socket.emit("overlay:config", { ghost });
          } catch { /* A later reconnect/resync can recover. */ }
        }
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
        if (t && opts.resolveStudioState) {
          replayOverlayStudioState(socket, opts.resolveStudioState, t);
        }
        if (t && opts.resolveSeries) replayOverlaySeries(socket, opts.resolveSeries, t, userId);
        if (opts.resolvePlatformEvents) {
          replayOverlayPlatformEvents(socket, opts.resolvePlatformEvents, userId);
        }
        if (opts.resolveBuildIntent) {
          void replayOverlayBuildIntent(socket, opts.resolveBuildIntent, userId);
        }
      });
      // Build check-in: the randomizer widget reports a real spin. The
      // handler re-validates the token, the live game, the matchup pool and
      // the build server-side; this only bounds per-socket volume.
      socket.on(
        "overlay:randomizer:rolled",
        /** @param {unknown} payload */
        (payload) => {
          const userId = socket.data.overlayUserId;
          if (!userId || !t || !opts.onRandomizerRolled) return;
          if (!takeRollReportSlot(socket)) return;
          const onRolled = opts.onRandomizerRolled;
          Promise.resolve()
            .then(() => onRolled(userId, t, payload))
            .catch(() => {
              // Roll reports are advisory; a failure only loses the roll.
            });
        },
      );
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
      if (u) {
        socket.join(`user:${u}`);
        socket.join(scoutingDeviceRoom(u));
      }
      socket.on("obs:capabilities", (payload) => {
        socket.data.obsAddSource = { supported: payload?.supported === true, enabled: payload?.enabled === true };
      });
      socket.on("map-playback:status", (payload) => {
        if (!u || !payload || typeof payload.gameId !== "string" || typeof payload.requestId !== "string") return;
        // A device can only update an existing request in its authenticated
        // user's namespace. Request IDs reject stale or unsolicited updates.
        if (updatePlaybackJob(u, payload.gameId, payload.requestId, payload, socket.id)) {
          io.to(`user:${u}`).emit("map-playback:status", payload);
        }
      });
      // The agent emits this once per startup so the cloud can mark
      // the device as "online" and surface that in the dashboard.
      socket.emit("device:hello", { ok: true });
      return;
    }
    const cid = socket.data.clerkUserId;
    if (cid) socket.join(`clerk:${cid}`);
    // Admin live-event subscription. ``admin:event`` payloads
    // (user signups + agent downloads) are broadcast to the
    // ``admin`` Socket.io room by AdminEventsService; joining only
    // sockets whose Clerk user id is on the allowlist keeps the
    // fan-out scoped to actual admins.
    if (cid && typeof opts.isAdminClerkId === "function") {
      try {
        if (opts.isAdminClerkId(cid)) socket.join("admin");
      } catch {
        // Never let the admin check crash the connect loop —
        // worst case the socket just doesn't receive admin events.
      }
    }
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
    // resolved userId we lock the join down to the caller's own id. The
    // legacy free-form join exists only when no resolver was configured at
    // all; a production resolver failure must fail closed.
    socket.on("subscribe:user", (userId) => {
      if (typeof userId !== "string" || userId.length === 0) return;
      if (typeof resolvedUserId === "string" && resolvedUserId.length > 0) {
        if (userId !== resolvedUserId) return;
        socket.join(`user:${userId}`);
        return;
      }
      if (!opts.resolveClerkUser) socket.join(`user:${userId}`);
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

/**
 * Per-socket budget for ``overlay:randomizer:rolled`` reports.
 * @param {{ data: Record<string, any> }} socket
 * @returns {boolean}
 */
function takeRollReportSlot(socket) {
  const now = Date.now();
  const windowStart = typeof socket.data.rollReportWindowStart === "number"
    ? socket.data.rollReportWindowStart
    : 0;
  if (now - windowStart >= ROLL_REPORT_WINDOW_MS) {
    socket.data.rollReportWindowStart = now;
    socket.data.rollReportCount = 0;
  }
  const count = Number(socket.data.rollReportCount || 0);
  if (count >= ROLL_REPORTS_PER_WINDOW) return false;
  socket.data.rollReportCount = count + 1;
  return true;
}

/**
 * Replay the build check-in state of the current live game. Never throws;
 * a lookup failure just leaves the widget on its own short timeout.
 *
 * @param {{emit: (event: string, payload: unknown) => unknown}} socket
 * @param {(userId: string) => Promise<{gameKey: string, suppressRandomizer: boolean, holdRemainingMs: number}|null>} resolveBuildIntent
 * @param {string} userId
 * @returns {Promise<void>}
 */
async function replayOverlayBuildIntent(socket, resolveBuildIntent, userId) {
  try {
    const state = await resolveBuildIntent(userId);
    if (state && typeof state === "object") socket.emit("overlay:buildIntent", state);
  } catch {
    // See above.
  }
}

/**
 * Replay the current Stream Dock snapshot without blocking or failing the
 * socket connection. The live broadcast remains the fast path; this closes
 * the gap when a Browser Source reconnects after missing a manual scene
 * change.
 *
 * @param {{emit: (event: string, payload: unknown) => unknown}} socket
 * @param {(token: string) => Promise<Record<string, unknown> | null>} resolveStudioState
 * @param {string} token
 */
function replayOverlayStudioState(socket, resolveStudioState, token) {
  Promise.resolve()
    .then(() => resolveStudioState(token))
    .then((state) => {
      if (!state || typeof state !== "object") return;
      socket.emit("overlay:multichat", state);
    })
    .catch(() => {
      // The client's GET + slow poll remain as a fallback. Studio state must
      // never make an otherwise healthy overlay socket fail to connect.
    });
}

/** Series snapshots have monotonic revisions, including manual controls and
 * new Start, so a held bootstrap cannot overwrite a newer live event.
 * @param {{data:Record<string,any>,connected?:boolean,emit:(event:string,payload:unknown)=>unknown}} socket
 * @param {(token:string,owner:string)=>Promise<Record<string,unknown>|null>} resolve
 * @param {string} token @param {string} owner */
function replayOverlaySeries(socket, resolve, token, owner) {
  Promise.resolve().then(() => resolve(token, owner)).then(series => {
    if (socket.connected !== false && socket.data.overlayToken === token && socket.data.overlayUserId === owner) socket.emit("overlay:series", series);
  }).catch(() => {});
}

/**
 * @param {{emit:(event:string,payload:unknown)=>unknown}} socket
 * @param {(userId:string)=>Promise<Array<Record<string,unknown>>>} resolvePlatformEvents
 * @param {string} userId
 */
function replayOverlayPlatformEvents(socket, resolvePlatformEvents, userId) {
  Promise.resolve()
    .then(() => resolvePlatformEvents(userId))
    .then((events) => {
      if (!Array.isArray(events)) return;
      for (const event of events) {
        if (event && typeof event === "object") {
          socket.emit("overlay:platformEvent", event);
        }
      }
    })
    .catch(() => {
      // Live webhook fan-out remains healthy if replay storage is unavailable.
    });
}

module.exports = {
  attachSocketAuth,
  replayOverlayPlatformEvents,
  RESYNC_MIN_INTERVAL_MS,
  ROLL_REPORTS_PER_WINDOW,
};
