"use strict";

/**
 * Build check-in options: the builds a player can check in for one matchup,
 * with their record in that matchup. Two sides:
 *
 *   "you"       the user's "you"-perspective custom builds whose race and
 *               opponent race fit the matchup (rule-less ones included) and
 *               the catalog's build names for the matchup
 *               (``buildNamesForMatchup``). Entries of the matchup's
 *               randomizer pool that resolve to an option are marked
 *               ``inRandomizer``; race-generic catalog openers of the user's
 *               race in that pool ("Protoss - DT Rush") are options too.
 *   "opponent"  the opponent's build: the user's opponent-perspective custom
 *               builds fitting the mirrored matchup and the catalog's
 *               opponent strategies for the matchup
 *               (``strategyNamesForMatchup``, never the opponent race's own
 *               build list). No randomizer, no usual build.
 *
 * Generic classifier labels are never options. Records group the user's
 * games of the matchup by effective label: custom builds by slug, catalog
 * builds by name with the 8-worker patch's "8 Pool" names counted under
 * their era-neutral "12 Pool" name. Results are cached per user, matchup and
 * side for a minute; every build check-in write and every custom-build save
 * or delete for the user drops all of that user's entries. Key resolution
 * falls back to the database for ``custom:`` keys, so a build created a
 * moment ago (or on another API instance) is never refused as unknown.
 */

const GUIDE_CATALOG = require("../config/guideCatalog.json");
const { buildNamesForMatchup, strategyNamesForMatchup } = require("../config/guideSlugs");
const { BUILD_INTENT } = require("../config/constants");
const {
  MATCHUP_RE,
  COUNTED_BY_CHECKIN_EXPR,
  OPP_COUNTED_BY_CHECKIN_EXPR,
  catalogKeyForName,
  customKeyForSlug,
  parseBuildKey,
} = require("./buildIntentShape");
const { isGenericLabel, rulesForBuild, twelvePoolName } = require("./buildIntentSuggest");
const { randomizerPool, readBuildIntentPrefs } = require("./buildIntentPrefs");

const MATCHUPS = Object.freeze(["PvP", "PvT", "PvZ", "TvP", "TvT", "TvZ", "ZvP", "ZvT", "ZvZ"]);
const ANY_OPPONENT_RACES = new Set(["", "Any"]);
const RACE_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({
  P: "Protoss", T: "Terran", Z: "Zerg",
}));
const OPPONENT_CACHE_SUFFIX = "\u0000opp";

/**
 * Per side: the label fields its records group by, and its check-in count.
 * @type {Readonly<Record<Side, { label: string, slug: string, checkins: Record<string, unknown> }>>}
 */
const SIDE_FIELDS = Object.freeze({
  you: { label: "$myBuild", slug: "$_customBuildSlug", checkins: COUNTED_BY_CHECKIN_EXPR },
  opponent: {
    label: "$opponent.strategy",
    slug: "$_customOpponentStrategySlug",
    checkins: OPP_COUNTED_BY_CHECKIN_EXPR,
  },
});

/** @typedef {import('./buildIntentAttribution').BuildRef} BuildRef */
/** @typedef {import('./buildIntentSuggest').BuildOption} BuildOption */
/** @typedef {import('./buildIntentSuggest').CustomRuleSet} CustomRuleSet */
/** @typedef {"you"|"opponent"} Side */
/**
 * @typedef {{
 *   matchup: string, side: Side, randomizerEnabled: boolean, usualKey: string|null, builds: BuildOption[],
 * }} OptionsPayload
 * @typedef {{ ref: BuildRef, race: string|null, vsRace: string|null }} ResolvedBuild
 * @typedef {{ games: number, wins: number, losses: number, checkins: number, recent: number, last: Date|null }} RecordStats
 */

/**
 * Every catalog opener by key (era-neutral names), for keys that may name a
 * build of another matchup (a post-game answer before the matchup is known).
 * @type {Map<string, { name: string, race: string|null }>}
 */
const CATALOG_BY_KEY = new Map();
for (const entry of /** @type {Array<Record<string, any>>} */ (GUIDE_CATALOG)) {
  if (!entry || entry.opener !== true || typeof entry.name !== "string") continue;
  const name = twelvePoolName(entry.name);
  if (!name || isGenericLabel(name)) continue;
  CATALOG_BY_KEY.set(catalogKeyForName(name), {
    name,
    race: typeof entry.race === "string" ? entry.race : null,
  });
}

/**
 * First letter of a race word ("Protoss" → "P"); "" when unknown.
 * @param {unknown} race
 * @returns {string}
 */
function raceLetter(race) {
  return typeof race === "string" && race.length > 0 ? race.charAt(0).toUpperCase() : "";
}

/**
 * Does a custom build's race / opponent race fit the matchup?
 * @param {{ race?: unknown, vsRace?: unknown }} build
 * @param {string} matchup
 * @returns {boolean}
 */
function customFitsMatchup(build, matchup) {
  if (raceLetter(build.race) !== matchup.charAt(0)) return false;
  const vs = build.vsRace;
  if (vs === null || vs === undefined) return true;
  if (typeof vs !== "string") return false;
  return ANY_OPPONENT_RACES.has(vs) || raceLetter(vs) === matchup.charAt(2);
}

/**
 * "ZvP" for "PvZ": the matchup from the opponent's side.
 * @param {string} matchup
 * @returns {string}
 */
function mirrorMatchup(matchup) {
  return `${matchup.charAt(2)}v${matchup.charAt(0)}`;
}

/**
 * A race-generic catalog opener of the user's own race ("Protoss - DT
 * Rush" in PvZ). The guide's Protoss build lists only carry "PvX - …"
 * names, but the web randomizer offers these openers for every Protoss
 * matchup.
 * @param {string} name era-neutral catalog name
 * @param {unknown} race the catalog entry's race
 * @param {string} matchup
 * @returns {boolean}
 */
function isOwnRaceGeneric(name, race, matchup) {
  const letter = matchup.charAt(0);
  return raceLetter(race) === letter
    && Object.hasOwn(RACE_WORDS, letter)
    && name.startsWith(`${RACE_WORDS[letter]} - `)
    && !isGenericLabel(name);
}

/**
 * Does a resolved build fit the matchup as the user's own build? Catalog
 * builds by era-neutral name in the matchup's catalog (or as an own-race
 * generic opener); custom builds by race and opponent race.
 * @param {ResolvedBuild} resolved
 * @param {string|null} matchup
 * @returns {boolean}
 */
function fitsMatchup(resolved, matchup) {
  if (!matchup || !MATCHUP_RE.test(matchup)) return false;
  if (resolved.ref.source === "custom") {
    return customFitsMatchup({ race: resolved.race, vsRace: resolved.vsRace }, matchup);
  }
  const name = twelvePoolName(resolved.ref.name);
  if (name === null) return false;
  return buildNamesForMatchup(matchup).includes(name) || isOwnRaceGeneric(name, resolved.race, matchup);
}

/**
 * Does a resolved build fit the matchup as the opponent's build? Catalog
 * builds by era-neutral name among the matchup's opponent strategies;
 * opponent-perspective custom builds by race (the opponent's) and opponent
 * race (the user's).
 * @param {ResolvedBuild} resolved
 * @param {string|null} matchup the user's matchup
 * @returns {boolean}
 */
function fitsOpponentMatchup(resolved, matchup) {
  if (!matchup || !MATCHUP_RE.test(matchup)) return false;
  if (resolved.ref.source === "custom") {
    return customFitsMatchup({ race: resolved.race, vsRace: resolved.vsRace }, mirrorMatchup(matchup));
  }
  const name = twelvePoolName(resolved.ref.name);
  return name !== null && !isGenericLabel(name) && strategyNamesForMatchup(matchup).includes(name);
}

/**
 * The opponent's catalog builds for a matchup: era-neutral, generic labels
 * dropped, each name once.
 * @param {string} matchup
 * @returns {string[]}
 */
function opponentCatalogNames(matchup) {
  /** @type {string[]} */
  const names = [];
  for (const raw of strategyNamesForMatchup(matchup)) {
    const name = twelvePoolName(raw);
    if (name && !isGenericLabel(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

/** @param {Side} side */
function perspectiveFilter(side) {
  return side === "opponent" ? "opponent" : { $ne: "opponent" };
}

/** @returns {RecordStats} */
function emptyStats() {
  return { games: 0, wins: 0, losses: 0, checkins: 0, recent: 0, last: null };
}

/**
 * @param {RecordStats} into
 * @param {Record<string, any>} row
 */
function addStats(into, row) {
  into.games += Number(row.games) || 0;
  into.wins += Number(row.wins) || 0;
  into.losses += Number(row.losses) || 0;
  into.checkins += Number(row.checkins) || 0;
  into.recent += Number(row.recent) || 0;
  const last = row.last instanceof Date ? row.last : null;
  if (last && (!into.last || last > into.last)) into.last = last;
}

/** @param {RecordStats} record */
function lastPlayedMs(record) {
  return record.last ? record.last.getTime() : 0;
}

/**
 * @param {BuildRef} ref
 * @param {RecordStats} record
 * @param {boolean} inRandomizer
 * @param {number|undefined} ruleCount custom builds only
 * @returns {BuildOption}
 */
function toOption(ref, record, inRandomizer, ruleCount) {
  return {
    key: ref.key,
    name: ref.name,
    slug: ref.slug,
    source: ref.source,
    games: record.games,
    wins: record.wins,
    losses: record.losses,
    checkins: record.checkins,
    lastPlayedAt: record.last ? record.last.toISOString() : null,
    inRandomizer,
    group: ref.source === "custom" || record.games > 0 || inRandomizer ? "yours" : "all",
    ...(ruleCount === undefined ? {} : { ruleCount }),
  };
}

/** @param {string} field */
function resultIs(field) {
  return (/** @type {string[]} */ values) => ({
    $cond: [{ $in: [{ $toLower: { $ifNull: [field, ""] } }, values] }, 1, 0],
  });
}

/**
 * Order: "yours" (custom, played, or in the randomizer pool) by games,
 * recency, custom first, then name; then "all" (the rest of the catalog)
 * by name.
 * @param {BuildOption} a
 * @param {BuildOption} b
 */
function compareOptions(a, b) {
  if (a.group !== b.group) return a.group === "yours" ? -1 : 1;
  if (a.group === "all") return a.name.localeCompare(b.name);
  return (
    b.games - a.games
    || String(b.lastPlayedAt || "").localeCompare(String(a.lastPlayedAt || ""))
    || (a.source === b.source ? 0 : a.source === "custom" ? -1 : 1)
    || a.name.localeCompare(b.name)
  );
}

class BuildIntentOptions {
  /**
   * @param {{
   *   games: import('mongodb').Collection,
   *   customBuilds: import('mongodb').Collection,
   *   users: import('mongodb').Collection,
   * }} db
   * @param {{ now?: () => number }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.now = opts.now || Date.now;
    /** @type {Map<string, { expiresAt: number, value: OptionsPayload }>} */
    this.cache = new Map();
  }

  /**
   * The user's own build options ("you" side).
   * @param {string} userId
   * @param {string} matchup "PvZ" form (validated by the caller)
   * @returns {Promise<OptionsPayload>}
   */
  forMatchup(userId, matchup) {
    return this._cached(`${userId}\u0000${matchup}`, () => this._compute(userId, matchup));
  }

  /**
   * The opponent's build options for the user's matchup.
   * @param {string} userId
   * @param {string} matchup "PvZ" form (validated by the caller)
   * @returns {Promise<OptionsPayload>}
   */
  forOpponent(userId, matchup) {
    return this._cached(
      `${userId}\u0000${matchup}${OPPONENT_CACHE_SUFFIX}`,
      () => this._computeOpponent(userId, matchup),
    );
  }

  /**
   * @param {string} userId
   * @param {string} matchup
   * @param {Side} side
   * @returns {Promise<OptionsPayload>}
   */
  forSide(userId, matchup, side) {
    return side === "opponent" ? this.forOpponent(userId, matchup) : this.forMatchup(userId, matchup);
  }

  /**
   * @param {string} cacheKey
   * @param {() => Promise<OptionsPayload>} compute
   * @returns {Promise<OptionsPayload>}
   */
  async _cached(cacheKey, compute) {
    const hit = this.cache.get(cacheKey);
    if (hit && hit.expiresAt > this.now()) return hit.value;
    this.cache.delete(cacheKey);
    const value = await compute();
    this.cache.set(cacheKey, { expiresAt: this.now() + BUILD_INTENT.OPTIONS_CACHE_MS, value });
    while (this.cache.size > BUILD_INTENT.OPTIONS_CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (typeof oldest !== "string") break;
      this.cache.delete(oldest);
    }
    return value;
  }

  /** Drop every cached matchup of ``userId``, both sides. @param {string} userId */
  invalidate(userId) {
    for (const matchup of MATCHUPS) {
      this.cache.delete(`${userId}\u0000${matchup}`);
      this.cache.delete(`${userId}\u0000${matchup}${OPPONENT_CACHE_SUFFIX}`);
    }
  }

  /**
   * @param {string} userId
   * @param {string} matchup
   * @returns {Promise<OptionsPayload>}
   */
  async _compute(userId, matchup) {
    const [customDocs, stats, prefs] = await Promise.all([
      this.customBuildsForMatchup(userId, matchup),
      this._records(userId, matchup, "you"),
      readBuildIntentPrefs(this.db.users, userId),
    ]);
    const pool = randomizerPool(prefs.randomizer, matchup);
    const poolIds = new Set(pool.enabled ? pool.ids : []);
    const entries = customEntries(customDocs, stats);
    for (const name of buildNamesForMatchup(matchup)) {
      entries.push({
        ref: { key: catalogKeyForName(name), name, slug: null, source: "catalog" },
        record: stats.byName.get(name) || emptyStats(),
      });
    }
    // Own-race generic openers the randomizer can roll get a row of their
    // own, so a roll or declaration of one has an option to land on.
    const present = new Set(entries.map((e) => e.ref.key));
    for (const id of poolIds) {
      const entry = present.has(id) ? undefined : CATALOG_BY_KEY.get(id);
      if (!entry) continue;
      /** @type {BuildRef} */
      const ref = { key: id, name: entry.name, slug: null, source: "catalog" };
      if (!fitsMatchup({ ref, race: entry.race, vsRace: null }, matchup)) continue;
      entries.push({ ref, record: stats.byName.get(entry.name) || emptyStats() });
      present.add(id);
    }
    const usual = entries
      .filter((e) => e.record.recent >= BUILD_INTENT.USUAL_MIN_GAMES)
      .sort((a, b) => (
        b.record.recent - a.record.recent
        || lastPlayedMs(b.record) - lastPlayedMs(a.record)
        || a.ref.name.localeCompare(b.ref.name)
      ))[0];
    const builds = entries.map((e) => toOption(e.ref, e.record, poolIds.has(e.ref.key), e.ruleCount));
    builds.sort(compareOptions);
    return {
      matchup,
      side: "you",
      randomizerEnabled: pool.enabled,
      usualKey: usual ? usual.ref.key : null,
      builds,
    };
  }

  /**
   * @param {string} userId
   * @param {string} matchup
   * @returns {Promise<OptionsPayload>}
   */
  async _computeOpponent(userId, matchup) {
    const [customDocs, stats] = await Promise.all([
      this.customBuildsForMatchup(userId, matchup, "opponent"),
      this._records(userId, matchup, "opponent"),
    ]);
    const entries = customEntries(customDocs, stats);
    for (const name of opponentCatalogNames(matchup)) {
      entries.push({
        ref: { key: catalogKeyForName(name), name, slug: null, source: "catalog" },
        record: stats.byName.get(name) || emptyStats(),
      });
    }
    const builds = entries.map((e) => toOption(e.ref, e.record, false, e.ruleCount));
    builds.sort(compareOptions);
    return { matchup, side: "opponent", randomizerEnabled: false, usualKey: null, builds };
  }

  /**
   * The user's live custom builds of one side that fit the matchup: "you"
   * builds by race / opponent race, opponent-perspective builds by the
   * mirrored matchup (their race is the opponent's).
   * @param {string} userId
   * @param {string} matchup
   * @param {Side} [side]
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async customBuildsForMatchup(userId, matchup, side = "you") {
    const docs = /** @type {Array<Record<string, any>>} */ (await this.db.customBuilds
      .find(
        { userId, deletedAt: { $exists: false }, perspective: perspectiveFilter(side) },
        {
          projection: {
            _id: 0, slug: 1, name: 1, race: 1, vsRace: 1, rules: 1, signature: 1, updatedAt: 1,
          },
        },
      )
      .toArray());
    const fit = side === "opponent" ? mirrorMatchup(matchup) : matchup;
    return docs.filter((doc) => typeof doc.slug === "string" && customFitsMatchup(doc, fit));
  }

  /**
   * Rules of the matchup's custom builds of one side, for the suggestion
   * engine.
   * @param {string} userId
   * @param {string} matchup
   * @param {Side} [side]
   * @returns {Promise<Map<string, CustomRuleSet>>}
   */
  async customRules(userId, matchup, side = "you") {
    const docs = await this.customBuildsForMatchup(userId, matchup, side);
    /** @type {Map<string, CustomRuleSet>} */
    const out = new Map();
    for (const doc of docs) {
      out.set(String(doc.slug), {
        rules: rulesForBuild(doc),
        updatedAt: new Date(doc.updatedAt || 0).getTime() || 0,
      });
    }
    return out;
  }

  /**
   * @param {string} userId
   * @param {string} matchup
   * @param {Side} side
   * @returns {Promise<{ bySlug: Map<string, RecordStats>, byName: Map<string, RecordStats> }>}
   */
  async _records(userId, matchup, side) {
    const fields = SIDE_FIELDS[side];
    const since = new Date(this.now() - BUILD_INTENT.USUAL_WINDOW_MS);
    const rows = await this.db.games
      .aggregate([
        {
          $match: {
            userId,
            myRace: { $regex: `^${matchup.charAt(0)}`, $options: "i" },
            "opponent.race": { $regex: `^${matchup.charAt(2)}`, $options: "i" },
            isResumedFromReplay: { $ne: true },
          },
        },
        {
          $group: {
            _id: {
              name: { $ifNull: [fields.label, null] },
              slug: { $ifNull: [fields.slug, null] },
            },
            games: { $sum: 1 },
            wins: { $sum: resultIs("$result")(["win", "victory"]) },
            losses: { $sum: resultIs("$result")(["loss", "defeat"]) },
            checkins: { $sum: fields.checkins },
            recent: { $sum: { $cond: [{ $gte: ["$date", since] }, 1, 0] } },
            last: { $max: "$date" },
          },
        },
      ])
      .toArray();
    /** @type {Map<string, RecordStats>} */
    const bySlug = new Map();
    /** @type {Map<string, RecordStats>} */
    const byName = new Map();
    for (const row of rows) {
      const id = row._id || {};
      if (typeof id.slug === "string" && id.slug) {
        if (!bySlug.has(id.slug)) bySlug.set(id.slug, emptyStats());
        addStats(/** @type {RecordStats} */ (bySlug.get(id.slug)), row);
        continue;
      }
      const name = twelvePoolName(id.name);
      if (!name) continue;
      if (!byName.has(name)) byName.set(name, emptyStats());
      addStats(/** @type {RecordStats} */ (byName.get(name)), row);
    }
    return { bySlug, byName };
  }

  /**
   * Resolve a "you" build key for a concrete matchup: an option of the
   * matchup; else the user's live custom build when it fits the matchup
   * (created after the options were cached); else an entry of the matchup's
   * randomizer pool that names a catalog build fitting the matchup.
   * Name/slug/source always come from the server.
   *
   * @param {string} userId
   * @param {string} matchup
   * @param {unknown} key
   * @returns {Promise<BuildRef|null>}
   */
  async resolveKey(userId, matchup, key) {
    const parsed = parseBuildKey(key);
    if (!parsed || !MATCHUP_RE.test(matchup)) return null;
    const options = await this.forMatchup(userId, matchup);
    const option = options.builds.find((b) => b.key === key);
    if (option) return refOf(option);
    if (parsed.source === "custom") {
      const resolved = await this.resolveForUser(userId, key);
      return resolved && fitsMatchup(resolved, matchup) ? resolved.ref : null;
    }
    const prefs = await readBuildIntentPrefs(this.db.users, userId);
    if (!randomizerPool(prefs.randomizer, matchup).ids.includes(parsed.key)) return null;
    const resolved = await this.resolveForUser(userId, key);
    return resolved && fitsMatchup(resolved, matchup) ? resolved.ref : null;
  }

  /**
   * Resolve an opponent build key for the user's matchup: an opponent
   * option, else the user's live opponent-perspective custom build when it
   * fits the mirrored matchup.
   *
   * @param {string} userId
   * @param {string} matchup
   * @param {unknown} key
   * @returns {Promise<BuildRef|null>}
   */
  async resolveOpponentKey(userId, matchup, key) {
    const parsed = parseBuildKey(key);
    if (!parsed || !MATCHUP_RE.test(matchup)) return null;
    const options = await this.forOpponent(userId, matchup);
    const option = options.builds.find((b) => b.key === key);
    if (option) return refOf(option);
    if (parsed.source !== "custom") return null;
    const resolved = await this.resolveForUser(userId, key, "opponent");
    return resolved && fitsOpponentMatchup(resolved, matchup) ? resolved.ref : null;
  }

  /**
   * Resolve a key without a matchup: the user's live custom build of that
   * side, or any catalog opener.
   *
   * @param {string} userId
   * @param {unknown} key
   * @param {Side} [side]
   * @returns {Promise<ResolvedBuild|null>}
   */
  async resolveForUser(userId, key, side = "you") {
    const parsed = parseBuildKey(key);
    if (!parsed) return null;
    if (parsed.source === "custom") {
      const doc = await this.db.customBuilds.findOne(
        {
          userId,
          slug: parsed.slug,
          deletedAt: { $exists: false },
          perspective: perspectiveFilter(side),
        },
        { projection: { _id: 0, slug: 1, name: 1, race: 1, vsRace: 1 } },
      );
      if (!doc) return null;
      return {
        ref: {
          key: customKeyForSlug(parsed.slug),
          name: String(doc.name || parsed.slug),
          slug: parsed.slug,
          source: "custom",
        },
        race: typeof doc.race === "string" ? doc.race : null,
        vsRace: typeof doc.vsRace === "string" ? doc.vsRace : null,
      };
    }
    const entry = CATALOG_BY_KEY.get(parsed.key);
    if (!entry) return null;
    return {
      ref: { key: parsed.key, name: entry.name, slug: null, source: "catalog" },
      race: entry.race,
      vsRace: null,
    };
  }

  /**
   * Is there a live custom build of that side with this slug?
   * @param {string} userId
   * @param {string} slug
   * @param {Side} [side]
   * @returns {Promise<boolean>}
   */
  async customBuildExists(userId, slug, side = "you") {
    const doc = await this.db.customBuilds.findOne(
      { userId, slug, deletedAt: { $exists: false }, perspective: perspectiveFilter(side) },
      { projection: { _id: 1 } },
    );
    return Boolean(doc);
  }
}

/**
 * @param {Array<Record<string, any>>} docs fitting custom builds
 * @param {{ bySlug: Map<string, RecordStats> }} stats
 * @returns {Array<{ ref: BuildRef, record: RecordStats, ruleCount?: number }>}
 */
function customEntries(docs, stats) {
  return docs.map((doc) => {
    const slug = String(doc.slug);
    return {
      ref: { key: customKeyForSlug(slug), name: String(doc.name || slug), slug, source: /** @type {const} */ ("custom") },
      record: stats.bySlug.get(slug) || emptyStats(),
      ruleCount: rulesForBuild(doc).length,
    };
  });
}

/**
 * @param {BuildOption} option
 * @returns {BuildRef}
 */
function refOf(option) {
  return { key: option.key, name: option.name, slug: option.slug, source: option.source };
}

module.exports = {
  BuildIntentOptions,
  MATCHUPS,
  fitsMatchup,
  fitsOpponentMatchup,
  customFitsMatchup,
  mirrorMatchup,
};
