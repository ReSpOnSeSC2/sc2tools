"use strict";

/**
 * AutoClassifyService — the dry-run brain behind the discovery-engine
 * feature.
 *
 * The cloud already classifies replays at ingest time: the agent's
 * Python detectors stamp a `myBuild` label, and the user's saved
 * custom builds get a second pass via CustomBuildsService.tagSingleGame.
 * Anything neither layer recognises lands in a catch-all bucket the
 * Python core surfaces as "Macro Transition (Unclassified)" /
 * "Unclassified - <Matchup>". Those games are invisible to the per-
 * build analytics until someone manually authors a rule that catches
 * them.
 *
 * `discover()` walks the user's real games (via
 * PerGameComputeService.listForRulePreview, same scan cap the rest of
 * the customBuilds surface area uses), filters to that catch-all
 * bucket, then for each matchup runs:
 *
 *     clusterGames → deriveRules → deriveName
 *
 * (see services/autoClassify/{cluster,deriveBuild,signature}.js).
 *
 * Two firm guardrails:
 *
 *   1. NEVER write. This is the dry-run brain. Promotion to an
 *      actual customBuilds row happens in a separate prompt; here we
 *      just compute candidates and let the route layer decide what to
 *      do with them.
 *   2. NEVER re-tag a game an existing detector or custom build
 *      already claims. `isAlreadyClassified` (services/autoClassify/
 *      scope.js) shares the rule-engine predicates `/reclassify` uses
 *      so the in-scope set is exactly the games the existing system
 *      doesn't already cover.
 *
 * Reuses, doesn't re-implement:
 *   - `customBuilds.extractRules` for the v3 rule shape on saved builds.
 *   - `customBuilds.gameMatchesBuildMatchup` + `filterMatchingGames`
 *     for the race-gate + rule-match check.
 *   - `clusterGames` / `deriveRules` / `deriveName` from the
 *     auto-classify submodules.
 *
 * Pure logic is delegated to those modules; this service is just the
 * orchestration + collision-guard layer.
 */

const { extractRules, STATS_GAME_SCAN_CAP } = require("./customBuilds");
const { validateCustomBuild } = require("../validation/customBuild");
const { clusterGames } = require("./autoClassify/cluster");
const { deriveRules, deriveName } = require("./autoClassify/deriveBuild");
const {
  UNCLASSIFIED_LABEL_RE,
  isAlreadyClassified,
  inferMatchupKey,
  groupGamesByMatchup,
  selectEventsForPerspective,
  perspectiveRace,
  perspectiveVsRace,
  fullRaceName,
  raceLetter,
} = require("./autoClassify/scope");

const DEFAULT_MIN_GAMES = 5;
const DEFAULT_MAX_DISTANCE = 0.2;
const SAMPLE_GAMES_LIMIT = 5;

/**
 * @typedef {{
 *   matchup: string,
 *   perspective: 'you'|'opponent',
 *   proposedName: string,
 *   proposedSlug: string,
 *   race: 'Protoss'|'Terran'|'Zerg',
 *   vsRace: 'Protoss'|'Terran'|'Zerg',
 *   rules: Array<{type:string, name:string, time_lt:number, count?:number}>,
 *   gameCount: number,
 *   winRate: number,
 *   cohesion: number,
 *   selfMatchRate: number,
 *   sampleGames: Array<{gameId: string, map: string|null, result: string|null, date: any}>,
 * }} DiscoveryCandidate
 */

class AutoClassifyService {
  /**
   * @param {{
   *   customBuilds: import('./customBuilds').CustomBuildsService,
   *   perGame: import('./perGameCompute').PerGameComputeService,
   * }} deps
   */
  constructor(deps) {
    if (!deps || !deps.customBuilds) throw new Error("customBuilds required");
    if (!deps.perGame) throw new Error("perGame required");
    this.customBuilds = deps.customBuilds;
    this.perGame = deps.perGame;
  }

  /**
   * Discover candidate custom builds from the user's unclassified
   * games. Reads only — never writes to Mongo. Returns a sorted list
   * of candidates suitable for a UI preview or a follow-up promotion
   * endpoint.
   *
   * @param {string} userId
   * @param {{
   *   perspective?: 'you'|'opponent',
   *   minGames?: number,
   *   maxDistance?: number,
   * }} [opts]
   * @returns {Promise<DiscoveryCandidate[]>}
   */
  async discover(userId, opts = {}) {
    const perspective = opts.perspective === "opponent" ? "opponent" : "you";
    const minGames = positiveIntOr(opts.minGames, DEFAULT_MIN_GAMES);
    const maxDistance = positiveOr(opts.maxDistance, DEFAULT_MAX_DISTANCE);

    const games = await this.perGame.listForRulePreview(userId, {
      limit: STATS_GAME_SCAN_CAP,
    });
    if (!Array.isArray(games) || games.length === 0) return [];

    const builds = await this.customBuilds.list(userId);
    const prepared = prepareCustomBuilds(builds);

    const reservedNames = collectReservedNames(builds, games);
    const reservedSlugs = collectReservedSlugs(builds);

    const inScope = games.filter((g) => !isAlreadyClassified(g, prepared));
    if (inScope.length === 0) return [];

    const buckets = groupGamesByMatchup(inScope);

    /** @type {DiscoveryCandidate[]} */
    const candidates = [];
    for (const [matchup, matchupGames] of buckets) {
      if (matchupGames.length < minGames) continue;
      const candidatesForMatchup = this._discoverInMatchup({
        matchup,
        perspective,
        games: matchupGames,
        minGames,
        maxDistance,
        reservedNames,
        reservedSlugs,
      });
      for (const c of candidatesForMatchup) {
        candidates.push(c);
        reservedNames.add(c.proposedName);
        reservedSlugs.add(c.proposedSlug);
      }
    }

    candidates.sort((a, b) => {
      if (b.gameCount !== a.gameCount) return b.gameCount - a.gameCount;
      if (b.cohesion !== a.cohesion) return b.cohesion - a.cohesion;
      if (a.matchup < b.matchup) return -1;
      if (a.matchup > b.matchup) return 1;
      return a.proposedSlug < b.proposedSlug ? -1 : 1;
    });
    return candidates;
  }

  /**
   * @private
   * @param {{
   *   matchup: string,
   *   perspective: 'you'|'opponent',
   *   games: any[],
   *   minGames: number,
   *   maxDistance: number,
   *   reservedNames: Set<string>,
   *   reservedSlugs: Set<string>,
   * }} args
   * @returns {DiscoveryCandidate[]}
   */
  _discoverInMatchup(args) {
    const { matchup, perspective, games, minGames, maxDistance } = args;
    // Cluster engine expects an `events` field; pass the perspective-
    // appropriate side under that name so the same module works from
    // both viewpoints.
    const clusterInputs = games.map((g) => ({
      gameId: g.gameId,
      events: selectEventsForPerspective(g, perspective),
      result: g.result || null,
      date: g.date || null,
      map: g.map || null,
    }));
    const clusters = clusterGames(clusterInputs, { minGames, maxDistance });
    if (clusters.length === 0) return [];

    /** @type {Map<string, any>} */
    const gamesById = new Map();
    for (const g of games) {
      if (g && g.gameId) gamesById.set(String(g.gameId), g);
    }

    /** @type {DiscoveryCandidate[]} */
    const out = [];
    for (const cluster of clusters) {
      const clusterGamesFull = cluster.gameIds
        .map((id) => gamesById.get(String(id)))
        .filter(Boolean);
      // Pass perspective-appropriate events under .events for the
      // deriveRules / deriveName helpers (they read .events directly).
      const clusterForDerive = clusterGamesFull.map((g) => ({
        ...g,
        events: selectEventsForPerspective(g, perspective),
      }));

      const derivedRules = deriveRules(cluster, clusterForDerive);
      if (!derivedRules) continue;
      const derivedName = deriveName(matchup, cluster, clusterForDerive);
      if (!derivedName) continue;

      // Resolve race / vsRace off the medoid — it's the cluster's most
      // representative game and is guaranteed present in the cluster
      // (so the race fields are populated, since inferMatchupKey
      // already dropped any games missing either side).
      const medoid = gamesById.get(String(cluster.medoidGameId)) ||
        clusterGamesFull[0];
      const race = fullRaceName(perspectiveRace(medoid, perspective));
      const vsRace = fullRaceName(perspectiveVsRace(medoid, perspective));
      if (!race || !vsRace) continue;

      const { proposedName, proposedSlug } = applyCollisionGuard({
        baseName: derivedName.name,
        baseSlug: derivedName.slug,
        reservedNames: args.reservedNames,
        reservedSlugs: args.reservedSlugs,
      });

      const sampleGames = (cluster.sampleGameIds || [])
        .slice(0, SAMPLE_GAMES_LIMIT)
        .map((id) => gamesById.get(String(id)))
        .filter(Boolean)
        .map((g) => ({
          gameId: String(g.gameId || ""),
          map: g.map || null,
          result: g.result || null,
          date: g.date || null,
        }));

      out.push({
        matchup,
        perspective,
        proposedName,
        proposedSlug,
        race,
        vsRace,
        rules: derivedRules.rules,
        gameCount: cluster.size,
        winRate: cluster.winRate,
        cohesion: cluster.cohesion,
        selfMatchRate: derivedRules.selfMatchRate,
        sampleGames,
      });
    }
    return out;
  }

  /**
   * Promote one or more discovery candidates into real custom builds.
   *
   * Validates every candidate first (a single malformed row aborts the
   * whole batch — no partial-garbage writes), upserts each through
   * CustomBuildsService.upsert so the new builds land in the same
   * (userId, slug) keyspace as hand-authored ones, then runs
   * reclassifyAll once with `clearUnmatched: false` so the closest-
   * match ownership rule applies globally. A freshly-created auto
   * build can never steal a game from a more-specific existing build —
   * reclassifyAll's "most rules wins" pass enforces that across the
   * full set of builds the user owns.
   *
   * Idempotent on (userId, slug): the orchestrator emits stable
   * signature-derived slugs (see deriveName + applyCollisionGuard),
   * so re-applying the same candidate updates the existing row in
   * place and reclassifyAll re-stamps the same games under the same
   * name. The `source: 'auto-classify'` field is provenance ONLY;
   * list / stats / publish paths must never gate on it (an auto
   * build is a first-class custom build everywhere else).
   *
   * @param {string} userId
   * @param {ReadonlyArray<{
   *   proposedName: string,
   *   proposedSlug: string,
   *   race: string,
   *   vsRace: string,
   *   rules: Array<{type: string, name: string, time_lt: number, count?: number}>,
   *   perspective?: 'you'|'opponent',
   * }>} candidates
   * @returns {Promise<{
   *   created: string[],
   *   builds: number,
   *   scanned: number,
   *   tagged: number,
   *   cleared: number,
   *   perBuild: Array<{slug: string, name: string, matched: number, tagged: number}>,
   * }>}
   */
  async apply(userId, candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      const err = new Error("candidates_required");
      /** @type {any} */ (err).status = 400;
      throw err;
    }
    /** @type {Array<{slug: string, value: any}>} */
    const docs = [];
    /** @type {Array<{slug: string, errors: string[]}>} */
    const fieldErrors = [];
    for (const c of candidates) {
      const draft = buildApplyDraft(c);
      const v = validateCustomBuild(draft);
      if (!v.valid) {
        fieldErrors.push({
          slug: typeof draft.slug === "string" ? draft.slug : "",
          errors: v.errors,
        });
        continue;
      }
      const value = /** @type {any} */ (v.value);
      docs.push({ slug: String(value.slug), value });
    }
    if (fieldErrors.length > 0) {
      const err = new Error("invalid_candidates");
      /** @type {any} */ (err).status = 400;
      /** @type {any} */ (err).details = fieldErrors;
      throw err;
    }
    /** @type {string[]} */
    const created = [];
    for (const { slug, value } of docs) {
      await this.customBuilds.upsert(userId, value);
      created.push(slug);
    }
    // Global most-specific-wins pass. clearUnmatched stays false on
    // purpose — a game whose tag came from the agent's named catalog
    // (not from any saved build) must keep that tag if no saved build
    // claims it. reclassifyAll only clears tags it owns, and only
    // when clearUnmatched is true.
    const reclassify = await this.customBuilds.reclassifyAll(userId, {
      clearUnmatched: false,
    });
    return { created, ...reclassify };
  }
}

/**
 * Build the document that goes into validateCustomBuild + upsert.
 * Only the contract fields are copied — extra discovery metadata
 * (gameCount, cohesion, sampleGames, …) never reaches the build doc.
 * The provenance description and `source: 'auto-classify'` tag the
 * row as discovery-engine output for the UI to badge; behaviour on
 * read paths is unchanged.
 *
 * @param {any} c
 * @returns {{
 *   slug: string,
 *   name: string,
 *   race: string,
 *   vsRace: string,
 *   rules: any[],
 *   perspective: 'you'|'opponent',
 *   description: string,
 *   schemaVersion: number,
 *   source: 'auto-classify',
 * }}
 */
function buildApplyDraft(c) {
  const raw = c || {};
  const perspective = raw.perspective === "opponent" ? "opponent" : "you";
  return {
    slug: typeof raw.proposedSlug === "string" ? raw.proposedSlug : "",
    name: typeof raw.proposedName === "string" ? raw.proposedName : "",
    race: typeof raw.race === "string" ? raw.race : "",
    vsRace: typeof raw.vsRace === "string" ? raw.vsRace : "",
    rules: Array.isArray(raw.rules) ? raw.rules : [],
    perspective,
    description: provenanceDescription(raw, perspective),
    schemaVersion: 3,
    source: "auto-classify",
  };
}

/**
 * Short provenance line stamped on every auto-classified build. The
 * UI can surface this anywhere we already render `description`. The
 * matchup is derived from race + vsRace + perspective so the string
 * matches the cloud's myRace-first convention (`PvZ` not `ZvP`).
 *
 * @param {{race?: string, vsRace?: string}} c
 * @param {'you'|'opponent'} perspective
 * @returns {string}
 */
function provenanceDescription(c, perspective) {
  const mu = matchupFromCandidate(c, perspective);
  const muPart = mu ? `${mu} ` : "";
  const side = perspective === "opponent" ? "opponent's " : "";
  return (
    `Auto-classified from ${side}${muPart}openings by the discovery engine. ` +
    `Generated automatically from clusters of similar replays in your library — ` +
    `you can edit the rules, rename, or delete this build at any time.`
  );
}

/**
 * Matchup string (myRace-first) for a candidate's race + vsRace pair.
 * perspective='opponent' flips the sides so the build's stored race
 * (the opponent's race) lands on the opp side of the matchup. Returns
 * an empty string when either side can't be reduced to a P/T/Z letter.
 *
 * @param {{race?: string, vsRace?: string}} c
 * @param {'you'|'opponent'} perspective
 * @returns {string}
 */
function matchupFromCandidate(c, perspective) {
  const r = raceLetter(c && c.race);
  const v = raceLetter(c && c.vsRace);
  if (r === "?" || v === "?") return "";
  return perspective === "opponent" ? `${v}v${r}` : `${r}v${v}`;
}

/**
 * Pre-extract rules + perspective for each saved build so the in-
 * scope filter doesn't redo this work per game. Builds with zero
 * rules are skipped — they can't claim anything.
 *
 * @param {any[]} builds
 * @returns {Array<{build:any, rules:any[], perspective:'you'|'opponent'}>}
 */
function prepareCustomBuilds(builds) {
  if (!Array.isArray(builds)) return [];
  const out = [];
  for (const b of builds) {
    if (!b) continue;
    const rules = extractRules(b);
    if (!Array.isArray(rules) || rules.length === 0) continue;
    const perspective = b.perspective === "opponent" ? "opponent" : "you";
    out.push({ build: b, rules, perspective });
  }
  return out;
}

/**
 * Names already in use by the user's saved custom builds AND by the
 * named-catalog labels the agent has already stamped on at least one
 * of the user's games. The orchestrator must never propose a name
 * that overwrites either layer.
 *
 * @param {any[]} builds
 * @param {Array<{myBuild?: string|null}>} games
 * @returns {Set<string>}
 */
function collectReservedNames(builds, games) {
  /** @type {Set<string>} */
  const reserved = new Set();
  if (Array.isArray(builds)) {
    for (const b of builds) {
      if (!b) continue;
      const name = b.name || b.slug;
      if (typeof name === "string" && name.length > 0) reserved.add(name);
    }
  }
  if (Array.isArray(games)) {
    for (const g of games) {
      if (!g) continue;
      const label = g.myBuild;
      if (typeof label !== "string") continue;
      const trimmed = label.trim();
      if (trimmed.length === 0) continue;
      // Don't reserve the catch-all labels — those are the names we
      // WANT to replace with discovered builds.
      if (UNCLASSIFIED_LABEL_RE.test(trimmed)) continue;
      reserved.add(trimmed);
    }
  }
  return reserved;
}

/**
 * Slugs already in use by the user's saved custom builds. Slugs are
 * primary keys (one per user), so any collision is a hard collision
 * regardless of how the corresponding build was named.
 *
 * @param {any[]} builds
 * @returns {Set<string>}
 */
function collectReservedSlugs(builds) {
  /** @type {Set<string>} */
  const reserved = new Set();
  if (!Array.isArray(builds)) return reserved;
  for (const b of builds) {
    if (!b) continue;
    if (typeof b.slug === "string" && b.slug.length > 0) reserved.add(b.slug);
  }
  return reserved;
}

/**
 * Walk the proposed name + slug through a deterministic
 * disambiguation ladder: first append " (Auto)" / "-auto", then
 * "(Auto 2)" / "-auto-2", … until both sides are free. Never returns
 * one of the reserved strings.
 *
 * @param {{
 *   baseName: string,
 *   baseSlug: string,
 *   reservedNames: Set<string>,
 *   reservedSlugs: Set<string>,
 * }} args
 * @returns {{proposedName: string, proposedSlug: string}}
 */
function applyCollisionGuard(args) {
  const { baseName, baseSlug, reservedNames, reservedSlugs } = args;
  if (!reservedNames.has(baseName) && !reservedSlugs.has(baseSlug)) {
    return { proposedName: baseName, proposedSlug: baseSlug };
  }
  let attempt = 1;
  while (attempt < 100) {
    const suffix = attempt === 1 ? " (Auto)" : ` (Auto ${attempt})`;
    const slugSuffix = attempt === 1 ? "-auto" : `-auto-${attempt}`;
    const name = `${baseName}${suffix}`;
    const slug = `${baseSlug}${slugSuffix}`.slice(0, 80);
    if (!reservedNames.has(name) && !reservedSlugs.has(slug)) {
      return { proposedName: name, proposedSlug: slug };
    }
    attempt++;
  }
  // Last-ditch: tag with a millisecond counter. We never expect to
  // get here in practice — 99 disambiguations would mean the user
  // already has 99 auto-builds with the same base name, which is
  // outside the design envelope.
  const suffix = ` (Auto ${attempt})`;
  return {
    proposedName: `${baseName}${suffix}`,
    proposedSlug: `${baseSlug}-auto-${attempt}`.slice(0, 80),
  };
}

/**
 * @param {unknown} raw
 * @param {number} fallback
 * @returns {number}
 */
function positiveIntOr(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

/**
 * @param {unknown} raw
 * @param {number} fallback
 * @returns {number}
 */
function positiveOr(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

module.exports = {
  AutoClassifyService,
  UNCLASSIFIED_LABEL_RE,
  DEFAULT_MIN_GAMES,
  DEFAULT_MAX_DISTANCE,
};
