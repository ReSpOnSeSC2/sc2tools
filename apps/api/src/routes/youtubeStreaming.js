"use strict";

const express = require("express");

const READS = new Set(["streams_by_ids", "broadcasts_by_ids", "occupied_broadcasts", "all_owned_broadcasts", "recover_create"]);

/** @param {{auth:import('express').RequestHandler,youtubeStreaming:any}} deps */
function buildYoutubeStreamingRouter(deps) {
  const router = express.Router();
  router.use("/streaming/youtube", deps.auth);
  /** @param {import('express').Request} req */
  function owner(req) {
    if (!req.auth?.userId || !["device", "clerk"].includes(req.auth.source)) throw Object.assign(new Error("auth_required"), { status: 401, code: "auth_required" });
    return req.auth.userId;
  }
  /** @param {(req:import('express').Request)=>Promise<any>} action */
  function handle(action) {
    /** @type {import('express').RequestHandler} */
    const handler = async (req, res) => {
      res.set("Cache-Control", "no-store");
      try { res.json(await action(req)); } catch (caught) {
        const error = /** @type {any} */ (caught);
        const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
        const code = typeof error?.code === "string" && /^(youtube_[a-z_]+|creation_uncertain|binding_uncertain|cloud_ingest_active|auth_required|streaming_[a-z_]+|platform_[a-z_]+)$/.test(error.code) ? error.code : "youtube_streaming_unavailable";
        const providerHttpStatus = error?.providerHttpStatus;
        const diagnostic = ["youtube_provider_unavailable", "youtube_quota_limited"].includes(code)
          && Number.isInteger(providerHttpStatus) && typeof providerHttpStatus === "number"
          && providerHttpStatus >= 400 && providerHttpStatus <= 599 ? { providerHttpStatus } : {};
        // Never return provider bodies, URLs, auth headers, tokens or stack.
        res.status(status).json({ error: code, ...diagnostic });
      }
    };
    return handler;
  }
  router.get("/streaming/youtube/catalog", handle((req) => deps.youtubeStreaming.catalog(owner(req))));
  router.get("/streaming/youtube/read", handle((req) => {
    if (typeof req.query.operation !== "string" || !READS.has(req.query.operation) || Object.keys(req.query).some((key) => !["operation", "ids", "operation_id"].includes(key))) throw Object.assign(new Error("youtube_operation_invalid"), { status: 400, code: "youtube_operation_invalid" });
    const args = {
      ...(typeof req.query.ids === "string" ? { ids: req.query.ids.split(",") } : {}),
      ...(typeof req.query.operation_id === "string" ? { operation_id: req.query.operation_id } : {}),
    };
    return deps.youtubeStreaming.read(owner(req), req.query.operation, args);
  }));
  /** @type {Array<[string,string[],string]>} */
  const writes = [
    ["create", ["operation_id", "expected_channel_id", "body"], "create"],
    ["bind", ["broadcast_id", "stream_id", "expected_channel_id"], "bind"],
    ["metadata", ["broadcast_id", "title", "description", "expected_channel_id"], "updateMetadata"],
  ];
  for (const [route, fields, method] of writes) {
    router.post("/streaming/youtube/" + route, handle((req) => {
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).some((key) => !fields.includes(key))) throw Object.assign(new Error("youtube_operation_invalid"), { status: 400, code: "youtube_operation_invalid" });
      return deps.youtubeStreaming[method](owner(req), req.body);
    }));
  }
  return router;
}

module.exports = { buildYoutubeStreamingRouter };
