"use strict";

const express = require("express");
const {
  PlatformIntegrationError,
  PLATFORMS,
} = require("../services/platformIntegrations");
const { WebhookVerificationError } = require("../services/platformWebhooks");

/**
 * Mixed-auth router: OAuth callbacks and signed webhooks are public; account
 * status/connect/disconnect use Clerk auth on the individual route.
 */
/**
 * @param {{
 *   auth: import('express').RequestHandler,
 *   integrations: import('../services/platformIntegrations').PlatformIntegrationsService,
 *   logger?: import('pino').Logger,
 *   returnUrl?: string,
 * }} deps
 */
function buildPlatformIntegrationsRouter(deps) {
  const router = express.Router();

  router.get("/me/integrations", deps.auth, async (req, res, next) => {
    try {
      const session = requireClerk(req);
      res.set("Cache-Control", "no-store");
      res.json(await deps.integrations.statuses(session.userId));
    } catch (err) {
      next(err);
    }
  });

  router.post("/me/integrations/:platform/connect", deps.auth, async (req, res, next) => {
    try {
      const session = requireClerk(req);
      const platform = parsePlatform(req.params.platform);
      res.set("Cache-Control", "no-store");
      res.json(await deps.integrations.begin(session.userId, platform));
    } catch (err) {
      next(err);
    }
  });

  router.delete("/me/integrations/:platform", deps.auth, async (req, res, next) => {
    try {
      const session = requireClerk(req);
      const platform = parsePlatform(req.params.platform);
      await deps.integrations.disconnect(session.userId, platform);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.get("/integrations/:platform/callback", async (req, res) => {
    res.set({
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    });
    let platform;
    try {
      platform = parsePlatform(req.params.platform);
      if (typeof req.query.error === "string" && req.query.error) {
        // Provider-denied callbacks do not reach ``complete``, so consume the
        // one-time state explicitly. This keeps a cancelled authorization from
        // remaining usable until its TTL while preserving the platform-bound
        // state check in the credential vault.
        await deps.integrations.abandonOauth(platform, req.query.state);
        throw new PlatformIntegrationError(
          400,
          "oauth_denied",
          "Authorization was cancelled or denied.",
        );
      }
      await deps.integrations.complete(platform, {
        code: req.query.code,
        state: req.query.state,
      });
      res.status(200).type("html").send(
        callbackPage(platform, true, "", deps.returnUrl),
      );
    } catch (err) {
      log(deps.logger, "warn", err, "official platform callback failed");
      const safePlatform = typeof platform === "string" && PLATFORMS.includes(platform)
        ? platform
        : "platform";
      const message = err instanceof PlatformIntegrationError
        ? err.message
        : "The connection could not be completed. Return to SC2 Tools and try again.";
      res.status(Number(/** @type {any} */ (err)?.status) || 400).type("html").send(
        callbackPage(safePlatform, false, message, deps.returnUrl),
      );
    }
  });

  router.post("/webhooks/twitch/eventsub", async (req, res, next) => {
    try {
      const result = await deps.integrations.handleTwitchWebhook(
        req.headers,
        /** @type {any} */ (req).rawBody,
      );
      sendWebhookResult(res, result);
    } catch (err) {
      if (err instanceof WebhookVerificationError) {
        res.status(403).json({ error: { code: err.code } });
        return;
      }
      next(err);
    }
  });

  router.post("/webhooks/kick/events", async (req, res, next) => {
    try {
      const result = await deps.integrations.handleKickWebhook(
        req.headers,
        /** @type {any} */ (req).rawBody,
      );
      sendWebhookResult(res, result);
    } catch (err) {
      if (err instanceof WebhookVerificationError) {
        res.status(403).json({ error: { code: err.code } });
        return;
      }
      next(err);
    }
  });

  return router;
}

/**
 * @param {import('express').Request} req
 * @returns {{userId:string,source:string}}
 */
function requireClerk(req) {
  if (!req.auth || req.auth.source !== "clerk") {
    throw new PlatformIntegrationError(
      403,
      "clerk_session_required",
      "Open this setting while signed in on the SC2 Tools website.",
    );
  }
  return /** @type {{userId:string,source:string}} */ (req.auth);
}

/** @param {unknown} value @returns {'twitch'|'kick'|'youtube'} */
function parsePlatform(value) {
  const platform = String(value || "").toLowerCase();
  if (!PLATFORMS.includes(/** @type {any} */ (platform))) {
    throw new PlatformIntegrationError(404, "platform_not_supported", "Unsupported platform");
  }
  return /** @type {'twitch'|'kick'|'youtube'} */ (platform);
}

/** @param {import('express').Response} res @param {{status?:number,body?:unknown,contentType?:string}} result */
function sendWebhookResult(res, result) {
  if (result?.contentType) res.type(result.contentType);
  if (result?.body !== undefined) {
    res.status(result.status || 200).send(result.body);
  } else {
    res.status(result?.status || 204).end();
  }
}

/**
 * @param {string} platform
 * @param {boolean} ok
 * @param {string} [detail]
 * @param {string} [returnUrl]
 */
function callbackPage(platform, ok, detail = "", returnUrl = "") {
  const label = platform === "youtube"
    ? "YouTube"
    : platform === "platform"
      ? "Platform"
      : `${platform[0].toUpperCase()}${platform.slice(1)}`;
  const title = ok ? `${label} connected` : `${label} was not connected`;
  const body = ok
    ? "SC2 Tools is now listening for supported notifications. You can close this window."
    : `${detail} You can close this window and retry from SC2 Tools.`;
  const safeReturnUrl = safeHttpsUrl(returnUrl);
  const returnLink = safeReturnUrl
    ? `<p><a href="${escapeHtml(safeReturnUrl)}">Return to SC2 Tools</a></p>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{margin:0;background:#090d18;color:#eaf2ff;font:16px system-ui;display:grid;min-height:100vh;place-items:center}.card{max-width:34rem;margin:2rem;padding:2rem;border:1px solid #26324a;border-radius:16px;background:#111827}h1{margin-top:0;color:${ok ? "#56e0c2" : "#ff8d8d"}}p{line-height:1.55;color:#b9c5d8}a{color:#56e0c2}</style></head><body><main class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>${returnLink}</main></body></html>`;
}

/** @param {unknown} value */
function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

/** @param {unknown} value */
function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * @param {import('pino').Logger|undefined} logger
 * @param {'warn'|'info'|'error'} level
 * @param {unknown} err
 * @param {string} message
 */
function log(logger, level, err, message) {
  try {
    logger?.[level]?.(
      { err: err instanceof Error ? err.name : "unknown" },
      message,
    );
  } catch {
    /* no-op */
  }
}

module.exports = {
  buildPlatformIntegrationsRouter,
  callbackPage,
  parsePlatform,
};
