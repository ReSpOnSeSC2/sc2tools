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
    this._mapImageManifest = loadMapImageManifest(this._mapImageDirs);
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
   * @returns {{ path: string, contentType: string, etag?: string } | null}
   */
  mapImagePath(mapName) {
    if (!this._mapImageDirs.length || !mapName) return null;
    const manifestHit = this._mapImageManifest.get(normalizeMapAssetKey(mapName));
    if (manifestHit) {
      try {
        const stat = fs.statSync(manifestHit.path);
        if (stat.isFile()) {
          return {
            path: manifestHit.path,
            contentType: contentTypeFor(manifestHit.path),
            etag: manifestHit.etag,
          };
        }
      } catch {
        // A stale manifest must not prevent the legacy resolver fallback.
      }
    }
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
  const base = safe.replace(/_(?:ladder_edition|le|te|ce|re)$/i, "");
  const variants = [
    safe,
    safe.toLowerCase(),
    base,
    base.toLowerCase(),
    `${base}_LE`,
    `${base.toLowerCase()}_le`,
  ];
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
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[,'\u2019]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 200);
}

/**
 * Canonical identity used only for artwork lookup. Raw replay map names stay
 * untouched everywhere else because they participate in game IDs and exact
 * analytics filters.
 *
 * @param {string} name
 * @returns {string}
 */
function normalizeMapAssetKey(name) {
  const tokens = String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length >= 2) {
    const tail = tokens[tokens.length - 1];
    if (["le", "te", "ce", "re"].includes(tail)) tokens.pop();
  }
  if (tokens.length >= 2 && tokens.slice(-2).join(" ") === "ladder edition") {
    tokens.splice(-2);
  }
  return tokens.join("");
}

/**
 * Load the generated alias/provenance manifest once at service construction.
 * Invalid entries are ignored individually so an operator can still use the
 * legacy filename resolver while repairing a bad manifest.
 *
 * @param {string[]} dirs
 * @returns {Map<string, {path: string, etag?: string}>}
 */
function loadMapImageManifest(dirs) {
  const index = new Map();
  for (const dir of dirs) {
    const manifestPath = path.join(dir, "manifest.json");
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    const maps = Array.isArray(manifest?.maps) ? manifest.maps : [];
    for (const entry of maps) {
      const rawFilename = String(entry?.image?.filename || "");
      const filename = path.basename(rawFilename);
      if (!filename || filename !== rawFilename) continue;
      const candidate = path.join(dir, filename);
      const sha256 = String(entry?.image?.sha256 || "");
      const etag = /^[a-f0-9]{64}$/i.test(sha256) ? `"${sha256}"` : undefined;
      const names = [entry?.id, entry?.displayName].concat(
        Array.isArray(entry?.aliases) ? entry.aliases : [],
      );
      for (const name of names) {
        const key = normalizeMapAssetKey(String(name || ""));
        if (key && !index.has(key)) index.set(key, { path: candidate, etag });
      }
    }
  }
  return index;
}

/** @param {string} filePath */
function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

module.exports = { CatalogService };
