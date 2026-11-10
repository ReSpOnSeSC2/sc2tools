"use strict";

const express = require("express");
const RateLimitModule = require("express-rate-limit");
const rateLimit = /** @type {any} */ (RateLimitModule).default || RateLimitModule;

/**
 * Web Push devices and the private coaching calendar feed
 * (docs/notifications.md).
 *
 *   GET    /me/push                       — {enabled, publicKey, groups, available, devices}
 *   POST   /me/push/subscriptions         — register this browser's PushSubscription
 *   DELETE /me/push/subscriptions/:id     — remove a device from the list
 *   POST   /me/push/unsubscribe           — {endpoint}: this browser turned push off
 *   PUT    /me/push/preferences           — {groups: string[]}
 *   POST   /me/push/test                  — send a test notification to every device
 *   POST   /push/subscription-change      — service worker rotation (old endpoint proves ownership)
 *   GET    /me/calendar-feed              — {active, createdAt}
 *   POST   /me/calendar-feed              — create or regenerate; the path is shown once
 *   DELETE /me/calendar-feed              — revoke
 *   GET    /calendar/<secret>.ics         — the feed itself (no session; secret in the path)
 *
 * Auth is per route so the two public endpoints can share this router.
 *
 * @param {{
 *   push: import('../services/pushNotifications').PushNotificationsService,
 *   calendar: import('../services/calendarFeed').CalendarFeedService,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildPushRouter(deps) {
  const router = express.Router();
  const limited = (/** @type {number} */ max, /** @type {(req: import('express').Request) => string} */ key) => rateLimit({
    windowMs: 60_000, max, standardHeaders: true, legacyHeaders: false, keyGenerator: key,
    message: { error: { code: "rate_limited", message: "Too many requests. Try again in a minute." } },
  });
  const feedLimit = limited(30, (req) => `${req.ip}:${String(req.params.file || "").slice(0, 12)}`);
  const rotateLimit = limited(20, (req) => String(req.ip));
  /** @param {(req: import('express').Request, owner: string) => Promise<unknown>} handler */
  const owned = (handler) => /** @type {import('express').RequestHandler} */ (async (req, res, next) => {
    try {
      res.set("Cache-Control", "private, no-store");
      res.json(await handler(req, requireUser(req)));
    } catch (err) { next(err); }
  });

  router.get("/me/push", deps.auth, owned((_req, owner) => deps.push.status(owner)));
  router.post("/me/push/subscriptions", deps.auth, owned((req, owner) => deps.push.subscribe(owner, body(req))));
  router.delete("/me/push/subscriptions/:id", deps.auth, owned((req, owner) => deps.push.removeDevice(owner, String(req.params.id))));
  router.post("/me/push/unsubscribe", deps.auth, owned((req, owner) => deps.push.unsubscribe(owner, body(req).endpoint)));
  router.put("/me/push/preferences", deps.auth, owned((req, owner) => deps.push.setGroups(owner, body(req).groups)));
  router.post("/me/push/test", deps.auth, owned((_req, owner) => deps.push.sendTest(owner)));
  router.post("/push/subscription-change", rotateLimit, async (req, res, next) => {
    try { res.set("Cache-Control", "no-store"); res.json(await deps.push.rotate(body(req))); } catch (err) { next(err); }
  });

  router.get("/me/calendar-feed", deps.auth, owned((_req, owner) => deps.calendar.status(owner)));
  router.post("/me/calendar-feed", deps.auth, owned((_req, owner) => deps.calendar.rotate(owner)));
  router.delete("/me/calendar-feed", deps.auth, owned((_req, owner) => deps.calendar.revoke(owner)));
  router.get("/calendar/:file", feedLimit, async (req, res, next) => {
    try {
      const match = /^([A-Za-z0-9_-]{43})\.ics$/.exec(String(req.params.file));
      const ics = match ? await deps.calendar.feed(match[1]) : null;
      res.set({ "Cache-Control": "private, max-age=300", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" });
      if (!ics) { res.status(404).type("text/plain").send("Calendar not found. The link may have been regenerated or turned off."); return; }
      res.set("Content-Disposition", "inline; filename=\"sc2tools-coaching.ics\"");
      res.type("text/calendar; charset=utf-8").send(ics);
    } catch (err) { next(err); }
  });
  return router;
}

/** @param {import('express').Request} req */
function body(req) {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
}

/** @param {import('express').Request} req */
function requireUser(req) {
  if (!req.auth || !req.auth.userId) throw Object.assign(new Error("auth_required"), { status: 401, code: "auth_required" });
  return req.auth.userId;
}

module.exports = { buildPushRouter };
