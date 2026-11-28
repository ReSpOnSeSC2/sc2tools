"use strict";

/**
 * The raid finder's HTTP surface, mounted on the Twitch automation router so it
 * shares that router's Stream Dock token check and rate limiter.
 *
 *   GET /me/twitch-raids               Settings: gates, permission, switch (Clerk only)
 *   PUT /me/twitch-raids               Settings: { enabled }
 *   GET /multichat/:token/raids        Dock: ranked channels, state and history
 *   POST /multichat/:token/raids       Dock: { action: "start", streamId } or { action: "cancel" }, confirmed
 */

/** @typedef {import('express').RequestHandler} Handler */

/**
 * @param {import('express').Router} router
 * @param {{ raids: import('../services/twitchRaids').TwitchRaidsService, auth: Handler,
 *   tokens: import('../services/overlayTokens').OverlayTokensService, tokenAuth: Handler,
 *   limiter: (lane: string, max: number, windowMs: number) => Handler }} deps
 */
function mountRaidRoutes(router, { raids, auth, tokens, tokenAuth, limiter }) {
  /** @type {Handler} */
  const clerkOnly = (req, res, next) => {
    if (req.auth?.source !== "clerk") { res.status(403).json({ error: { code: "clerk_required" } }); return; }
    next();
  };
  router.get("/me/twitch-raids", auth, clerkOnly, limiter("raid-settings", 12, 60_000), async (req, res, next) => {
    try { res.json(await raids.settingsView(String(req.auth?.userId))); } catch (error) { next(error); }
  });
  router.put("/me/twitch-raids", auth, clerkOnly, limiter("raid-settings-save", 8, 60_000), async (req, res, next) => {
    try { res.json(await raids.saveSettings(String(req.auth?.userId), req.body)); } catch (error) { next(error); }
  });
  router.get("/multichat/:token/raids", tokenAuth, limiter("raid-view", 12, 60_000), async (_req, res, next) => {
    try { res.json(await raids.dockView(res.locals.twitchOwner)); } catch (error) { next(error); }
  });
  router.post("/multichat/:token/raids", tokenAuth, limiter("raid-action", 6, 60_000), async (req, res, next) => {
    try {
      const body = req.body;
      const valid = body && body.confirmed === true && Object.keys(body).every(key => ["action", "streamId", "confirmed"].includes(key))
        && (body.action === "cancel" && body.streamId === undefined || body.action === "start" && typeof body.streamId === "string" && /^twitch:[0-9]{1,30}$/.test(body.streamId));
      if (!valid) { res.status(400).json({ error: { code: "invalid_raid_action", message: "Confirm Start raid or Cancel raid." } }); return; }
      const result = await tokens.withWrite(String(req.params.token), async () => {
        const owner = await tokens.resolve(String(req.params.token));
        if (!owner || owner.userId !== res.locals.twitchOwner) throw Object.assign(new Error("Overlay token changed."), { status: 401, code: "invalid_overlay_token" });
        return body.action === "start" ? raids.start(owner.userId, body.streamId) : raids.cancel(owner.userId);
      });
      res.json({ result, ...(await raids.dockView(res.locals.twitchOwner)) });
    } catch (error) { next(error); }
  });
}

module.exports = { mountRaidRoutes };
