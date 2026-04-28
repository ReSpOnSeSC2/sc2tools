"use strict";

const { HEADER } = require("../constants");
const { verifyHmac } = require("../util/hmac");
const { isValidClientId } = require("../util/ids");

/**
 * Build an HMAC auth middleware bound to a server pepper.
 * Must be mounted AFTER the body parser configured with `verify` to capture
 * the raw request body on `req.rawBody`.
 *
 * @param {Buffer} pepper
 * @returns {import('express').RequestHandler}
 */
function hmacAuth(pepper) {
  return function authMiddleware(req, res, next) {
    const clientId = req.header(HEADER.CLIENT_ID);
    const signature = req.header(HEADER.CLIENT_SIG);
    const failure = checkAuthHeaders(clientId, signature);
    if (failure) {
      res.status(401).json({ error: failure });
      return;
    }
    const body = req.rawBody !== undefined ? req.rawBody : Buffer.alloc(0);
    if (!verifyHmac({ pepper, body, signature: /** @type {string} */ (signature) })) {
      res.status(401).json({ error: "bad_signature" });
      return;
    }
    req.clientId = /** @type {string} */ (clientId).toLowerCase();
    next();
  };
}

/**
 * @param {string|undefined} clientId
 * @param {string|undefined} signature
 * @returns {string|null}
 */
function checkAuthHeaders(clientId, signature) {
  if (!clientId) return "missing_client_id";
  if (!signature) return "missing_signature";
  if (!isValidClientId(clientId)) return "bad_client_id";
  return null;
}

module.exports = { hmacAuth };
