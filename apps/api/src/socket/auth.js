"use strict";

const { verifyToken } = require("@clerk/backend");
const { sha256 } = require("../util/hash");

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
 * }} opts
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
    socket.on("subscribe:user", (userId) => {
      if (typeof userId === "string" && userId.length > 0) {
        socket.join(`user:${userId}`);
      }
    });
  });
}

module.exports = { attachSocketAuth };
