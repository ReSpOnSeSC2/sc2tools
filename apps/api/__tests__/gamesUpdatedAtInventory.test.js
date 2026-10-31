// @ts-nocheck
"use strict";
// Every games write that can change what GET /v1/games/analysis-corpus returns stamps `updatedAt`
// (util/corpusUpdatedAt.js), so a delta reader can page by it. The scan parses apps/api/src with the TypeScript compiler
// and classifies each write call on a games handle: stamped (an argument calls the stamp helper), a hard delete (no
// row is left to stamp) or reviewed below as unable to change the corpus. The inventory is exact, so a new writer
// fails here until it is stamped or reviewed. Out-of-band migrations under db/migrations are not scanned.
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { withUpdatedAt, rowWithUpdatedAt } = require("../src/util/corpusUpdatedAt");

const SRC = path.join(__dirname, "..", "src");
const WRITES = new Set(["updateOne", "updateMany", "insertOne", "insertMany", "bulkWrite", "deleteOne", "deleteMany",
  "findOneAndUpdate", "findOneAndDelete", "findOneAndReplace", "replaceOne"]);
const GAMES = /(?:^|\.)(?:games|gamesCollection)$/;
const STAMP = /\b(?:withUpdatedAt|rowWithUpdatedAt)\(/;
const files = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? files(path.join(dir, entry.name)) : entry.name.endsWith(".js") ? [path.join(dir, entry.name)] : []);
const nameOf = fn => {
  if (fn.name && (ts.isIdentifier(fn.name) || ts.isPrivateIdentifier(fn.name))) return fn.name.text;
  const owner = fn.parent;
  const named = owner && (ts.isVariableDeclaration(owner) || ts.isPropertyAssignment(owner)) && ts.isIdentifier(owner.name);
  return named ? owner.name.text : null;
};
const functionName = node => {
  for (let at = node.parent; at; at = at.parent) if (ts.isFunctionLike(at) && nameOf(at)) return nameOf(at);
  return "<module>";
};
const sites = files(SRC).filter(file => !path.relative(SRC, file).startsWith(path.join("db", "migrations"))).flatMap(file => {
  const rel = path.relative(SRC, file).replaceAll("\\", "/");
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true), found = [];
  const visit = node => {
    const callee = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) ? node.expression : null;
    if (callee && WRITES.has(callee.name.text) && GAMES.test(callee.expression.getText(source))) {
      const stamped = node.arguments.some(arg => STAMP.test(arg.getText(source)));
      found.push({ key: `${rel} ${functionName(node)} ${callee.name.text}`,
        kind: stamped ? "stamped" : callee.name.text.startsWith("delete") ? "removal" : "reviewed" });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
});
const keys = kind => sites.filter(site => site.kind === kind).map(site => site.key).sort();
const expand = entries => entries.flatMap(([key, count]) => Array(count).fill(key)).sort();

// [file function method, sites]: each changes a projected field or the row's corpus membership.
const STAMPED = [
  ["services/buildIntentAttribution.js renameCustomOpponentOverrides updateMany", 1],
  ["services/buildIntentAttribution.js renameCustomOverrides updateMany", 1],
  ["services/gameControls.js deleteGame replaceOne", 1],
  ["services/gameControls.js deleteGame updateOne", 1],
  ["services/gameControls.js setExcluded updateOne", 1],
  ["services/gameStatsBuildStateNeutral.js applyBuildState updateMany", 1],
  ["services/gameStatsBuildStateNeutral.js applyBuildState updateOne", 1],
  ["services/gameStatsCountNeutral.js applyMacroSurface updateOne", 1],
  ["services/gameStatsCustomBuildEof.js applyCustomBuildEof updateMany", 1],
  ["services/gameStatsCustomBuildIngestTag.js applyCustomBuildIngestTag findOneAndUpdate", 1],
  ["services/gameStatsOpponentGame.js applyOpponentGameMutation updateMany", 1],
  ["services/gameStatsPulseNeutral.js applyPulseStamp updateOne", 1],
  ["services/games.js quarantineResumedReplay updateMany", 1],
  ["services/games.js upsertWithRevision updateOne", 2],
];
// [file function method, sites, why it cannot change the corpus].
const REVIEWED = [
  ["jobs/ladderMapBackfillJob.js flush bulkWrite", 1, "isLadderMap stamp, not projected"],
  ["services/customBuilds.js reclassify bulkWrite", 3, "reclassification staging markers"],
  ["services/customBuilds.js reclassify updateMany", 1, "staging rollback"],
  ["services/customBuilds.js reclassifyAll bulkWrite", 2, "reclassification staging markers"],
  ["services/customBuilds.js reclassifyAll updateMany", 1, "staging rollback"],
  ["services/gameControls.js deleteGame updateOne", 1, "clears the cleanup marker on a tombstone that is already stamped"],
  ["services/gameMoments.js _claimAndDeliver updateOne", 1, "moment receipt"],
  ["services/gameStatsCustomBuildDefinitionSave.js updateMany updateMany", 1, "forwards buildIntentAttribution's stamped renames"],
  ["services/gameStatsOpponentGame.js applyOpponentGameMutation updateOne", 1, "opponent.region only, not projected"],
  ["services/games.js quarantineResumedReplay updateOne", 1, "inserts a row that starts quarantined, outside the corpus"],
  ["services/gdpr.js _drainOpponentBuildOrderWriters updateMany", 1, "build-order lease residue"],
  ["services/opponentBuildOrderFence.js recoverExpiredOpponentBuildOrderWrites updateMany", 1, "build-order lease residue"],
  ["services/opponents.js repairResumedReplayCountersForUser updateMany", 2, "resumed-replay repair journal"],
  ["services/opponents.js repairResumedReplayCountersForUser updateOne", 1, "resumed-replay repair journal"],
  ["services/perGameCompute.js renew updateOne", 1, "build-order lease renewal"],
  ["services/perGameCompute.js writeApmCurve updateOne", 1, "heavy-field cleanup"],
  ["services/perGameCompute.js writeOpponentBuildOrder findOneAndUpdate", 1, "build-order lease and heavy logs"],
  ["services/perGameCompute.js writeOpponentBuildOrder updateOne", 2, "build-order lease release"],
  ["services/playbackArtifacts.js complete updateOne", 1, "playback storage marker"],
  ["services/playbackArtifacts.js prepare updateOne", 1, "playback storage marker"],
  ["services/replayFiles.js _clearIntent updateOne", 1, "replay storage marker"],
  ["services/replayFiles.js _clearMarker updateOne", 1, "replay storage marker"],
  ["services/replayFiles.js _releaseIntent updateOne", 1, "replay storage marker"],
  ["services/replayFiles.js completeUpload updateOne", 2, "replay storage marker"],
  ["services/replayFiles.js prepareUpload updateOne", 2, "replay storage marker"],
  ["services/users.js patchLastKnownMmr updateMany", 1, "resumed-replay repair journal"],
  ["services/users.js repairLastKnownMmrAfterResumedReplay bulkWrite", 1, "resumed-replay repair journal"],
];

test("every games writer is stamped, a hard delete or reviewed, and the inventory is exact", () => {
  expect(keys("stamped")).toEqual(expand(STAMPED));
  expect(keys("removal")).toEqual(["services/gameStatsWrites.js deleteMany deleteMany", "services/gameStatsWrites.js deleteMany deleteMany"]);
  expect(keys("reviewed")).toEqual(expand(REVIEWED));
});

test("snapshot restore stamps each restored games row before the retryable insert", () => {
  const text = fs.readFileSync(path.join(SRC, "services", "userBackups.js"), "utf8");
  expect(text).toContain('const batch = dbKey === "games" ? rows.map(row => rowWithUpdatedAt(row)) : rows;');
  expect(text).toContain("session => collection.insertMany(batch, session ? { session } : {})");
});

test("the stamp follows the corpus fields, converts $set/$unset updates literally and never changes the caller's update", () => {
  const { CORPUS_FIELDS } = require("../src/util/corpusUpdatedAt");
  const { ANALYSIS_GAME_PROJECTION } = require("../src/services/games");
  expect([...CORPUS_FIELDS].sort()).toEqual([...Object.keys(ANALYSIS_GAME_PROJECTION).filter(key => key !== "_id"),
    "_deleted", "_deletionPending", "excluded", "isResumedFromReplay"].sort());
  const operator = { $set: { macroScore: 80, top3Leaks: [{ name: "$idle" }] }, $unset: { macroBreakdown: "" } };
  const stages = withUpdatedAt(operator), snapshot = stages[0].$set._corpusBefore;
  expect(Object.values(snapshot)).toEqual(CORPUS_FIELDS.map(field => `$${field}`));
  expect(stages.slice(1)).toEqual([{ $set: { macroScore: { $literal: 80 }, top3Leaks: { $literal: [{ name: "$idle" }] } } },
    { $unset: ["macroBreakdown"] }, { $set: { updatedAt: { $cond: [{ $eq: ["$_corpusBefore", snapshot] }, "$updatedAt", expect.any(Date)] } } },
    { $unset: "_corpusBefore" }]);
  const pipeline = [{ $set: { myBuild: { $literal: "PvZ - Glaive Adept" } } }];
  expect(withUpdatedAt(pipeline).slice(1, -2)).toEqual(pipeline);
  const upsert = { $setOnInsert: { createdAt: new Date(0) }, $set: { result: "Victory" }, $unset: {} };
  expect(withUpdatedAt(upsert)).toEqual({ ...upsert, $set: { result: "Victory", updatedAt: expect.any(Date) } });
  const row = { userId: "a", gameId: "g", _deleted: true };
  expect(rowWithUpdatedAt(row)).toEqual({ ...row, updatedAt: expect.any(Date) });
  expect([operator, pipeline.length, upsert.$set, row]).toEqual([{ $set: { macroScore: 80, top3Leaks: [{ name: "$idle" }] },
    $unset: { macroBreakdown: "" } }, 1, { result: "Victory" }, { userId: "a", gameId: "g", _deleted: true }]);
});
