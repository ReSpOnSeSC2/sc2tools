"use strict";

const express = require("express");
const rateLimitModule = require("express-rate-limit");
const {
  EVENT_TYPES,
  MESSAGE_SUBJECT_MAX,
  MESSAGE_BODY_MAX,
} = require("../services/adminEvents");

// express-rate-limit ships as either a default or a named export
// depending on the bundler/version — mirror app.js's resolution.
const rateLimit =
  /** @type {any} */ (rateLimitModule).default || rateLimitModule;

/**
 * /v1/messages — let a signed-in user send a bug report / message to
 * the site admins. The message is persisted as a ``user_message``
 * admin event so it lands in the same /admin/notifications inbox
 * (unread, real-time, "mark all read") as signups and downloads — no
 * separate collection or admin surface required.
 *
 * Identity (userId, clerkUserId, email) is attached server-side from
 * the auth context; the client only supplies subject + message.
 *
 * @param {{
 *   adminEvents: import('../services/adminEvents').AdminEventsService,
 *   users: import('../services/users').UsersService,
 *   auth: import('express').RequestHandler,
 *   maxPerWindow?: number,
 * }} deps
 */
function buildMessagesRouter(deps) {
  const router = express.Router();

  // Per-user cap so a single account can't flood the admin inbox.
  // 5 messages / 10 min is generous for genuine bug
  // reports while making spam impractical. Sits on top of the global
  // per-minute limiter installed in app.js. Configurable so deploys
  // (and tests) can tune it; defaults to 5.
  // ``Number.isFinite``'s lib signature returns a plain boolean (not a
  // type guard), so TS can't narrow ``deps.maxPerWindow`` through it;
  // probe via a number-typed view. The runtime guard is unchanged —
  // ``Number.isFinite(undefined)`` is false, so the default still
  // applies when the knob isn't injected.
  const rawMaxPerWindow = /** @type {number} */ (deps.maxPerWindow);
  const maxPerWindow =
    Number.isFinite(rawMaxPerWindow) && rawMaxPerWindow > 0
      ? rawMaxPerWindow
      : 5;
  const sendLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: maxPerWindow,
    standardHeaders: true,
    legacyHeaders: false,
    // The auth middleware (mounted above) 401s every unauthenticated
    // request before it reaches this limiter, so req.auth.userId is
    // always present — key on it so the cap is per-account, and skip
    // express-rate-limit's IP-based key path entirely.
    keyGenerator: (/** @type {import('express').Request} */ req) =>
      /** @type {NonNullable<typeof req.auth>} */ (req.auth).userId,
    handler: (
      /** @type {import('express').Request} */ _req,
      /** @type {import('express').Response} */ res,
    ) => {
      res.status(429).json({
        error: {
          code: "rate_limited",
          message:
            "You've sent several messages recently. Please wait a few minutes and try again.",
        },
      });
    },
  });

  router.use("/messages", deps.auth);

  router.post("/messages", sendLimiter, async (req, res, next) => {
    try {
      const auth = requireAuth(req);
      const { subject, message } = normalizeBody(req.body);

      if (!subject) {
        throw badRequest("A subject is required.");
      }
      if (subject.length > MESSAGE_SUBJECT_MAX) {
        throw badRequest(
          `Subject must be ${MESSAGE_SUBJECT_MAX} characters or fewer.`,
        );
      }
      if (!message) {
        throw badRequest("A message is required.");
      }
      if (message.length > MESSAGE_BODY_MAX) {
        throw badRequest(
          `Message must be ${MESSAGE_BODY_MAX} characters or fewer.`,
        );
      }

      // Resolve the sender's cached email so the admin row shows who to
      // reply to. Best-effort: a missing summary still records the
      // message with the ids we already have on the auth context.
      let email = null;
      try {
        const summary = await deps.users.getSummary(auth.userId);
        email = summary && summary.email ? summary.email : null;
      } catch {
        email = null;
      }

      const doc = await deps.adminEvents.record(EVENT_TYPES.USER_MESSAGE, {
        userId: auth.userId,
        clerkUserId: auth.clerkUserId || null,
        email,
        subject,
        message,
      });

      res.status(201).json({ ok: true, eventId: doc ? doc.eventId : null });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** @param {unknown} body */
function normalizeBody(body) {
  // Untrusted request body: hold it as a string-keyed record of
  // unknowns; the ``typeof`` checks below stay the runtime gate.
  const src = /** @type {Record<string, unknown>} */ (
    body && typeof body === "object" ? body : {}
  );
  return {
    subject: typeof src.subject === "string" ? src.subject.trim() : "",
    message: typeof src.message === "string" ? src.message.trim() : "",
  };
}

/** @param {string} message */
function badRequest(message) {
  const err = new Error(message);
  /** @type {any} */ (err).status = 400;
  /** @type {any} */ (err).code = "bad_request";
  return err;
}

/** @param {import('express').Request} req */
function requireAuth(req) {
  if (!req.auth) {
    const err = new Error("auth_required");
    /** @type {any} */ (err).status = 401;
    throw err;
  }
  return req.auth;
}

module.exports = { buildMessagesRouter };
