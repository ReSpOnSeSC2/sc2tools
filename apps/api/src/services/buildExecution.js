"use strict";
const { createHash } = require("crypto");
const { LIVE_GAME_MATCH, OwnerRevisions } = require("../util/gameVisibility");
const { navigationIdentity } = require("./gameNeighbors");
const { overrideActive, catalogKeyForName, customKeyForSlug, BUILD_INTENT_LABEL_PROJECTION } = require("./buildIntentShape");
const { extractRules } = require("./customBuilds");
const { evaluateRulesDetailed } = require("./buildRulesEvaluator");
const { executionTimings, MIN_SAMPLE } = require("./buildExecutionTimings");
const { matchupLabel } = require("./timingCatalog");

const CACHE_LIMIT = 200, BASELINE_LIMIT = 100, TTL_MS = 5 * 60_000, MAX_WORK = 4;
const PROJECTION = Object.freeze({ _id: 0, gameId: 1, date: 1, gameVersion: 1, gameBuild: 1,
  myBuild: 1, myRace: 1, "opponent.race": 1, durationSec: 1,
  _customBuildSlug: 1, _customBuildRevision: 1, isResumedFromReplay: 1, ...BUILD_INTENT_LABEL_PROJECTION });
const busy = () => Object.assign(new Error("Build evidence changed or is busy. Try again."), { status: 503, code: "build_execution_busy" });
/** @param {unknown} value */
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

class BuildExecutionService {
  /** @param {{games:import('mongodb').Collection}} db
   * @param {{perGame:import('./perGameCompute').PerGameComputeService,
   * builds:import('./builds').BuildsService,customBuilds:import('./customBuilds').CustomBuildsService,now?:()=>number}} opts */
  constructor(db, opts) {
    this.db = db; this.opts = opts; this.now = opts.now || Date.now;
    this.revisions = new OwnerRevisions();
    /** @type {Map<string,{at:number,value:any}>} */ this.cache = new Map();
    /** Compact scalar baselines only; no raw logs or sample IDs are retained.
     * @type {Map<string,{at:number,value:any}>} */ this.baselines = new Map();
    /** @type {Map<string,Promise<any>>} */ this.inflight = new Map();
    /** @type {Map<string,Promise<any>>} */ this.baselineInflight = new Map();
  }

  /** Retire in-flight completions immediately; keep admitted work counted.
   * @param {string} owner */
  invalidateForUser(owner) {
    this.revisions.invalidate(owner);
    const prefix = `${JSON.stringify(owner)}|`;
    for (const map of [this.cache, this.baselines]) for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key);
  }

  /** @param {string} owner @param {string} id */
  current(owner, id) { return this.db.games.findOne({ userId: owner, gameId: id, ...LIVE_GAME_MATCH }, { projection: PROJECTION }); }

  /** Owner existence precedes every cache access; no coach/public adapter.
   * @param {string} userId @param {string} gameId @param {{signal?:AbortSignal}} [options] */
  async get(userId, gameId, options = {}) {
    const owner = navigationIdentity(userId), id = navigationIdentity(gameId);
    if (!owner || !id) return null;
    const epoch = this.revisions.get(owner), game = await this.current(owner, id);
    if (!game) return null;
    if (!this.revisions.current(owner, epoch)) throw busy();
    const declared = overrideActive(game) ? game.buildIntent.build : null;
    const slug = navigationIdentity(declared ? declared.source === "custom" ? declared.slug : null : game._customBuildSlug);
    const name = navigationIdentity(declared?.name || game.myBuild);
    const definition = slug && !declared?.deleted ? await this.opts.customBuilds.get(owner, slug) : null;
    const own = !definition || !definition.perspective || definition.perspective === "you";
    const rules = definition && own ? extractRules(definition).slice(0, 80) : [];
    const build = name ? { name, source: slug ? "custom" : "catalog", key: slug ? customKeyForSlug(slug) : catalogKeyForName(name),
      ...(slug ? { slug } : {}), race: game.myRace || null, vsRace: game.opponent?.race || null,
      deleted: !!declared?.deleted || !!slug && (!definition || !own), rules,
      hasReferenceBuildOrder: !!definition?.hasReferenceBuildOrder || !!definition?.buildOrder?.steps?.length } : null;
    const source = declared ? "confirmed" : name ? "detected" : "none";
    const rulesHash = hash([rules, definition?.updatedAt, definition?.revision, definition?.name, build?.hasReferenceBuildOrder]);
    const prefix = `${JSON.stringify(owner)}|${epoch.id}|`;
    const key = `${prefix}${hash([game, build?.key, rulesHash])}`;
    const cached = this.read(this.cache, key);
    if (cached) return cached;
    if (this.inflight.has(key)) return this.inflight.get(key);
    if (this.inflight.size >= MAX_WORK) throw busy();
    const work = this.compute(owner, game, build, source, `${prefix}${hash([build?.key, rulesHash])}`, options.signal).then(async value => {
      const latest = await this.current(owner, id);
      if (!latest) return null;
      if (!this.revisions.current(owner, epoch) || hash(latest) !== hash(game)) throw busy();
      this.write(this.cache, key, value, CACHE_LIMIT);
      return value;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }

  /** @param {string} owner @param {Record<string,any>} game
   * @param {Record<string,any>|null} build @param {string} source @param {string} baselineKey @param {AbortSignal} [signal] */
  async compute(owner, game, build, source, baselineKey, signal) {
    const matchup = matchupLabel(game.myRace, game.opponent?.race) || null;
    const empty = { build, source, matchup, rules: [], ruleCount: 0, knownCount: 0, passedCount: 0, matchPct: null,
      timings: [], timingMinSample: MIN_SAMPLE, timingSampleSelected: 0, timingSampleGames: 0, timingSampleLimit: 25 };
    if (!build || build.deleted || game.isResumedFromReplay === true) return { ...empty, unavailable: game.isResumedFromReplay ? "resumed" : build?.deleted ? "definition_missing" : "no_build" };
    const evidence = await this.opts.perGame.buildExecutionEvents(owner, String(game.gameId), { signal });
    if (!evidence) return null;
    const { available, events } = evidence;
    const detailed = evaluateRulesDetailed(build.rules || [], events, available);
    // Missing/failed/unextracted own evidence cannot trigger a useless max25
    // timing hydration. Rules remain unknown, including negative rules.
    if (!events?.length || !matchup) return { ...empty, ...detailed, unavailable: "log_missing" };
    if (!executionTimings(null, matchup, events).length) return { ...empty, ...detailed };
    const dossier = await this.baseline(owner, build, baselineKey, signal);
    return { ...empty, ...detailed, timings: executionTimings(dossier, matchup, events),
      timingSampleSelected: dossier?.timingSampleSelected || 0, timingSampleGames: dossier?.timingSampleGames || 0 };
  }

  /** One hydrated dossier supplies all execution/timeline timing rows. A
   * small scalar subcache also reuses it across neighboring owner games.
   * @param {string} owner @param {Record<string,any>} build @param {string} key @param {AbortSignal} [signal] */
  async baseline(owner, build, key, signal) {
    const hit = this.read(this.baselines, key);
    if (hit) return hit;
    if (this.baselineInflight.has(key)) return this.baselineInflight.get(key);
    const epoch = this.revisions.get(owner);
    const work = (build.source === "custom" ? this.opts.customBuilds.evaluateBuild(owner, build.slug, { signal })
      : this.opts.builds.detail(owner, build.name, {}, { signal, catalogOnly: true })).then(dossier => {
        const value = compactBaseline(dossier);
        if (this.revisions.current(owner, epoch)) this.write(this.baselines, key, value, BASELINE_LIMIT);
        return value;
      }).finally(() => this.baselineInflight.delete(key));
    this.baselineInflight.set(key, work);
    return work;
  }

  /** @param {Map<string,{at:number,value:any}>} map @param {string} key */
  read(map, key) {
    const hit = map.get(key);
    if (!hit) return null;
    map.delete(key);
    if (this.now() - hit.at >= TTL_MS) return null;
    map.set(key, hit); return hit.value;
  }
  /** @param {Map<string,{at:number,value:any}>} map @param {string} key @param {any} value @param {number} limit */
  write(map, key, value, limit) {
    map.delete(key);
    if (map.size >= limit) map.delete(map.keys().next().value || "");
    map.set(key, { at: this.now(), value });
  }
}

/** @param {Record<string,any>|null} dossier */
function compactBaseline(dossier) {
  /** @type {Record<string,any>} */ const matchups = {};
  for (const [matchup, block] of Object.entries(dossier?.matchupTimingsLegacy || {}).slice(0, 9)) {
    if (!/^[PTZ]v[PTZ]$/.test(matchup)) continue;
    matchups[matchup] = { timings: Object.fromEntries(Object.entries(/** @type {any} */ (block)?.timings || {}).slice(0, 64).map(([token, row]) => {
      const value = /** @type {any} */ (row);
      return [token, { sampleCount: value.sampleCount, medianSeconds: value.medianSeconds, p25Seconds: value.p25Seconds, p75Seconds: value.p75Seconds }];
    })) };
  }
  return { matchupTimingsLegacy: matchups, naturalTimings: dossier?.naturalTimings || {},
    timingSampleSelected: dossier?.timingSampleSelected || 0, timingSampleGames: dossier?.timingSampleGames || 0 };
}
module.exports = { BuildExecutionService, compactBaseline, CACHE_LIMIT, BASELINE_LIMIT, TTL_MS, MAX_WORK };
