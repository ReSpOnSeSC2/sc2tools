"use strict";

const express = require("express");
const { createHmac, createPublicKey, randomBytes, verify } = require("node:crypto");
const { rateLimit } = require("express-rate-limit");
const { BoundedRateLimitStore } = require("../middleware/boundedRateLimitStore");
const { BUILD_COMMAND, DISCORD_INTERACTIONS_PATH } = require("../config/discordInteractions");
const { matchupFromSlug, matchupSlug } = require("../config/guideSlugs");

const SITE = "https://sc2tools.com";
const SKEW_SECONDS = 300;
const BODY_DEADLINE_MS = 2000;
const JSON_TYPE = "application/json";
const EPHEMERAL = 64;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const RATE_LIMIT_KEY = randomBytes(32);

/** @typedef {NonNullable<ReturnType<typeof import("../config/discordInteractions").parseDiscordInteractions>>} Config */
/** @typedef {Pick<import("../services/discordBuildCache").DiscordBuildCache, "get">} BuildCache */

/** @param {Config|null|undefined} config */
function verificationKey(config) {
  if (!config) return null;
  try {
    return createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519",
      x: Buffer.from(config.publicKey, "hex").toString("base64url") } });
  } catch {
    return null;
  }
}

/** @param {import('express').Request} req @param {number} now */
function readSignature(req, now) {
  const time = req.get("X-Signature-Timestamp") || "";
  const signature = req.get("X-Signature-Ed25519") || "";
  if (!/^\d{1,12}$/u.test(time) || !/^[a-f0-9]{128}$/iu.test(signature)) return null;
  if (Math.abs(Math.floor(now / 1000) - Number(time)) > SKEW_SECONDS) return null;
  return { time, signature };
}

/** @type {import('express').RequestHandler} */
function admitInteractionBody(req, res, next) {
  const encoding = req.get("Content-Encoding");
  if (!req.is(JSON_TYPE) || (encoding && encoding.toLowerCase() !== "identity")) {
    res.set("Connection", "close").sendStatus(401);
    return;
  }
  next();
}

/** @type {import('express').RequestHandler} */
function readRawInteraction(req, res, next) {
  const timeout = setTimeout(() => {
    res.set("Connection", "close");
    res.sendStatus(408);
  }, BODY_DEADLINE_MS);
  timeout.unref();
  const clearDeadline = () => clearTimeout(timeout);
  res.once("close", clearDeadline);
  parseRawInteraction(req, res, err => {
    clearDeadline();
    res.off("close", clearDeadline);
    if (res.headersSent || res.destroyed) return;
    if (!err) { next(); return; }
    // Parser errors may contain the raw bytes. Do not pass them to diagnostics.
    res.sendStatus(err.status === 413 ? 413 : 400);
  });
}

const parseRawInteraction = express.raw({ type: JSON_TYPE, limit: "16kb", inflate: false });

/** @param {Buffer} raw @returns {Record<string,unknown>|null} */
function interactionBody(raw) {
  try {
    const data = JSON.parse(UTF8.decode(raw));
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/** @param {unknown} data */
function buildMatchup(data) {
  if (!data || typeof data !== "object") return null;
  const { type, name, options } = /** @type {Record<string,unknown>} */ (data);
  if (type !== BUILD_COMMAND.type || name !== BUILD_COMMAND.name || !Array.isArray(options) || options.length !== 1) return null;
  const option = options[0];
  if (option?.name !== "matchup" || option.type !== 3) return null;
  return matchupFromSlug(option.value);
}

/** @param {number} rate */
const percent = rate => (rate * 100).toFixed(1) + "%";
/** @param {string} label @param {string} url */
const linkButton = (label, url) => ({ type: 2, style: 5, label, url });

/** @param {string|null} matchup @param {BuildCache|null|undefined} cache */
function buildResponse(matchup, cache) {
  const data = { flags: EPHEMERAL, allowed_mentions: { parse: [] } };
  const slug = matchup ? matchupSlug(matchup) : null;
  if (!matchup || !slug) return { type: 4, data: { ...data, content: "Choose a matchup in the /build command." } };
  if (!cache) return { type: 4, data: { ...data, content: "Build guides are unavailable right now." } };
  const url = SITE + "/guides/" + slug;
  const snapshot = cache.get(matchup);
  const components = [{ type: 1, components: [linkButton("All openers", url), linkButton("Grade my replay", SITE + "/try")] }];
  if (!snapshot) {
    return { type: 4, data: { ...data, content: "Published opener stats are unavailable right now. Check the matchup guide.", components } };
  }
  const embed = {
    title: matchup + " ladder build guides", url,
    description: snapshot.openers.map(row => {
      const range = percent(row.ci.low) + " to " + percent(row.ci.high);
      return "[" + row.name + "](" + url + "/" + row.slug + ") · " + percent(row.winRate)
        + " wins (" + range + " interval, " + row.games.toLocaleString("en-US") + " games)";
    }).join("\n"),
    footer: { text: "12-worker ladder · Snapshot " + snapshot.date },
  };
  return { type: 4, data: { ...data, embeds: [embed], components } };
}

/** @param {import("node:crypto").KeyObject|null} key @param {string|undefined} applicationId @param {BuildCache|null|undefined} cache */
function respondToInteraction(key, applicationId, cache) {
  /** @type {import('express').RequestHandler} */
  return (req, res) => {
    const { time, signature } = res.locals.discordSignature;
    if (!key || !Buffer.isBuffer(req.body)
      || !verify(null, Buffer.concat([Buffer.from(time), req.body]), key, Buffer.from(signature, "hex"))) {
      res.sendStatus(401);
      return;
    }
    const body = interactionBody(req.body);
    if (!body) { res.sendStatus(400); return; }
    if (body.type === 1 && (body.application_id === undefined || body.application_id === applicationId)) {
      res.json({ type: 1 });
      return;
    }
    if (body.application_id !== applicationId) { res.sendStatus(401); return; }
    if (body.type !== 2) { res.sendStatus(400); return; }
    res.json(buildResponse(buildMatchup(body.data), cache));
  };
}

/** @type {import('express').ErrorRequestHandler} */
function interactionFailure(_err, _req, res, _next) {
  // Even an unexpected failure stays inside the interaction boundary.
  if (res.headersSent) { res.end(); return; }
  res.sendStatus(500);
}

/** @param {Config|null|undefined} config @param {BuildCache|null|undefined} cache
 * @param {{ now?:()=>number, maxPerMinute?:number }} [opts] */
function buildDiscordInteractionsRouter(config, cache, { now = Date.now, maxPerMinute = 3000 } = {}) {
  const router = express.Router();
  const key = verificationKey(config);
  const limit = rateLimit({
    windowMs: 60_000, max: maxPerMinute, standardHeaders: "draft-7", legacyHeaders: false,
    store: new BoundedRateLimitStore({ maxEntries: 4096 }), message: { error: "rate_limited" },
    keyGenerator: req => createHmac("sha256", RATE_LIMIT_KEY).update(req.ip || "unknown").digest("hex"),
  });
  router.post(DISCORD_INTERACTIONS_PATH, (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!key) { res.sendStatus(404); return; }
    next();
  }, limit, admitInteractionBody, (req, res, next) => {
    const signature = readSignature(req, now());
    if (!key || !signature) { res.set("Connection", "close").sendStatus(401); return; }
    res.locals.discordSignature = signature;
    next();
  }, readRawInteraction, respondToInteraction(key, config?.applicationId, cache));
  router.use(DISCORD_INTERACTIONS_PATH, interactionFailure);
  return router;
}

module.exports = { buildDiscordInteractionsRouter };
