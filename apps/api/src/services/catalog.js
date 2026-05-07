"use strict";

const fs = require("fs");
const path = require("path");
const { LIMITS, PYTHON } = require("../config/constants");
const { gamesMatchStage } = require("../util/parseQuery");
const { resolveProjectDir } = require("../util/pythonRunner");

/**
 * CatalogService — serves the SC2 unit / building catalog, the timing
 * definitions reference, the per-user CSV export, and pass-through
 * map-image / playback static asset proxies.
 *
 * The catalog itself comes from `sc2_catalog.json` next to the
 * analyzer's Python source. We load it once on first request and cache
 * it in memory; the underlying file is shipped with the Render image
 * via the Dockerfile, so this is hot-readable.
 */
class CatalogService {
  /**
   * @param {{games: import('mongodb').Collection}} db
   * @param {{ projectDir?: string | null }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.projectDir = opts.projectDir === undefined ? resolveProjectDir() : opts.projectDir;
    this._catalogCache = null;
    this._definitionsCache = null;
    this._mapImageDirs = this._resolveMapImageDirs();
  }

  /**
   * The sc2_catalog: every unit / structure with display name, race,
   * tier, build category. Returned verbatim once loaded; the SPA
   * builds lookups against it.
   *
   * @returns {Promise<object>}
   */
  async catalog() {
    if (this._catalogCache) return this._catalogCache;
    const loaded = await this._loadJsonFile("sc2_catalog.json");
    this._catalogCache = loaded || { units: [], buildings: [] };
    return this._catalogCache;
  }

  /**
   * Synchronous lookup helper used by the per-game-compute service
   * to enrich build_log entries. Loads lazily and caches.
   *
   * @returns {{ lookup: (rawName: string) => object | null }}
   */
  catalogLookup() {
    return {
      /** @param {string} rawName */
      lookup: (rawName) => {
        if (!this._catalogCache) return null;
        /** @type {any[]} */
        const all = [].concat(
          /** @type {any} */ (this._catalogCache.units || []),
          /** @type {any} */ (this._catalogCache.buildings || []),
        );
        const needle = String(rawName || "").toLowerCase();
        for (const entry of all) {
          if (
            entry &&
            (String(entry.name || "").toLowerCase() === needle ||
              String(entry.display || "").toLowerCase() === needle)
          ) {
            return entry;
          }
        }
        return null;
      },
    };
  }

  /**
   * Matchup-aware timing taxonomy + thresholds. Same JSON the local
   * SPA loads at /static/analyzer/timing_catalog.json.
   *
   * @returns {Promise<object>}
   */
  async definitions() {
    if (this._definitionsCache) return this._definitionsCache;
    const loaded = await this._loadJsonFile("definitions.json");
    if (loaded) {
      this._definitionsCache = loaded;
      return loaded;
    }
    // Definitions file is optional — fall back to a minimal baseline
    // so the SPA never crashes.
    this._definitionsCache = {
      version: 0,
      generatedAt: null,
      timings: {},
      buildCategories: [],
    };
    return this._definitionsCache;
  }

  /**
   * Per-user CSV export. Streams up to LIMITS.CSV_EXPORT_MAX_ROWS
   * games as CSV via a generator, so large libraries don't bloat
   * memory.
   *
   * @param {string} userId
   * @param {object} filters
   * @returns {AsyncGenerator<string, void, void>}
   */
  async *exportCsv(userId, filters) {
    const headers = [
      "gameId",
      "date",
      "result",
      "myRace",
      "myBuild",
      "map",
      "durationSec",
      "macroScore",
      "apm",
      "spq",
      "opponent",
      "oppRace",
      "oppMmr",
      "oppLeague",
      "oppStrategy",
      "oppPulseId",
    ];
    yield headers.join(",") + "\n";
    const cursor = this.db.games
      .find(gamesMatchStage(userId, filters), {
        projection: {
          _id: 0,
          gameId: 1,
          date: 1,
          result: 1,
          myRace: 1,
          myBuild: 1,
          map: 1,
          durationSec: 1,
          macroScore: 1,
          apm: 1,
          spq: 1,
          opponent: 1,
        },
      })
      .sort({ date: -1 })
      .limit(LIMITS.CSV_EXPORT_MAX_ROWS);
    for await (const g of cursor) {
      const opp = g.opponent || {};
      const cells = [
        g.gameId,
        toIso(g.date),
        g.result,
        g.myRace,
        g.myBuild,
        g.map,
        g.durationSec,
        g.macroScore,
        g.apm,
        g.spq,
        opp.displayName,
        opp.race,
        opp.mmr,
        opp.leagueId,
        opp.strategy,
        opp.pulseId,
      ];
      yield cells.map(csvCell).join(",") + "\n";
    }
  }

  /**
   * Resolve a map-image path for a stored map name. The source images
   * ship with the analyzer in either ``data/map_assets/`` (PascalCase
   * filenames matching the in-replay map name verbatim) or
   * ``data/map-images/`` (lowercased + snake_cased; this is the layout
   * the legacy reveal-sc2-opponent bundle uses, which is what we ship
   * in production today).
   *
   * We try every (directory × filename-variant × extension) tuple
   * until one resolves so a stored map name like "Acid Plant LE" finds
   * ``acid_plant_le.jpg`` even when only the lowercase bundle is
   * installed.
   *
   * @param {string} mapName
   * @returns {{ path: string, contentType: string } | null}
   */
  mapImagePath(mapName) {
    if (!this._mapImageDirs.length || !mapName) return null;
    const variants = filenameVariants(mapName);
    if (variants.length === 0) return null;
    const extensions = [".jpg", ".png", ".webp"];
    for (const dir of this._mapImageDirs) {
      for (const variant of variants) {
        for (const ext of extensions) {
          const candidate = path.join(dir, `${variant}${ext}`);
          try {
            const stat = fs.statSync(candidate);
            if (stat.isFile()) {
              return {
                path: candidate,
                contentType: contentTypeFor(candidate),
              };
            }
          } catch (_e) {
            // try next
          }
        }
      }
    }
    return null;
  }

  /**
   * Stub for the legacy /playback proxy. The cloud doesn't ship the
   * playback viewer (it requires the user's local SC2 install) — this
   * route returns a 501 with a helpful pointer to the agent.
   */
  playbackInfo() {
    return {
      ok: false,
      code: "playback_local_only",
      message:
        "Playback requires a local StarCraft II install — open the desktop SC2 Tools agent to launch a replay.",
    };
  }

  /**
   * @private
   * @param {string} filename
   */
  async _loadJsonFile(filename) {
    if (!this.projectDir) return null;
    const candidates = [
      path.join(this.projectDir, "data", filename),
      path.join(this.projectDir, filename),
    ];
    for (const candidate of candidates) {
      try {
        const raw = fs.readFileSync(candidate, "utf8");
        return JSON.parse(raw);
      } catch (_e) {
        // try next
      }
    }
    return null;
  }

  /**
   * Resolve every directory we know about that could host map-image
   * assets. Both ``data/map_assets`` (the PascalCase layout the unit
   * tests build) and ``data/map-images`` (the lowercased layout the
   * legacy reveal-sc2-opponent bundle ships) are checked; the explicit
   * env override always wins so deployments with a custom asset volume
   * stay working.
   *
   * @private
   * @returns {string[]}
   */
  _resolveMapImageDirs() {
    /** @type {string[]} */
    const dirs = [];
    /** @param {string} candidate */
    const tryAdd = (candidate) => {
      if (!candidate) return;
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
          if (!dirs.includes(candidate)) dirs.push(candidate);
        }
      } catch (_e) {
        // ignore — a probe failure just means we don't add it
      }
    };
    const fromEnv = process.env.SC2_MAP_IMAGE_DIR;
    if (fromEnv) tryAdd(fromEnv);
    /** @param {string|null|undefined} root */
    const addRoot = (root) => {
      if (!root) return;
      tryAdd(path.join(root, "data", "map_assets"));
      tryAdd(path.join(root, "data", "map-images"));
    };
    addRoot(this.projectDir);
    addRoot(PYTHON.DEFAULT_DIR);
    return dirs;
  }
}

/**
 * Build the list of filename variants we'll try when resolving a
 * map-image asset. Mirrors the two bundle layouts:
 *
 *   - Verbatim (PascalCase, spaces → ``_``): ``Acid Plant LE`` →
 *     ``Acid_Plant_LE`` — matches ``data/map_assets/Acid_Plant_LE.jpg``.
 *   - Lowercase snake_case: ``Acid Plant LE`` → ``acid_plant_le`` —
 *     matches ``data/map-images/acid_plant_le.jpg`` (the legacy bundle).
 *
 * Duplicates are de-duped so we don't fs.statSync the same path twice.
 *
 * @param {string} mapName
 * @returns {string[]}
 */
function filenameVariants(mapName) {
  const safe = sanitiseFilename(mapName);
  if (!safe) return [];
  const variants = [safe, safe.toLowerCase()];
  /** @type {string[]} */
  const out = [];
  for (const v of variants) {
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** @param {unknown} value */
function csvCell(value) {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** @param {unknown} value */
function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return "";
}

/** @param {string} name */
function sanitiseFilename(name) {
  return String(name)
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 200);
}

/** @param {string} filePath */
function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

module.exports = { CatalogService };
