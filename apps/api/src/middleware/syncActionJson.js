"use strict";

const ACTION_PATH = /^\/v1\/me\/sync-health\/(?:identity|retry)\/?$/i;

/** Match the same case/trailing-slash variants as the action router without
 * normalizing unrelated paths. @param {unknown} value @returns {boolean} */
function isSyncActionPath(value) {
  if (typeof value !== "string") return false;
  const path = value.split(/[?#]/, 1)[0].replace(/^https?:\/\/[^/]+(?=\/)/i, "");
  return ACTION_PATH.test(path);
}

/** @param {import('express').Request} req */
function isSyncActionPost(req) {
  return req.method === "POST" && isSyncActionPath(req.originalUrl || req.url);
}

/** Parse before ordinary JSON so SyntaxError.body/message never reach the
 * common logger or response. Rebuild errors without cause/stack/input copies.
 * @returns {import('express').RequestHandler} */
function buildSyncActionJsonParser() {
  const parser = require("express").json({ limit: 1024, strict: true });
  return (req, res, next) => {
    if (!isSyncActionPost(req)) { next(); return; }
    res.setHeader("Cache-Control", "private, no-store");
    parser(req, res, (error) => {
      if (!error) { next(); return; }
      const status = error.type === "entity.too.large" ? 413
        : error.type === "charset.unsupported" || error.type === "encoding.unsupported" ? 415 : 400;
      next(Object.assign(new Error("sync_fix_invalid_json"), { status, code: "sync_fix_invalid_json" }));
    });
  };
}

module.exports = { buildSyncActionJsonParser, isSyncActionPath, isSyncActionPost };
