"use strict";

const { verifyToken } = require("@clerk/backend");

/**
 * Authenticate Socket.io connections via Clerk JWT in `auth.token`.
 * On connect, the client joins room `user:<userId>`. Servers emit to
 * that room when an event for the user fires (e.g. games:changed).
 *
 * @param {import('socket.io').Server} io
 * @param {{secretKey: string, issuer?: string, audience?: string}} opts
 */
function attachSocketAuth(io, opts) {
  io.use(async (socket, next) => {
    try {
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
      next();
    } catch (err) {
      next(/** @type {Error} */ (err));
    }
  });

  io.on("connection", (socket) => {
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
