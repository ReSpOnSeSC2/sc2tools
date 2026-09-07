"use strict";

const {
  normalizeYoutubeArchiveInput, extractYoutubeVideoIds,
  extractYoutubeChannelId, extractYoutubeMainPlayer, readTextBounded,
} = require("./gameVods");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");

const REFRESH_MS = 5 * 60_000;
const MAX_AGE_MS = 24 * 60 * 60_000;
const RETRY_MS = 60_000;
const MAX_VIDEOS = 30;
const PAGE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; SC2Tools/1.0; +https://sc2tools.com)",
  "Accept-Language": "en-US,en;q=0.9",
};

/**
 * Shared cache of public broadcast times, independently verified through
 * YouTube's Data API. A requesting user's existing grant can refresh public
 * metadata; credentials and private/unlisted recordings never enter this cache.
 */
class PublicYoutubeVodsService {
  /** @param {{collection:any,platformIntegrations:any,fetchImpl?:typeof fetch,now?:()=>number,log?:any}} opts */
  constructor(opts) {
    this.collection = opts.collection;
    this.integrations = opts.platformIntegrations;
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.now = opts.now || Date.now;
    this.log = opts.log;
    /** @type {Map<string,Promise<{vods:any[],fresh:boolean}>>} */
    this.inflight = new Map();
    /** @type {Map<string,number>} */
    this.retryAfter = new Map();
  }

  /** @param {string} userId @param {string} input @returns {Promise<{vods:any[],fresh:boolean}>} */
  async resolveChannel(userId, input) {
    const normalized = normalizeYoutubeArchiveInput(input);
    // A channel-page owner establishes whose public recording this is.
    // A bare video configured privately remains in the existing own-channel path.
    if (!normalized.streamsUrls.length) return { vods: [], fresh: false };
    const key = normalized.cacheKey;
    const stored = await this.collection.findOne({ _id: key });
    const fetchedAt = stored?.fetchedAt instanceof Date ? stored.fetchedAt.getTime() : 0;
    const age = this.now() - fetchedAt;
    const vods = age >= 0 && age < MAX_AGE_MS ? validVods(stored?.vods, stored?.channelId, this.now()) : [];
    const ttl = vods.some((vod) => vod.ongoing) ? 30_000 : REFRESH_MS;
    if (fetchedAt && age >= 0 && age < ttl) return { vods, fresh: true };
    const fallback = { vods, fresh: false };
    if (!userId || typeof this.integrations?.resolvePublicYoutubeBroadcasts !== "function") return fallback;
    // A viewer without a YouTube connection still receives the shared cache.
    // Do not fetch channel pages when no official metadata lookup is possible.
    const revision = await this.integrations.getYoutubeConnectionRevision(userId).catch(() => "");
    if (!revision) return fallback;
    if ((this.retryAfter.get(key) || 0) > this.now()) return fallback;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const job = this.refresh(userId, normalized, stored)
      .catch((err) => {
        this.retryAfter.set(key, this.now() + RETRY_MS);
        while (this.retryAfter.size > 256) {
          const oldest = this.retryAfter.keys().next().value;
          if (oldest === undefined) break;
          this.retryAfter.delete(oldest);
        }
        // Never log provider bodies, URLs containing grants, or OAuth errors.
        this.log?.warn?.({ provider: "youtube", code: safeCode(err) }, "public_youtube_index_failed");
        return fallback;
      }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  /** @param {string} userId @param {ReturnType<typeof normalizeYoutubeArchiveInput>} normalized @param {any} stored */
  async refresh(userId, normalized, stored) {
    let channelId = "";
    /** @type {string[]} */
    let videoIds = [];
    const signal = AbortSignal.timeout(12_000);
    for (const url of normalized.streamsUrls) {
      const response = await this.fetchImpl(url, { headers: PAGE_HEADERS, signal });
      if (!response.ok) throw indexError(`youtube_channel_${response.status}`);
      const html = await readTextBounded(response, 8 * 1024 * 1024);
      channelId = extractYoutubeChannelId(html) || "";
      if (!channelId) continue;
      videoIds = extractYoutubeVideoIds(html, MAX_VIDEOS);
      if (videoIds.length) break;
    }
    // Unknown page layouts or empty discovery must not erase verified results.
    if (!/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
      throw indexError("youtube_channel_unverifiable");
    }
    // /streams can omit a current broadcast. Its own /live page supplies a
    // candidate only; the Data API must still prove public privacy and timing.
    try {
      const live = await this.fetchImpl(normalized.streamsUrls[0].replace(/\/streams$/, "/live"), {
        headers: PAGE_HEADERS, signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
      });
      if (live.ok) {
        const player = extractYoutubeMainPlayer(await readTextBounded(live, 8 * 1024 * 1024));
        const id = player?.videoDetails?.videoId;
        if (player?.videoDetails?.channelId === channelId
          && player?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.isLiveNow === true
          && typeof id === "string" && /^[A-Za-z0-9_-]{11}$/.test(id)) {
          videoIds = [id, ...videoIds.filter((videoId) => videoId !== id)].slice(0, MAX_VIDEOS);
        }
      }
    } catch { /* A missing live page does not invalidate known archive candidates. */ }
    if (!videoIds.length) throw indexError("youtube_channel_unverifiable");
    const result = await withAbort(
      this.integrations.resolvePublicYoutubeBroadcasts(userId, videoIds, { signal }), signal,
    );
    if (!Array.isArray(result)) throw indexError("youtube_connection_unavailable");
    const requested = new Set(videoIds);
    const vods = validVods(result, channelId, this.now()).filter((vod) => requested.has(vod.videoId));
    const fetchedAt = new Date(this.now());
    const document = stampVersion({
      channelId, vods, fetchedAt, expiresAt: new Date(this.now() + MAX_AGE_MS),
    }, COLLECTIONS.PUBLIC_YOUTUBE_ARCHIVES);
    // A slower scan on another instance must not replace a newer snapshot.
    if (stored) {
      await this.collection.updateOne({ _id: normalized.cacheKey, fetchedAt: stored.fetchedAt }, { $set: document });
    } else {
      try {
        await this.collection.updateOne({ _id: normalized.cacheKey }, { $setOnInsert: document }, { upsert: true });
      } catch (err) {
        if (/** @type {any} */ (err)?.code !== 11000) throw err;
      }
    }
    this.retryAfter.delete(normalized.cacheKey);
    this.log?.info?.({ provider: "youtube", archiveCount: vods.length, videosScanned: videoIds.length }, "public_youtube_index_refreshed");
    return { vods, fresh: true };
  }
}

/** @param {any} rows @param {string} channelId @param {number} now @returns {any[]} */
function validVods(rows, channelId, now) {
  if (!Array.isArray(rows) || !/^UC[A-Za-z0-9_-]{22}$/.test(channelId || "")) return [];
  return rows.filter((row) => row?.platform === "youtube"
    && row.channelId === channelId && /^[A-Za-z0-9_-]{11}$/.test(row.videoId || "")
    && Number.isFinite(row.startMs) && row.startMs > 0 && row.startMs <= now
    && Number.isFinite(row.endMs) && row.endMs > row.startMs && row.endMs <= now
    && row.endMs - row.startMs <= 7 * 24 * 60 * 60_000)
    .slice(0, MAX_VIDEOS).map((row) => ({
      platform: "youtube", channelId, videoId: row.videoId,
      startMs: row.startMs, endMs: row.endMs,
      ongoing: row.ongoing === true,
      orientation: ["horizontal", "portrait"].includes(row.orientation) ? row.orientation : "unknown",
    }));
}

/** @param {string} code */
function indexError(code) { return Object.assign(new Error("Public YouTube index unavailable"), { code }); }
/** @param {unknown} err */
function safeCode(err) {
  const code = String(/** @type {any} */ (err)?.code || "");
  return /^[a-z0-9_]{1,80}$/i.test(code) ? code : "youtube_index_unavailable";
}

/** Bound time spent waiting behind another OAuth refresh without extending its grant. @param {Promise<any>} job @param {AbortSignal} signal */
function withAbort(job, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(indexError("youtube_index_timeout"));
    if (signal.aborted) { job.catch(() => {}); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    job.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

module.exports = { PublicYoutubeVodsService };
