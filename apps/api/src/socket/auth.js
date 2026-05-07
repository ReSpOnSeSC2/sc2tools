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
 *    can be broadcast to one specific overlay.
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
      // Push the per-token config (enabled widgets) so the overlay can
      // immediately hide widgets the user disabled, without waiting for
      // the next pre-game payload.
      if (t && opts.resolveOverlayToken) {
        opts
          .resolveOverlayToken(t)
          .then((info) => {
            if (info && Array.isArray(info.enabledWidgets)) {
              socket.emit("overlay:config", {
                enabledWidgets: info.enabledWidgets,
              });
            }
          })
          .catch(() => {});
      }
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
