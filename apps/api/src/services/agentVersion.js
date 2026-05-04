"use strict";

const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/;
const VALID_CHANNELS = new Set(["stable", "beta", "dev"]);

/**
 * AgentVersionService — drives the agent's "is there a newer
 * installer available?" flow.
 *
 * On startup the local agent calls `GET /v1/agent/version?channel=stable`
 * and receives `{ version, sha256, downloadUrl, releaseNotes }`. If the
 * returned version is newer than its own, the agent downloads the
 * installer, verifies the SHA-256, and runs it. Releases are stored
 * in the `agent_releases` collection, one document per (channel,
 * version), so a new release is just a `publish()` call from an
 * admin tool.
 */
class AgentVersionService {
  /** @param {{agentReleases: import('mongodb').Collection}} db */
  constructor(db) {
    this.db = db;
  }

  /**
   * Latest published release on `channel`. Defaults to "stable".
   *
   * @param {{ channel?: string, platform?: string }} [opts]
   */
  async latest(opts = {}) {
    const channel = pickChannel(opts.channel);
    const platform = pickPlatform(opts.platform);
    const doc = await this.db.agentReleases.findOne(
      { channel, "artifacts.platform": platform },
      { sort: { publishedAt: -1 }, projection: { _id: 0 } },
    );
    if (!doc) return null;
    const artifact = (doc.artifacts || []).find(
      /** @param {{platform: string}} a */
      (a) => a.platform === platform,
    );
    if (!artifact) return null;
    return {
      channel: doc.channel,
      version: doc.version,
      publishedAt: doc.publishedAt,
      releaseNotes: doc.releaseNotes || "",
      minSupportedVersion: doc.minSupportedVersion || null,
      artifact: {
        platform: artifact.platform,
        downloadUrl: artifact.downloadUrl,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes || null,
        signature: artifact.signature || null,
      },
    };
  }

  /**
   * Publish a new release. Idempotent on (channel, version) — the
   * second call with the same key updates artifacts in place.
   *
   * @param {{
   *   channel: string,
   *   version: string,
   *   releaseNotes?: string,
   *   minSupportedVersion?: string | null,
   *   artifacts: Array<{
   *     platform: string,
   *     downloadUrl: string,
   *     sha256: string,
   *     sizeBytes?: number,
   *     signature?: string,
   *   }>
   * }} payload
   */
  async publish(payload) {
    if (!payload || typeof payload !== "object") throw new Error("invalid payload");
    if (!VALID_CHANNELS.has(payload.channel)) throw new Error("invalid channel");
    if (!SEMVER_RE.test(String(payload.version || ""))) {
      throw new Error("version must be semver");
    }
    if (!Array.isArray(payload.artifacts) || payload.artifacts.length === 0) {
      throw new Error("artifacts required");
    }
    for (const a of payload.artifacts) {
      validateArtifact(a);
    }
    if (
      payload.minSupportedVersion &&
      !SEMVER_RE.test(payload.minSupportedVersion)
    ) {
      throw new Error("minSupportedVersion must be semver");
    }
    const doc = {
      channel: payload.channel,
      version: payload.version,
      releaseNotes: String(payload.releaseNotes || "").slice(0, 16384),
      minSupportedVersion: payload.minSupportedVersion || null,
      artifacts: payload.artifacts.map((a) => ({
        platform: a.platform,
        downloadUrl: a.downloadUrl,
        sha256: a.sha256,
        sizeBytes: typeof a.sizeBytes === "number" ? a.sizeBytes : null,
        signature: a.signature || null,
      })),
      publishedAt: new Date(),
    };
    stampVersion(doc, COLLECTIONS.AGENT_RELEASES);
    await this.db.agentReleases.updateOne(
      { channel: doc.channel, version: doc.version },
      { $set: doc, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );
    return { channel: doc.channel, version: doc.version };
  }

  /**
   * History view for the dashboard. Latest first, capped to 50.
   *
   * @param {{ channel?: string }} [opts]
   */
  async history(opts = {}) {
    const channel = pickChannel(opts.channel);
    return this.db.agentReleases
      .find({ channel }, { projection: { _id: 0 } })
      .sort({ publishedAt: -1 })
      .limit(50)
      .toArray();
  }
}

/** @param {unknown} raw */
function pickChannel(raw) {
  const s = String(raw || "stable").toLowerCase();
  return VALID_CHANNELS.has(s) ? s : "stable";
}

/** @param {unknown} raw */
function pickPlatform(raw) {
  const s = String(raw || "windows").toLowerCase();
  if (s === "macos" || s === "darwin") return "macos";
  if (s === "linux") return "linux";
  return "windows";
}

/** @param {any} a */
function validateArtifact(a) {
  if (!a || typeof a !== "object") throw new Error("artifact must be object");
  if (typeof a.platform !== "string" || a.platform.length === 0) {
    throw new Error("artifact.platform required");
  }
  if (typeof a.downloadUrl !== "string" || !/^https?:\/\//i.test(a.downloadUrl)) {
    throw new Error("artifact.downloadUrl must be http(s)");
  }
  if (typeof a.sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(a.sha256)) {
    throw new Error("artifact.sha256 must be 64 hex chars");
  }
}

/**
 * Compare two semver strings. Returns -1 / 0 / 1.
 *
 * Public so the agent route handler can short-circuit "no update
 * needed" without re-implementing the parser.
 *
 * @param {string} a
 * @param {string} b
 */
function compareVersions(a, b) {
  const am = SEMVER_RE.exec(String(a || ""));
  const bm = SEMVER_RE.exec(String(b || ""));
  if (!am || !bm) return 0;
  for (let i = 1; i <= 3; i += 1) {
    const av = Number.parseInt(am[i], 10);
    const bv = Number.parseInt(bm[i], 10);
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

module.exports = { AgentVersionService, compareVersions };
