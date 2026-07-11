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
    /** @type {{ maps: string[], teamMaps: string[], fetchedAt: number, source: 'liquipedia' | 'persisted' | 'fallback' } | null} */
    this._cache = null;
    /** @type {Promise<{ maps: string[], teamMaps: string[], source: 'liquipedia' | 'persisted' | 'fallback', fetchedAt: number | null }> | null} */
    this._inflight = null;
  }

  /**
   * Get the current map pool. Returns the cached payload when fresh;
   * otherwise triggers a background refresh and serves whatever we
   * currently have — the cache is "stale-while-revalidate" past the TTL,
   * NOT throwing on a stale read, since Bingo needs *some* answer to
   * generate the weekly card.
   *
   * ``maps`` is the 1v1 pool (the Bingo / season-catalog rotation);
   * ``teamMaps`` is the combined 2v2/3v3/4v4 pool.
   *
   * @returns {Promise<{ maps: string[], teamMaps: string[], source: 'liquipedia' | 'persisted' | 'fallback', fetchedAt: number | null }>}
   */
  async get() {
    const now = this.now();
    if (this._cache && now - this._cache.fetchedAt < SEVEN_DAYS_MS) {
      return {
        maps: this._cache.maps.slice(),
        teamMaps: (this._cache.teamMaps || []).slice(),
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
   * Always re-fetches (the cron passes through unconditionally).
   *
   * @returns {Promise<{ maps: string[], teamMaps: string[], added: string[], removed: string[], source: string }>}
   */
  async refresh() {
    const prevMaps = this._cache ? this._cache.maps.slice() : [];
    const next = await this._fetchFromLiquipedia();
    if (next && (next.solo.length > 0 || next.team.length > 0)) {
      const now = this.now();
      this._cache = {
        maps: next.solo,
        teamMaps: next.team,
        fetchedAt: now,
        source: "liquipedia",
      };
      await this._writePersisted(next.solo, next.team, now);
      // Diff reported on the 1v1 pool — that's the rotation Bingo and
      // the season catalog care about.
      const added = next.solo.filter((m) => !prevMaps.includes(m));
      const removed = prevMaps.filter((m) => !next.solo.includes(m));
      this.logger.info(
        { added, removed, count: next.solo.length, teamCount: next.team.length },
        "ladderMapPool_refreshed",
      );
      return {
        maps: next.solo.slice(),
        teamMaps: next.team.slice(),
        added,
        removed,
        source: "liquipedia",
      };
    }
    // Network failed; keep whatever we had.
    return {
      maps: prevMaps,
      teamMaps: this._cache ? (this._cache.teamMaps || []).slice() : [],
      added: [],
      removed: [],
      source: this._cache?.source || "fallback",
    };
  }

  /** @returns {Promise<{ maps: string[], teamMaps: string[], source: 'liquipedia' | 'persisted' | 'fallback', fetchedAt: number | null }>} */
  async _resolve() {
    // 1) Try Liquipedia.
    const fromNet = await this._fetchFromLiquipedia();
    if (fromNet && (fromNet.solo.length > 0 || fromNet.team.length > 0)) {
      const now = this.now();
      this._cache = {
        maps: fromNet.solo,
        teamMaps: fromNet.team,
        fetchedAt: now,
        source: "liquipedia",
      };
      // Await the persist so callers (and tests) can rely on the
      // file existing once get() resolves. _writePersisted is
      // exception-safe — never throws into _resolve.
      await this._writePersisted(fromNet.solo, fromNet.team, now);
      return {
        maps: fromNet.solo.slice(),
        teamMaps: fromNet.team.slice(),
        source: "liquipedia",
        fetchedAt: now,
      };
    }
    // 2) Try the persisted last-good file.
    const persisted = await this._readPersisted();
    if (persisted && (persisted.maps.length > 0 || persisted.teamMaps.length > 0)) {
      this._cache = {
        maps: persisted.maps,
        teamMaps: persisted.teamMaps,
        fetchedAt: persisted.fetchedAt ?? this.now(),
        source: "persisted",
      };
      return {
        maps: persisted.maps.slice(),
        teamMaps: persisted.teamMaps.slice(),
        source: "persisted",
        fetchedAt: persisted.fetchedAt ?? null,
      };
    }
    // 3) Hardcoded last-resort (1v1 pool only; no team fallback list).
    return {
      maps: FALLBACK_POOL.slice(),
      teamMaps: [],
      source: "fallback",
      fetchedAt: null,
    };
  }

  /** @returns {Promise<{ solo: string[], team: string[] } | null>} */
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
      const parsed = parseLadderMaps(wikitext);
      if (parsed.solo.length === 0 && parsed.team.length === 0) {
        this.logger.warn({}, "ladderMapPool_no_maps_parsed");
        return null;
      }
      return parsed;
    } catch (err) {
      this.logger.warn(
        {
          err:
            err && /** @type {{ message?: unknown }} */ (err).message
              ? /** @type {{ message?: unknown }} */ (err).message
              : String(err),
        },
        "ladderMapPool_fetch_failed",
      );
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** @returns {Promise<{ maps: string[], teamMaps: string[], fetchedAt: number | null } | null>} */
  async _readPersisted() {
    try {
      const raw = await fs.readFile(this.persistPath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.maps)) return null;
      /** @param {unknown} arr @returns {string[]} */
      const clean = (arr) =>
        (Array.isArray(arr) ? arr : []).filter(
          (m) => typeof m === "string" && m.trim().length > 0,
        );
      const maps = clean(parsed.maps);
      // ``teamMaps`` was added in schema v2; v1 files (1v1-only) read
      // back as an empty team pool, which is correct — they predate
      // team-map tracking.
      const teamMaps = clean(parsed.teamMaps);
      if (maps.length === 0 && teamMaps.length === 0) return null;
      const fetchedAt =
        typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : null;
      return { maps, teamMaps, fetchedAt };
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
   * @param {string[]} teamMaps
   * @param {number} fetchedAt
   */
  async _writePersisted(maps, teamMaps, fetchedAt) {
    const payload = JSON.stringify(
      { maps, teamMaps, fetchedAt, schemaVersion: 2 },
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
        {
          err:
            err && /** @type {{ message?: unknown }} */ (err).message
              ? /** @type {{ message?: unknown }} */ (err).message
              : String(err),
        },
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
 * Parse the ladder map pool out of the Liquipedia
 * Maps/Ladder_Maps/Legacy_of_the_Void wikitext, split into the 1v1
 * ("solo") pool and the combined team (2v2 / 3v3 / 4v4) pool.
 *
 * The page's "Battle.net Legacy of the Void Map Pool" section renders a
 * single ``{{Ladder maps display}}`` template whose parameters are
 * ``|<mode>_<n>=<Map Name>`` for the map names and
 * ``|<mode>_<n>text=<blurb>`` for the descriptions — e.g.
 * ``|1v1_1=10000 Feet`` / ``|4v4_2=Concord LE``. We extract only the
 * name params (the ``text`` siblings never match because a digit is
 * not immediately followed by ``=``), deduped per-bucket preserving
 * first-seen order.
 *
 * A legacy fallback handles the old ``== Current Maps ==`` + ``|map=``
 * layout so a future template revert (or an offline fixture) still
 * resolves; that path only ever fills the solo bucket.
 *
 * Exported for tests.
 *
 * @param {string} wikitext
 * @returns {{ solo: string[], team: string[] }}
 */
function parseLadderMaps(wikitext) {
  if (typeof wikitext !== "string") return { solo: [], team: [] };

  /** @type {string[]} */
  const solo = [];
  /** @type {string[]} */
  const team = [];
  const seenSolo = new Set();
  const seenTeam = new Set();
  // ``|1v1_3=Mothership LE`` → mode "1v1", name "Mothership LE". The
  // ``\d+=`` guard means ``|1v1_3text=...`` is skipped (after the digit
  // comes "text", not "="). Names run to the next ``|`` or newline.
  const modeRe = /\|\s*(1v1|2v2|3v3|4v4)_(\d+)\s*=\s*([^|\n}]+)/gi;
  let m;
  while ((m = modeRe.exec(wikitext)) !== null) {
    const mode = m[1].toLowerCase();
    const name = m[3].trim();
    if (!name) continue;
    const isSolo = mode === "1v1";
    const seen = isSolo ? seenSolo : seenTeam;
    const out = isSolo ? solo : team;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  if (solo.length > 0 || team.length > 0) return { solo, team };

  // Legacy ``== Current Maps ==`` + ``|map=`` layout fallback.
  return { solo: parseCurrentMaps(wikitext), team: [] };
}

/**
 * Legacy parser: the "Current Maps" section's ``|map=`` params. Kept
 * for the old page layout and as the ``parseLadderMaps`` fallback.
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
  parseLadderMaps,
  parseCurrentMaps,
  FALLBACK_POOL,
};
