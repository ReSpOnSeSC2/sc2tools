"use strict";

const { GUIDE_CURRENT_ERA } = require("../config/guides");
const { MATCHUPS, buildSlug } = require("../config/guideSlugs");
const { RUN_KEY } = require("./guideStats");
const { shapeMatchupPayload } = require("./guidesPayloads");
const { meetsPageFloor } = require("./guideStatsShape");
const { PATCH_ERA_RULE } = require("../util/patchEra");

const REFRESH_MS = 10 * 60_000;
const MAX_CACHE_AGE_MS = REFRESH_MS * 2;
const GUIDE_READ = { maxTimeMS: 2000 };
const MATCHUP_PROJECTION = {
  _id: 0, matchup: 1, published: 1, computedAt: 1,
  "builds.buildKey": 1, "builds.buildSlug": 1, "builds.published": 1,
  "builds.games": 1, "builds.users": 1, "builds.wins": 1, "builds.winRate": 1,
  "builds.ci.low": 1, "builds.ci.high": 1,
};

/** @typedef {{slug:string, name:string, games:number, winRate:number, ci:{low:number, high:number}}} Opener */
/** @typedef {{ date: string, openers: Opener[] }} BuildSnapshot */
/** @typedef {ReturnType<typeof shapeMatchupPayload>["openers"][number]} GuideOpener */

/** @param {GuideOpener} row */
function canPublish(row) {
  return row.published && Number.isSafeInteger(row.games) && Number.isSafeInteger(row.users)
    && meetsPageFloor(row) && row.users >= 5
    && 0 <= row.ci.low && row.ci.low <= row.winRate && row.winRate <= row.ci.high && row.ci.high <= 1;
}

/** Reuse the public matchup sort and floors. A DB-provided label or URL is never authoritative.
 * @param {string} matchup @param {import("./guidesPayloads").Doc} doc @returns {BuildSnapshot|null} */
function buildSnapshot(matchup, doc) {
  if (doc.matchup !== matchup || !(doc.computedAt instanceof Date) || !Number.isFinite(+doc.computedAt)) return null;
  const payload = shapeMatchupPayload({ matchup, era: GUIDE_CURRENT_ERA, band: null, doc, buildDocs: [], videos: [] });
  if (!payload.published) return null;
  const rows = new Map();
  for (const row of payload.openers) {
    const slug = buildSlug(matchup, row.buildKey);
    if (!slug || slug !== row.buildSlug || rows.has(slug) || !canPublish(row)) continue;
    rows.set(slug, { slug, name: row.name, games: row.games, winRate: row.winRate, ci: row.ci });
    if (rows.size === 5) break;
  }
  return rows.size ? { date: doc.computedAt.toISOString().slice(0, 10), openers: [...rows.values()] } : null;
}

/** @param {import("../db/connect").DbContext["guideStats"]} stats */
async function readSnapshots(stats) {
  const run = await stats.findOne({ key: RUN_KEY, kind: "run" },
    { ...GUIDE_READ, projection: { _id: 0, computedAt: 1, eraRule: 1 } });
  const snapshots = new Map();
  if (!(run?.computedAt instanceof Date) || run.eraRule !== PATCH_ERA_RULE) return snapshots;
  const docs = await stats.find({
    key: { $in: MATCHUPS.map(matchup => "matchup:" + GUIDE_CURRENT_ERA + ":" + matchup) },
    kind: "matchup", era: GUIDE_CURRENT_ERA, computedAt: run.computedAt, published: true,
  }, { ...GUIDE_READ, projection: MATCHUP_PROJECTION }).limit(MATCHUPS.length).toArray();
  for (const doc of docs) {
    if (!MATCHUPS.includes(doc.matchup)) continue;
    const snapshot = buildSnapshot(doc.matchup, doc);
    if (snapshot) snapshots.set(doc.matchup, snapshot);
  }
  return snapshots;
}

class DiscordBuildCache {
  /** @param {import("../db/connect").DbContext["guideStats"]} stats
   * @param {{logger?:Pick<import("pino").Logger,"warn">,now?:()=>number}} [opts] */
  constructor(stats, { logger, now = Date.now } = {}) {
    this.stats = stats;
    this.logger = logger;
    this.now = now;
    this.generation = 0;
    this.expiresAt = 0;
    /** @type {Map<string, BuildSnapshot>} */
    this.snapshots = new Map();
    /** @type {Promise<void>|null} */
    this.inflight = null;
    /** @type {ReturnType<typeof setInterval>|null} */
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, REFRESH_MS);
    this.timer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.generation += 1;
    this.expiresAt = 0;
    this.snapshots.clear();
    await this.inflight;
  }

  invalidate() {
    this.generation += 1;
    this.expiresAt = 0;
    if (!this.inflight) void this.refresh();
  }

  refresh() {
    if (this.inflight) return this.inflight;
    const generation = this.generation;
    this.inflight = readSnapshots(this.stats).then(snapshots => {
      if (this.generation !== generation) return;
      this.snapshots = snapshots;
      this.expiresAt = this.now() + MAX_CACHE_AGE_MS;
    }).catch(() => { this.logger?.warn("discord_build_cache_refresh_failed"); }).finally(() => {
      this.inflight = null;
      // A guide recompute can finish during a refresh. Discard that read and
      // pick up the completed revision without waiting another interval.
      if (this.timer && this.generation !== generation) void this.refresh();
    });
    return this.inflight;
  }

  /** @param {string} matchup */
  get(matchup) {
    return this.now() < this.expiresAt ? this.snapshots.get(matchup) : undefined;
  }
}

/** @param {ReturnType<typeof import("../config/loader").loadConfig>} config
 * @param {import("../db/connect").DbContext["guideStats"]} stats @param {import("pino").Logger} logger */
function createDiscordBuildCache(config, stats, logger) {
  return config.discordInteractions && config.guidesEnabled ? new DiscordBuildCache(stats, { logger }) : null;
}

module.exports = { DiscordBuildCache, createDiscordBuildCache };
