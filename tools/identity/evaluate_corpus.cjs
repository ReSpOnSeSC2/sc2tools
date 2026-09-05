"use strict";

// Offline evaluation calls the production scorer. Labels never enter features
// or scores, and every replay selected for a query is held out from all profiles.
const fs = require("node:fs");
const { scoreCandidate } = require("../../apps/api/src/services/opponentIdentityMatcher");
const { sanitizePlaySignature } = require("../../apps/api/src/validation/playSignature");
const args = process.argv.slice(2);
if (!args[0]) throw new Error("Usage: node tools/identity/evaluate_corpus.cjs corpus.json [report.json]");
const corpus = JSON.parse(fs.readFileSync(args[0], "utf8"));
if (corpus.source !== "real_sc2_replays" || !Array.isArray(corpus.rows)) throw new Error("Unsupported corpus");
const groups = new Map();
let invalidSignatures = 0;
for (const row of corpus.rows) {
  const signature = sanitizePlaySignature(row.signature);
  if (!signature || JSON.stringify(signature) !== JSON.stringify(row.signature)) {
    // Property ordering is irrelevant: the second comparison checks values.
    if (!signature || !require("node:util").isDeepStrictEqual(signature, row.signature)) {
      invalidSignatures += 1;
      continue;
    }
  }
  const key = `${row.label}:${row.race}`;
  if (!groups.has(key)) groups.set(key, []);
  if (!groups.get(key).some((old) => old.replayHash === row.replayHash)) groups.get(key).push(row);
}
const queries = [];
for (const [label, rows] of groups) {
  rows.sort((left, right) => right.timestamp - left.timestamp || left.replayHash.localeCompare(right.replayHash));
  if (rows.length >= 2) queries.push({ label, row: rows[0] });
}
const heldout = new Set(queries.map(({ row }) => row.replayHash));
const references = new Map([...groups].map(([label, rows]) => [label,
  rows.filter((row) => !heldout.has(row.replayHash)).slice(0, 24),
]).filter(([, rows]) => rows.length > 0));
function game(row) {
  return { gameId: row.replayHash, date: new Date(row.timestamp * 1000),
    myRace: row.facingRace, durationSec: row.durationSec,
    opponent: { race: row.race, playSignature: row.signature } };
}
const results = [];
let noReference = 0;
for (const query of queries) {
  if (!references.has(query.label)) { noReference += 1; continue; }
  const ranked = [];
  for (const [label, rows] of references) {
    if (rows[0].race !== query.row.race) continue;
    const score = scoreCandidate([game(query.row)], rows.map(game), query.row.facingRace.slice(0, 1).toUpperCase());
    if (score && score.patternMatch >= 0.35) ranked.push({ label, patternMatch: score.patternMatch,
      rankScore: score.rankScore, confidence: score.confidence, evidenceQuality: score.evidenceQuality });
  }
  const rawRanked = [...ranked].sort((left, right) => right.patternMatch - left.patternMatch || left.label.localeCompare(right.label));
  ranked.sort((left, right) => right.rankScore - left.rankScore || right.patternMatch - left.patternMatch || left.label.localeCompare(right.label));
  const rank = ranked.findIndex((candidate) => candidate.label === query.label) + 1;
  const rawRank = rawRanked.findIndex((candidate) => candidate.label === query.label) + 1;
  const bestFalse = rawRanked.find((candidate) => candidate.label !== query.label);
  const actual = ranked.find((candidate) => candidate.label === query.label);
  results.push({ label: query.label, race: query.row.race, referenceGames: references.get(query.label).length,
    candidateCount: ranked.length, rank: rank || null, rawPatternRank: rawRank || null,
    truePatternMatch: actual?.patternMatch ?? null, trueRankScore: actual?.rankScore ?? null,
    trueEvidenceQuality: actual?.evidenceQuality ?? null, trueConfidence: actual?.confidence ?? null,
    highestOtherAccountPatternMatch: bestFalse?.patternMatch ?? null,
    // Removing the genuine account approximates an open-set challenge. This
    // records similarity collisions, not production calibrated probabilities.
    otherAccountOverDisplayThreshold: (bestFalse?.patternMatch ?? 0) >= 0.35 });
}
const rate = (predicate) => results.length ? results.filter(predicate).length / results.length : null;
const informative = results.filter((row) => row.candidateCount >= 2);
const report = {
  formatVersion: 1, calibrated: false, source: corpus.source,
  signatureVersions: [...new Set(corpus.rows.map((row) => row.signature?.version).filter(Number.isInteger))].sort((a, b) => a - b),
  evaluation: "disjoint_replay_same_account_retrieval", selection: corpus.selection,
  ranking: "production_rankScore_then_patternMatch", minimumPatternMatch: 0.35,
  limitations: ["Same-account replay labels do not verify identities across alternate accounts.",
    "This development audit can guide implementation; it is not an untouched external accuracy benchmark.",
    corpus.selection === "repeated_opponent_accounts_first"
      ? "Repeated accounts are deliberately sampled; this is not population accuracy or calibrated identity probability."
      : "This local corpus is not a representative population and cannot calibrate identity probabilities.",
    "One held-out replay per account/race; small samples and same local opponent limit generalization.",
    "Another account may belong to the same person; other-account collisions are not verified false-person matches."],
  extraction: corpus.counters, dominantAccountExcluded: corpus.dominantAccountExcluded,
  validRows: [...groups.values()].reduce((sum, rows) => sum + rows.length, 0), invalidSignatures,
  referenceAccounts: references.size, heldoutReplayCount: heldout.size,
  evaluatedQueries: results.length, queriesWithoutDisjointReference: noReference,
  top1RetrievalRate: rate((row) => row.rank === 1), top5RetrievalRate: rate((row) => row.rank !== null && row.rank <= 5),
  rawPatternTop1RetrievalRate: rate((row) => row.rawPatternRank === 1),
  informativeQueries: informative.length,
  informativeTop1RetrievalRate: informative.length ? informative.filter((row) => row.rank === 1).length / informative.length : null,
  otherAccountSimilarityOverDisplayThresholdRate: rate((row) => row.otherAccountOverDisplayThreshold),
  results,
};
if (args[1]) fs.writeFileSync(args[1], `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ...report, results: undefined }, null, 2)}\n`);
if (invalidSignatures > 0 || !results.length) process.exitCode = 1;
