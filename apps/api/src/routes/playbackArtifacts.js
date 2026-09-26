"use strict";

const express = require("express");
const { claimReplayIngestAdmission, releaseReplayIngestAdmission } = require("../middleware/replayIngestAdmission");

/** @typedef {import('express').Request & {playbackRawBody?: Buffer}} PlaybackRequest */
/** @param {{playbackArtifacts: import('../services/playbackArtifacts').PlaybackArtifactsService|null, auth: import('express').RequestHandler}} deps */
function buildPlaybackArtifactsRouter({ playbackArtifacts, auth }) {
  const router = express.Router();
  const base = "/games/:gameId/map-playback";
  /** @param {boolean} write @param {(req: PlaybackRequest, store: import('../services/playbackArtifacts').PlaybackArtifactsService) => Promise<any>} action @param {boolean} [segment] @returns {import('express').RequestHandler} */
  const handle = (write, action, segment = false) => async (req, res, next) => {
    let claimed = false;
    try {
      if (!req.auth?.userId) throw Object.assign(new Error("auth_required"), { status: 401, code: "auth_required" });
      if (write && req.auth.source !== "device") throw Object.assign(new Error("device_auth_required"), { status: 403, code: "device_auth_required" });
      if (!playbackArtifacts) throw Object.assign(new Error(write ? "playback_storage_unavailable" : "playback_artifact_not_found"), { status: write ? 503 : 404, code: write ? "playback_storage_unavailable" : "playback_artifact_not_found" });
      if (!req.params.gameId || req.params.gameId.length > 200) throw Object.assign(new Error("invalid_game_id"), { status: 400, code: "invalid_game_id" });
      if (segment) {
        claimed = claimReplayIngestAdmission(res, { allowMissing: true });
        if (!claimed) throw Object.assign(new Error("replay_ingest_busy"), { status: 503, code: "replay_ingest_busy" });
      }
      res.set("Cache-Control", "private, no-store");
      const result = await action(req, playbackArtifacts);
      if (Buffer.isBuffer(result)) res.type("application/json").send(result);
      else res.json(result);
    } catch (err) {
      if (/** @type {{status?: number}} */ (err).status === 503) res.set("Retry-After", "5");
      next(err);
    } finally { if (claimed) releaseReplayIngestAdmission(res); }
  };
  router.get(`${base}/manifest`, auth, handle(false, (r, store) => store.getManifest(String(r.auth?.userId), r.params.gameId)));
  router.get(`${base}/artifacts/:artifactId/segments/:index`, auth, handle(false, (r, store) => store.getSegment(String(r.auth?.userId), r.params.gameId, r.params.artifactId, Number(r.params.index))));
  router.post(`${base}/artifacts`, auth, handle(true, (r, store) => store.prepare(String(r.auth?.userId), r.params.gameId, r.body?.manifest)));
  router.put(`${base}/artifacts/:artifactId/segments/:index`, auth, handle(true, (r, store) => store.upload(String(r.auth?.userId), r.params.gameId, r.params.artifactId, Number(r.params.index), r.playbackRawBody), true));
  router.post(`${base}/artifacts/:artifactId/complete`, auth, handle(true, (r, store) => store.complete(String(r.auth?.userId), r.params.gameId, r.params.artifactId)));
  return router;
}

module.exports = { buildPlaybackArtifactsRouter };
