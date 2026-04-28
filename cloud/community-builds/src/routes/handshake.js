"use strict";

const { Router } = require("express");
const { SERVICE } = require("../constants");

/**
 * Handshake: returns the server pepper as hex so a client can begin signing
 * requests. NOTE: in a real deployment this should be wrapped behind a
 * shared install key or TLS-pinned bootstrap; for v1 the value rotates
 * with each deploy and is treated as a known shared secret.
 *
 * @param {Buffer} serverPepper
 * @returns {import('express').Router}
 */
function buildHandshakeRouter(serverPepper) {
  const router = Router();
  router.get("/handshake", (_req, res) => {
    res.json({
      service: SERVICE.NAME,
      version: SERVICE.VERSION,
      pepperHex: serverPepper.toString("hex"),
      algorithm: "HMAC-SHA256",
    });
  });
  return router;
}

module.exports = { buildHandshakeRouter };
