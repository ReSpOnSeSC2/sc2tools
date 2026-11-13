"use strict";

const express = require("express");

/**
 * "Post to Discord" settings (docs/notifications.md). Owner-only; the
 * webhook URL goes in once (POST body, never logged or sent to Sentry)
 * and never comes back out.
 *
 *   GET    /me/integrations/discord                    — {available, maxHooks, hooks}
 *   POST   /me/integrations/discord/hooks              — {url, label}: connect (off until enabled)
 *   PATCH  /me/integrations/discord/hooks/:id          — {label?, events?, options?, enabled?}
 *   DELETE /me/integrations/discord/hooks/:id
 *   POST   /me/integrations/discord/hooks/:id/test     — post a connection test now
 *   POST   /me/integrations/discord/hooks/:id/battle-report — queue a reviewed, shared report
 *   POST   /me/integrations/discord/hooks/:id/preview  — {kind?}: render posts; required before enabling
 *
 * @param {{discord: import('../services/discordWebhooks').DiscordWebhooksService, auth: import('express').RequestHandler}} deps
 */
function buildDiscordRouter(deps) {
  const router = express.Router();
  /** @param {(req: import('express').Request, owner: string) => Promise<unknown>} handler */
  const owned = (handler) => /** @type {import('express').RequestHandler} */ (async (req, res, next) => {
    try {
      res.set("Cache-Control", "private, no-store");
      const owner = req.auth && req.auth.userId;
      if (!owner) throw Object.assign(new Error("auth_required"), { status: 401, code: "auth_required" });
      res.json(await handler(req, owner));
    } catch (err) { next(err); }
  });
  /** @param {import('express').Request} req */
  const body = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});
  /** @param {(req: import('express').Request, owner: string) => Promise<unknown>} handler */
  const browserOwned = (handler) => owned(async (req, owner) => {
    if (req.auth?.source !== "clerk") {
      throw Object.assign(new Error("Sign in on the website to manage Discord posts."), { status: 403, code: "browser_session_required" });
    }
    return handler(req, owner);
  });
  const base = "/me/integrations/discord";
  router.get(base, deps.auth, owned((_req, owner) => deps.discord.list(owner)));
  router.post(`${base}/hooks`, deps.auth, browserOwned((req, owner) => deps.discord.create(owner, body(req))));
  router.patch(`${base}/hooks/:id`, deps.auth, browserOwned((req, owner) => deps.discord.update(owner, String(req.params.id), body(req))));
  router.delete(`${base}/hooks/:id`, deps.auth, browserOwned((req, owner) => deps.discord.remove(owner, String(req.params.id))));
  router.post(`${base}/hooks/:id/test`, deps.auth, browserOwned((req, owner) => deps.discord.test(owner, String(req.params.id))));
  router.post(`${base}/hooks/:id/preview`, deps.auth, browserOwned((req, owner) => deps.discord.preview(owner, String(req.params.id), body(req).kind)));
  router.post(`${base}/hooks/:id/battle-report`, deps.auth, browserOwned((req, owner) =>
    deps.discord.queueBattleReport(owner, String(req.params.id), body(req))));
  return router;
}

module.exports = { buildDiscordRouter };
