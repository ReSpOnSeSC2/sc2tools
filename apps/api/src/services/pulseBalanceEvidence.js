"use strict";

const { gzipSync, gunzipSync } = require("node:zlib");
const { Binary } = require("mongodb");

const MAX_EVIDENCE_BYTES = 512 * 1024;

/** @typedef {import("./pulseBalanceAdapter").Matchup} Matchup */
/** @typedef {{mapId:number,matchup:Matchup,wins:number,games:number}} MapMatchup */
/** @typedef {import("./pulseBalanceStore").CurrentSnapshot} CurrentSnapshot */
/** @typedef {{season:number,asOf:string}} SnapshotPin */
/** @typedef {ReturnType<typeof buildBalanceEvidence>} BalanceEvidence */

/** @param {Pick<CurrentSnapshot,"bundle"|"tiers">} snapshot */
function buildBalanceEvidence({ bundle, tiers }) {
  /** @type {Map<number,string>} */
  const maps = new Map();
  const evidence = bundle.tiers.map(({ league, division, matchups }) => {
    const tier = tiers.find(row => row.league === league && row.division === division);
    if (!tier) throw new Error("Balance evidence tier is missing");
    const names = new Map(tier.maps);
    /** @type {Map<string,MapMatchup>} */
    const mapTotals = new Map();
    for (const [matchup, mapId, , crossTier, , wins, games] of tier.rows) {
      if (crossTier) continue;
      const name = names.get(mapId);
      if (!name || (maps.has(mapId) && maps.get(mapId) !== name)) throw new Error("Inconsistent balance map identity");
      maps.set(mapId, name);
      const key = `${mapId}/${matchup}`;
      const cell = mapTotals.get(key) ?? { mapId, matchup, wins: 0, games: 0 };
      cell.wins += wins;
      cell.games += games;
      mapTotals.set(key, cell);
    }
    return {
      league, division, bounds: tier.bounds,
      matchups: matchups.map(({ matchup, sameTier: { wins, games } }) => ({ matchup, wins, games })),
      mapMatchups: [...mapTotals.values()].sort((left, right) =>
        left.mapId - right.mapId || left.matchup.localeCompare(right.matchup)),
    };
  });
  return {
    season: bundle.season, asOf: bundle.asOf, tiers: evidence,
    maps: Array.from(maps, ([id, name]) => ({ id, name })).sort((left, right) =>
      left.name.localeCompare(right.name) || left.id - right.id),
  };
}

/** @param {BalanceEvidence} evidence */
function encodeBalanceEvidence(evidence) {
  const json = Buffer.from(JSON.stringify(evidence));
  if (json.length > MAX_EVIDENCE_BYTES) throw new Error("Balance evidence is too large");
  return new Binary(gzipSync(json));
}

/** @param {Binary} archive @returns {BalanceEvidence} */
function decodeBalanceEvidence(archive) {
  return JSON.parse(gunzipSync(archive.value(), { maxOutputLength: MAX_EVIDENCE_BYTES }).toString("utf8"));
}

module.exports = { buildBalanceEvidence, encodeBalanceEvidence, decodeBalanceEvidence };
