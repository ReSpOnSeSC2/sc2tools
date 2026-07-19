"use strict";

const express = require("express");
const rateLimitModule = require("express-rate-limit");

const rateLimit =
  /** @type {any} */ (rateLimitModule).default || rateLimitModule;

const {
  YoutubeChatError,
  resolveLiveChat,
  pollLiveChat,
} = require("../services/youtubeLiveChat");
const {
  KickResolveError,
  resolveKickChatroom,
} = require("../services/kickChannel");
const {
  sanitizeChatAppearance,
  sanitizeChatTts,
  sanitizeChatSound,
} = require("../services/multichatAppearance");

/**
 * /v1/multichat/:token/* — relays for the multi-platform chat overlay
 * widget.
 *
 * Auth model: the overlay token IS the auth (path segment), exactly
 * like the overlay socket — the OBS Browser Source carries no Clerk
 * session. Every route resolves the token first; a revoked/unknown
 * token 401s before any upstream traffic happens.
 *
 * Twitch and Kick chat connect straight from the browser (public
 * WebSocket endpoints) — no API involvement. These routes cover the
 * two platforms a browser cannot reach directly:
 *   - YouTube (no CORS on the innertube chat endpoints): stateless
 *     resolve + poll relay; the widget owns the polling loop.
 *   - TikTok (signed webcast websocket): server-held connection fanned
 *     out over SSE.
 * Plus:
 *   - config: the widget reads the streamer's saved platform config
 *     (written by the Clerk-authed settings page via
 *     /v1/me/preferences/multichat).
 *   - kick/resolve: one-time slug → chatroom-id lookup at setup time.
 *
 * @param {{
 *   overlayTokens: { resolve: (token: string) => Promise<{userId: string} | null> },
 *   users: { getPreferences: (userId: string, type: string) => Promise<Record<string, any>> },
 *   tiktokRelay: import('../services/tiktokChatRelay').TikTokChatRelay,
 *   studio: import('../services/multichatStudio').MultichatStudioService,
 *   sounds?: import('../services/multichatSounds').MultichatSoundsService,
 *   engagement?: import('../services/multichatEngagement').MultichatEngagementService,
 *   customBuilds?: { list: (userId: string) => Promise<Array<Record<string, any>>> },
 *   buildsList?: (userId: string) => Promise<Array<Record<string, any>>>,
 *   fetchImpl?: typeof fetch,
 * }} deps
 */
function buildMultichatRouter(deps) {
  const router = express.Router();
  const fetchImpl = deps.fetchImpl || fetch;

  // Per-token limiter: the widget's steady state is one YouTube poll
  // every ~2-8s plus rare resolves — 60/min leaves generous headroom
  // while keeping a leaked token from turning the API into a proxy.
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    /** @param {import('express').Request} req */
    keyGenerator: (req) => `multichat:${req.params.token || "anon"}`,
  });

  /** @type {import('express').RequestHandler} */
  const tokenAuth = async (req, res, next) => {
    try {
      const token = String(req.params.token || "");
      const resolved = token ? await deps.overlayTokens.resolve(token) : null;
      if (!resolved) {
        res.status(401).json({ error: { code: "invalid_overlay_token" } });
        return;
      }
      // @ts-ignore request-scoped context, same pattern as socket auth
      req.overlayUserId = resolved.userId;
      next();
    } catch (err) {
      next(err);
    }
  };

  router.get(
    "/multichat/:token/config",
    limiter,
    tokenAuth,
    async (req, res, next) => {
      try {
        // @ts-ignore stamped by tokenAuth
        const userId = String(req.overlayUserId);
        const prefs = await deps.users.getPreferences(userId, "multichat");
        const config = sanitizeMultichatConfig(prefs);
        // Uploaded custom sounds: the prefs store an ``uploadId``; the
        // widget needs a fetchable URL. Rewrite to this token's serve
        // route so the Browser Source's only credential stays the
        // token. Entries whose upload was deleted are dropped.
        const sound = /** @type {Record<string, any> | undefined} */ (
          config.sound
        );
        if (sound && Array.isArray(sound.customSounds)) {
          const token = encodeURIComponent(String(req.params.token));
          sound.customSounds = sound.customSounds.map((c) =>
            c.kind === "upload" && typeof c.uploadId === "string"
              ? {
                  id: c.id,
                  label: c.label,
                  kind: "upload",
                  url: `/v1/multichat/${token}/sound/${c.uploadId}`,
                }
              : c,
          );
        }
        res.json({ config });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Engagement: idempotent chat ingest + boot summary ──
  // Every open surface (widget or dock) reports what it sees; the
  // unique (token, platform, msgId) index dedupes across sources.
  router.post(
    "/multichat/:token/engage",
    limiter,
    tokenAuth,
    async (req, res, next) => {
      try {
        if (!deps.engagement) {
          res.json({ accepted: 0 });
          return;
        }
        const out = await deps.engagement.ingest(
          String(req.params.token),
          req.body?.events,
        );
        res.json(out);
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/multichat/:token/engagement",
    limiter,
    tokenAuth,
    async (req, res, next) => {
      try {
        if (!deps.engagement) {
          res.json({ wall: [], oracles: [], prediction: null, clipMoments: [] });
          return;
        }
        res.json(await deps.engagement.summary(String(req.params.token)));
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Saved builds (slim) for the dock's build vote ──
  router.get(
    "/multichat/:token/builds",
    limiter,
    tokenAuth,
    async (req, res, next) => {
      try {
        // @ts-ignore stamped by tokenAuth
        const userId = String(req.overlayUserId);
        if (!deps.customBuilds) {
          res.json({ builds: [] });
          return;
        }
        const [saved, played] = await Promise.all([
          deps.customBuilds.list(userId),
          deps.buildsList ? deps.buildsList(userId) : Promise.resolve([]),
        ]);
        /** @type {Map<string, {total: number, winRate: number}>} */
        const stats = new Map();
        for (const row of played) {
          if (row?.name) stats.set(String(row.name), { total: row.total ?? 0, winRate: row.winRate ?? 0 });
        }
        res.json({
          builds: saved.slice(0, 50).map((b) => ({
            slug: b.slug,
            name: b.name,
            race: b.race,
            vsRace: b.vsRace,
            total: stats.get(b.name)?.total ?? 0,
            winRate: stats.get(b.name)?.winRate ?? null,
          })),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Uploaded custom sound bytes ──
  // Token-authed like every overlay surface; cacheable because the
  // bytes for a soundId never change (delete + re-upload mints a new
  // id). Metadata rides the config route — audio bytes only here.
  router.get(
    "/multichat/:token/sound/:soundId",
    limiter,
    tokenAuth,
    async (req, res, next) => {
      try {
        // @ts-ignore stamped by tokenAuth
        const userId = String(req.overlayUserId);
        if (!deps.sounds) {
          res.status(404).json({ error: { code: "not_found" } });
          return;
        }
        const file = await deps.sounds.getForServe(
          userId,
          String(req.params.soundId),
        );
        if (!file) {
          res.status(404).json({ error: { code: "not_found" } });
          return;
        }
        res.setHeader("Content-Type", file.mime);
        res.setHeader("Content-Length", String(file.size));
        res.setHeader("Cache-Control", "private, max-age=86400, immutable");
        res.end(file.data);
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/multichat/:token/youtube/resolve",
    limiter,
    tokenAuth,
    async (req, res, next) => {
      try {
        const out = await resolveLiveChat(String(req.query.channel || ""), {
          fetchImpl,
        });
        res.json(out);
      } catch (err) {
        if (err instanceof YoutubeChatError) {
          res
            .status(err.code === "bad_input" ? 400 : 502)
            .json({ error: { code: err.code, message: err.message } });
          return;
        }
        next(err);
      }
    },
  );

  router.post(
    "/multichat/:token/youtube/poll",
    limiter,
    tokenAuth,
    async (req, res, next) => {
      try {
        const out = await pollLiveChat(
          {
            continuation: String(req.body?.continuation || ""),
            clientVersion: req.body?.clientVersion,
          },
          { fetchImpl },
        );
        res.json(out);
      } catch (err) {
        if (err instanceof YoutubeChatError) {
          res
            .status(err.code === "bad_input" ? 400 : 502)
            .json({ error: { code: err.code, message: err.message } });
          return;
        }
        next(err);
      }
    },
  );

  router.get(
    "/multichat/:token/kick/resolve",
    limiter,
    tokenAuth,
    async (req, res, next) => {
      try {
        const out = await resolveKickChatroom(String(req.query.slug || ""), {
          fetchImpl,
        });
        res.json(out);
      } catch (err) {
        if (err instanceof KickResolveError) {
          const status =
            err.code === "bad_input"
              ? 400
              : err.code === "not_found"
                ? 404
                : 502;
          res
            .status(status)
            .json({ error: { code: err.code, message: err.message } });
          return;
        }
        next(err);
      }
    },
  );

  // ── Stream Studio: shared dock/widget state ──
  // Highlight pin, chat poll, goals, studio blocklist, recap trigger.
  // Reads boot the widgets; writes come from the dock and broadcast
  // over the token's socket room (see MultichatStudioService).

  router.get(
    "/multichat/:token/studio",
    limiter,
    tokenAuth,
    async (req, res, next) => {
      try {
        res.json(await deps.studio.get(String(req.params.token)));
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/multichat/:token/studio",
    limiter,
    tokenAuth,
    async (req, res, next) => {
      try {
        const body =
          req.body && typeof req.body === "object" ? req.body : {};
        res.json(await deps.studio.update(String(req.params.token), body));
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Translation relay ──
  // The provider endpoint + key live server-side in the streamer's
  // preferences (translate: {enabled, endpoint, apiKey, targetLang});
  // the widget only ever sends text. LibreTranslate-compatible wire
  // shape ({q, source:"auto", target, api_key} → {translatedText}).
  router.post(
    "/multichat/:token/translate",
    limiter,
    tokenAuth,
    async (req, res, next) => {
      try {
        // @ts-ignore stamped by tokenAuth
        const userId = String(req.overlayUserId);
        const prefs = await deps.users.getPreferences(userId, "multichat");
        const cfg = prefs?.translate;
        const endpoint = typeof cfg?.endpoint === "string" ? cfg.endpoint.trim() : "";
        if (cfg?.enabled !== true || !/^https:\/\//.test(endpoint)) {
          res.status(400).json({ error: { code: "translate_unconfigured" } });
          return;
        }
        const texts = (Array.isArray(req.body?.texts) ? req.body.texts : [])
          .map((/** @type {unknown} */ t) => String(t ?? "").slice(0, 500))
          .filter(Boolean)
          .slice(0, 10);
        if (texts.length === 0) {
          res.json({ translations: [] });
          return;
        }
        const upstream = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            q: texts,
            source: "auto",
            target:
              typeof cfg.targetLang === "string" && /^[a-z-]{2,8}$/i.test(cfg.targetLang)
                ? cfg.targetLang
                : "en",
            format: "text",
            api_key: typeof cfg.apiKey === "string" ? cfg.apiKey.slice(0, 200) : "",
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!upstream.ok) {
          res.status(502).json({ error: { code: "translate_upstream", status: upstream.status } });
          return;
        }
        const data = await upstream.json();
        // LibreTranslate returns {translatedText: string | string[]}.
        const t = data?.translatedText;
        const translations = Array.isArray(t) ? t.map(String) : [String(t ?? "")];
        res.json({ translations });
      } catch (err) {
        next(err);
      }
    },
  );

  // SSE stream of TikTok chat. Long-lived — exempt from the poll
  // limiter budget beyond its initial handshake (one request).
  router.get(
    "/multichat/:token/tiktok/stream",
    tokenAuth,
    (req, res, next) => {
      try {
        const username = String(req.query.username || "");
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write(`retry: 5000\n\n`);

        /** @param {Record<string, any>} event */
        const send = (event) => {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        };

        let unsubscribe;
        try {
          unsubscribe = deps.tiktokRelay.subscribe(username, send);
        } catch (err) {
          const code = /** @type {any} */ (err)?.code || "tiktok_error";
          send({ type: "status", state: "error", detail: code });
          res.end();
          return;
        }

        // Comment heartbeat keeps proxies from timing the stream out.
        const heartbeat = setInterval(() => {
          res.write(`: hb\n\n`);
        }, 20000);

        req.on("close", () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

/** Platforms the widget knows how to render. */
const MULTICHAT_PLATFORMS = Object.freeze([
  "twitch",
  "kick",
  "youtube",
  "tiktok",
]);

/**
 * Whitelist-shape the stored preferences blob before it leaves the API
 * on a token-authed route. The settings page may store anything the
 * 5 MiB body limit allows; the overlay only ever sees the four known
 * platform entries with their known fields, plus the strict-sanitized
 * ``appearance`` styling blob (multichatAppearance service).
 *
 * @param {Record<string, any>} prefs
 * @returns {Record<string, any>}
 */
function sanitizeMultichatConfig(prefs) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const platform of MULTICHAT_PLATFORMS) {
    const entry = prefs?.[platform];
    if (!entry || typeof entry !== "object") continue;
    /** @type {Record<string, any>} */
    const clean = { enabled: entry.enabled === true };
    if (typeof entry.channel === "string" && entry.channel.trim()) {
      clean.channel = entry.channel.trim().slice(0, 120);
    }
    if (Number.isInteger(entry.chatroomId) && entry.chatroomId > 0) {
      clean.chatroomId = entry.chatroomId;
    }
    if (typeof entry.username === "string" && entry.username.trim()) {
      clean.username = entry.username.trim().slice(0, 60);
    }
    out[platform] = clean;
  }
  // Appearance + TTS ride along whenever the streamer has customised
  // them — the sanitizers guarantee complete, render-safe objects.
  if (prefs?.appearance && typeof prefs.appearance === "object") {
    out.appearance = sanitizeChatAppearance(prefs.appearance);
  }
  if (prefs?.tts && typeof prefs.tts === "object") {
    out.tts = sanitizeChatTts(prefs.tts);
  }
  if (prefs?.sound && typeof prefs.sound === "object") {
    out.sound = sanitizeChatSound(prefs.sound);
  }
  // Translation: the widget only learns {enabled, mode, targetLang} —
  // the provider endpoint and API key never leave the server (the
  // relay reads them per request). Mode "local" (the free on-device
  // default) needs nothing but the flag; "provider" is only actually
  // enabled once a valid https endpoint is stored.
  if (prefs?.translate && typeof prefs.translate === "object") {
    const t = prefs.translate;
    const mode = t.mode === "provider" ? "provider" : "local";
    out.translate = {
      enabled:
        t.enabled === true &&
        (mode === "local" ||
          (typeof t.endpoint === "string" && /^https:\/\//.test(t.endpoint))),
      mode,
      targetLang:
        typeof t.targetLang === "string" && /^[a-z-]{2,8}$/i.test(t.targetLang)
          ? t.targetLang
          : "en",
    };
  }
  return out;
}

module.exports = {
  buildMultichatRouter,
  sanitizeMultichatConfig,
  MULTICHAT_PLATFORMS,
};
