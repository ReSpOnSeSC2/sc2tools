"use strict";
const { openingForecast, matchingForecastRows } = require("./openingForecast");
const { canonicalLiveRace } = require("./overlayLiveEnrichment");
const { ladderMetaBucketFor } = require("../util/mmrBracketing");
const { eraForGame } = require("../util/patchEra");

/** One bounded cache of PUBLIC derived priors; never caches personal replay rows. */
class ScoutingForecastService {
  /** @param {Pick<import('./ladderMeta').LadderMetaService,'lookup'>|null} ladderMeta @param {{now?:()=>number}} [opts] */
  constructor(ladderMeta, opts = {}) {
    this.ladderMeta = ladderMeta; this.now = opts.now || Date.now;
    /** @type {Map<string,{at:number,value:any}>} */ this.cache = new Map();
    /** @type {Map<string,Promise<any>>} */ this.inflight = new Map();
  }
  /** @param {any[]} rows @param {{myRace?:unknown,oppRace?:unknown,map?:unknown,myMmr?:unknown}} context */
  async forecast(rows, context) {
    const my = canonicalLiveRace(context.myRace), opp = canonicalLiveRace(context.oppRace);
    const matched = matchingForecastRows(rows, context);
    const explicitRating = typeof context.myMmr === "number" && ladderMetaBucketFor(context.myMmr) !== null ? context.myMmr : null;
    const latestRating = matched.find(row => typeof row.myMmr === "number" && ladderMetaBucketFor(row.myMmr) !== null);
    const rating = explicitRating ?? latestRating?.myMmr, band = ladderMetaBucketFor(rating);
    const matchup = my && opp && my !== "Random" && opp !== "Random" ? `${opp[0]}v${my[0]}` : null;
    const era = eraForGame(matched[0]) || eraForGame({ date: new Date(this.now()) }) || "after";
    const prior = band !== null && matchup ? await this.prior(matchup, band, era) : null;
    return { ...openingForecast(rows, { ...context, prior }), ratingBasis: prior ? explicitRating !== null ? "current_replay" : "last_matchup_replay" : null };
  }
  /** @param {string} matchup @param {number} band @param {string} era */
  async prior(matchup, band, era) {
    if (!this.ladderMeta) return null;
    const key = `${matchup}|${band}|${era}`, hit = this.cache.get(key);
    if (hit && this.now() - hit.at < 60_000) return hit.value;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    if (this.inflight.size >= 32) return null;
    const work = this.ladderMeta.lookup({ bandType: "mmr", band, matchup, era: era === "before" ? "before" : "after" })
      .catch(() => null).then(value => {
        this.cache.delete(key); this.cache.set(key, { at: this.now(), value });
        if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value || "");
        return value;
      }).finally(() => { if (this.inflight.get(key) === work) this.inflight.delete(key); });
    this.inflight.set(key, work);
    return work;
  }
}
module.exports = { ScoutingForecastService };
