// @ts-nocheck
"use strict";
// The corpus change-stamp index has its own background producer: it never holds boot, reports building, ready or
// failed, and is not part of the guide index builds whose readiness GuideStats waits on.
const { CORPUS_UPDATED_AT_INDEX, startCorpusStampIndex } = require("../src/db/corpusIndexes");
const { BACKGROUND_GAMES_INDEXES } = require("../src/db/guideIndexes");

const logger = () => ({ info: jest.fn(), warn: jest.fn() });

test("starts the partial owner/stamp/_id build without a client deadline and reports it ready", async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const createIndex = jest.fn(() => gate), log = logger();
  const builds = startCorpusStampIndex({ games: { createIndex } }, log);
  expect(builds.status(CORPUS_UPDATED_AT_INDEX)).toBe("building");
  expect(builds.status("guide_stats_build_opp_race")).toBeNull();
  await Promise.resolve();
  expect(createIndex.mock.calls).toStrictEqual([[{ userId: 1, updatedAt: 1, _id: 1 },
    { name: CORPUS_UPDATED_AT_INDEX, partialFilterExpression: { updatedAt: { $exists: true } }, timeoutMS: 0 }]]);
  release(); await builds.settled;
  expect(builds.status(CORPUS_UPDATED_AT_INDEX)).toBe("ready");
  expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ index: CORPUS_UPDATED_AT_INDEX }), "background_index_ready");
});

test("a failed build is reported and logged without rejecting", async () => {
  const log = logger(), builds = startCorpusStampIndex({ games: { createIndex: jest.fn(async () => { throw new Error("boom"); }) } }, log);
  await expect(builds.settled).resolves.toBeUndefined();
  expect(builds.status(CORPUS_UPDATED_AT_INDEX)).toBe("failed");
  expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ index: CORPUS_UPDATED_AT_INDEX, code: "corpus_stamp_index_failed" }),
    "background_index_failed");
});

test("the guide builds GuideStats waits on do not include the corpus index", () => {
  expect(BACKGROUND_GAMES_INDEXES.map(spec => spec.options.name)).not.toContain(CORPUS_UPDATED_AT_INDEX);
});
