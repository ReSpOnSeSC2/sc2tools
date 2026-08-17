"use strict";

/**
 * Preserve raw JSON bytes only for signed webhook endpoints.
 *
 * ``express.json`` already holds its parse buffer temporarily. Assigning that
 * buffer to every request kept a second, raw representation alive for the
 * entire replay-ingest transaction even though only Svix signature
 * verification needs it. A full resync can send multi-megabyte bodies, so the
 * unconditional reference multiplied memory use under concurrency.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} _res
 * @param {Buffer} buf
 */
function captureSignedWebhookRawBody(req, _res, buf) {
  const path = String(req.originalUrl || req.url || "").split("?", 1)[0];
  if (
    path === "/v1/webhooks/clerk"
    || path === "/v1/webhooks/twitch/eventsub"
    || path === "/v1/webhooks/kick/events"
  ) {
    /** @type {any} */ (req).rawBody = buf;
  }
}

// Keep the old export name for focused tests and downstream imports.
const captureClerkWebhookRawBody = captureSignedWebhookRawBody;

module.exports = { captureSignedWebhookRawBody, captureClerkWebhookRawBody };
