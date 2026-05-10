"use strict";

// Live 1v1 ladder map pool, sourced from Liquipedia.
//
// The Bingo: Ladder Edition mode draws map-bound objectives from
// /v1/seasons.mapPool, which previously came from a hardcoded
// CURRENT_LADDER_MAP_POOL constant in services/seasons.js. Blizzard
// rotates the pool every couple of months; the constant went stale
// silently between rotations, and Bingo would keep generating cells
// for retired maps.
//
// This service is the live data source. It:
//   1. Fetches the Liquipedia wikitext for Maps/Ladder_Maps/Legacy_of_the_Void
//      (`prop=wikitext` on action=parse) — much smaller than parsing the
//      rendered HTML, and respectful of Liquipedia's API terms with a
//      proper User-Agent.
//   2. Parses the "Current Maps" section's MapList template into a
//      deduplicated list of map names.
//   3. Caches the result in-process with a 7-day TTL and persists the
//      last-good list to apps/api/data/ladder-map-pool.json (atomic
//      tmp+rename) so a cold start without Liquipedia reachability
//      still serves real data — the bundled seed file in the
//      repository acts as the cold-start floor for the very first
//      boot of a fresh container.
//   4. Falls back to a baked-in constant only when both network AND
//      persisted file are unavailable; that constant is the
//      last-resort, not the source-of-truth.

const fs = require("fs/promises");
const path = require("path");

const LIQUIPEDIA_API =
  "https://liquipedia.net/starcraft2/api.php"
  + "?action=parse&page=Maps%2FLadder_Maps%2FLegacy_of_the_Void"
  + "&format=json&prop=wikitext";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
// Persisted last-good file. Lives alongside the API source on disk so
// the Dockerfile's `COPY apps/api/ ./` ships the seeded version into
// the container. Runtime refreshes overwrite this path atomically.
const PERSIST_PATH = path.join(__dirname, "..", "..", "data", "ladder-map-pool.json");

// Hardcoded last-resort fallback. Mirrors the previous
// CURRENT_LADDER_MAP_POOL in services/seasons.js and only kicks in if
// both the network AND the persisted file are unavailable on cold start.
const FALLBACK_POOL = Object.freeze([
  "Equilibrium",
  "Goldenaura",
  "Hard Lead",
  "Oceanborn",
  "Site Delta",
  "El Dorado",
  "Whispers of Gold",
  "Pylon Overgrowth",
  "Frostline",
]);

const USER_AGENT_DEFAULT =
  "sc2tools-api/0.1 (+https://sc2tools.com; contact: support@sc2tools.com)";

class LadderMapPoolService {
  /**
   * @param {{
   *   fetchImpl?: typeof globalThis.fetch,
   *   now?: () => number,
   *   persistPath?: string,
   *   userAgent?: string,
   *   logger?: import('pino').Logger,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.now = opts.now || (() => Date.now());
    this.persistPath = opts.persistPath || PERSIST_PATH;
    this.userAgent = opts.userAgent || USER_AGENT_DEFAULT;
    this.logger = opts.logger || NOOP_LOGGER;
    /** @type {{ maps: string[], fetchedAt: number, source: 'liquipedia' | 'persisted' | 'fallback' } | null} */
    this._cache = null;
    /** @type {Promise<{ maps: string[], source: string, fetchedAt: number | null }> | null} */
    this._inflight = null;
  }

  /**
   * Get the current map pool. Returns the cached payload when fresh;
   * otherwise triggers a background refresh and serves whatever we
   * currently have — the cache is "stale-while-revalidate" past the TTL,
   * NOT throwing on a stale read, since Bingo needs *some* answer to
   * generate the weekly card.
   *
   * @returns {Promise<{ maps: string[], source: 'liquipedia' | 'persisted' | 'fallback', fetchedAt: number | null }>}
   */
  async get() {
    const now = this.now();
    if (this._cache && now - this._cache.fetchedAt < SEVEN_DAYS_MS) {
      return {
        maps: this._cache.maps.slice(),
        source: this._cache.source,
        fetchedAt: this._cache.fetchedAt,
      };
    }
    // Cache miss or stale → resolve via the full chain, but only run
    // one refresh at a time across concurrent callers.
    if (!this._inflight) {
      this._inflight = this._resolve().finally(() => {
        this._inflight = null;
      });
    }
    return this._inflight;
  }

  /**
   * Force a refresh from Liquipedia. Writes the persisted file on
   * success, returns the diff between the previous cache and the new
   * one for log lines. Safe to call from a cron job.
   *
   * @param {{ force?: boolean }} [opts]
   * @returns {Promise<{ maps: string[], added: string[], removed: string[], source: string }>}
   */
  async refresh(opts = {}) {
    const prevMaps = this._cache ? this._cache.maps.slice() : [];
    let next = null;
    if (opts.force || !this._cache) {
      next = await this._fetchFromLiquipedia();
    } else {
      next = await this._fetchFromLiquipedia();
    }
    if (next && next.length > 0) {
      const now = this.now();
      this._cache = { maps: next, fetchedAt: now, source: "liquipedia" };
      await this._writePersisted(next, now);
      const added = next.filter((m) => !prevMaps.includes(m));
      const removed = prevMaps.filter((m) => !next.includes(m));
      this.logger.info(
        { added, removed, count: next.length },
        "ladderMapPool_refreshed",
      );
      return { maps: next.slice(), added, removed, source: "liquipedia" };
    }
    // Network failed; keep whatever we had.
    return {
      maps: prevMaps,
      added: [],
      removed: [],
      source: this._cache?.source || "fallback",
    };
  }

  /** @returns {Promise<{ maps: string[], source: string, fetchedAt: number | null }>} */
  async _resolve() {
    // 1) Try Liquipedia.
    const fromNet = await this._fetchFromLiquipedia();
    if (fromNet && fromNet.length > 0) {
      const now = this.now();
      this._cache = { maps: fromNet, fetchedAt: now, source: "liquipedia" };
      // Await the persist so callers (and tests) can rely on the
      // file existing once get() resolves. _writePersisted is
      // exception-safe — never throws into _resolve.
      await this._writePersisted(fromNet, now);
      return { maps: fromNet.slice(), source: "liquipedia", fetchedAt: now };
    }
    // 2) Try the persisted last-good file.
    const persisted = await this._readPersisted();
    if (persisted && persisted.maps.length > 0) {
      this._cache = {
        maps: persisted.maps,
        fetchedAt: persisted.fetchedAt ?? this.now(),
        source: "persisted",
      };
      return {
        maps: persisted.maps.slice(),
        source: "persisted",
        fetchedAt: persisted.fetchedAt ?? null,
      };
    }
    // 3) Hardcoded last-resort.
    return {
      maps: FALLBACK_POOL.slice(),
      source: "fallback",
      fetchedAt: null,
    };
  }

  /** @returns {Promise<string[] | null>} */
  async _fetchFromLiquipedia() {
    if (!this.fetchImpl) return null;
    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      : null;
    try {
      const res = await this.fetchImpl(LIQUIPEDIA_API, {
        signal: controller ? controller.signal : undefined,
        headers: {
          accept: "application/json",
          "user-agent": this.userAgent,
        },
      });
      if (!res.ok) {
        this.logger.warn({ status: res.status }, "ladderMapPool_http_error");
        return null;
      }
      const json = await res.json();
      const wikitext = json?.parse?.wikitext?.["*"];
      if (typeof wikitext !== "string" || wikitext.length === 0) return null;
      const parsed = parseCurrentMaps(wikitext);
      if (parsed.length === 0) {
        this.logger.warn({}, "ladderMapPool_no_maps_parsed");
        return null;
      }
      return parsed;
    } catch (err) {
      this.logger.warn(
        { err: err && err.message ? err.message : String(err) },
        "ladderMapPool_fetch_failed",
      );
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** @returns {Promise<{ maps: string[], fetchedAt: number | null } | null>} */
  async _readPersisted() {
    try {
      const raw = await fs.readFile(this.persistPath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.maps)) return null;
      const maps = parsed.maps.filter(
        (m) => typeof m === "string" && m.trim().length > 0,
      );
      if (maps.length === 0) return null;
      const fetchedAt =
        typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : null;
      return { maps, fetchedAt };
    } catch {
      return null;
    }
  }

  /**
   * Atomic write: write to a tmp sibling then rename. Prevents a
   * crashed write from leaving a half-written JSON the next cold
   * start can't parse.
   *
   * @param {string[]} maps
   * @param {number} fetchedAt
   */
  async _writePersisted(maps, fetchedAt) {
    const payload = JSON.stringify(
      { maps, fetchedAt, schemaVersion: 1 },
      null,
      2,
    );
    const tmp = `${this.persistPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fs.mkdir(path.dirname(this.persistPath), { recursive: true });
      await fs.writeFile(tmp, payload, "utf8");
      await fs.rename(tmp, this.persistPath);
    } catch (err) {
      this.logger.warn(
        { err: err && err.message ? err.message : String(err) },
        "ladderMapPool_persist_failed",
      );
      // Try to clean up the tmp on failure.
      fs.unlink(tmp).catch(() => {});
    }
  }
}

const NOOP_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
};

/**
 * Parse the "Current Maps" section out of the Liquipedia
 * Maps/Ladder_Maps/Legacy_of_the_Void wikitext. The section ends at
 * the next `==` heading (or end of file). Inside the section we
 * extract every `|map=<name>` parameter value from MapList /
 * MapDisplay templates and dedupe preserving first-seen order.
 *
 * Exported for tests.
 *
 * @param {string} wikitext
 * @returns {string[]}
 */
function parseCurrentMaps(wikitext) {
  if (typeof wikitext !== "string") return [];
  // Find the "Current Maps" heading. Liquipedia uses either
  // "== Current Maps ==" or "==Current Maps==" or "== Current Map Pool ==".
  const headingRe = /^\s*==+\s*Current\s+Map(?:s|\s*Pool)?\s*==+\s*$/im;
  const headingMatch = wikitext.match(headingRe);
  if (!headingMatch || headingMatch.index === undefined) return [];
  const after = wikitext.slice(headingMatch.index + headingMatch[0].length);
  // Find the next heading of any level (== ... == on its own line) and
  // bound the section there. Otherwise consume to end.
  const nextHeading = after.match(/^\s*==+[^\n=][^\n]*==+\s*$/m);
  const section =
    nextHeading && nextHeading.index !== undefined
      ? after.slice(0, nextHeading.index)
      : after;
  // Pull |map=<name> parameter values. Names may contain spaces, hyphens,
  // apostrophes, parentheses; they end at the next `|` or `}}`.
  const out = [];
  const seen = new Set();
  const paramRe = /\|\s*map\s*=\s*([^|}\n]+?)\s*(?=\||\}\})/gi;
  let m;
  while ((m = paramRe.exec(section)) !== null) {
    const name = m[1].trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

module.exports = {
  LadderMapPoolService,
  parseCurrentMaps,
  FALLBACK_POOL,
};
