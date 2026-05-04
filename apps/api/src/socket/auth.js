"use strict";

const { verifyToken } = require("@clerk/backend");

/**
 * Authenticate Socket.io connections. Two flavours of caller:
 *
 *  - **Web app** sends `auth.token = <Clerk JWT>` and joins the
 *    private user room (so `games:changed` ticks live).
 *  - **OBS overlay** sends `auth.overlayToken = <token>`. The token IS
 *    the auth — there's no Clerk session on a Browser Source. The
 *    socket joins `overlay:<token>` so the agent's live-parse payload
 *    can be broadcast to one specific overlay.
 *
 * @param {import('socket.io').Server} io
 * @param {{
 *   secretKey: string,
 *   issuer?: string,
 *   audience?: string,
 *   resolveOverlayToken?: (token: string) => Promise<{userId: string, label: string, enabledWidgets?: string[]}|null>,
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
