// @ts-nocheck
"use strict";

const { startPrivateSearchIndex, PRIVATE_SEARCH_OPPONENT_INDEX } = require("../src/db/privateSearchIndexes");
const query = require("../src/services/privateSearchQuery");

test("the optional opponent index exposes readiness without holding boot or creating a game index", async () => {
  let finish;
  const held = new Promise(resolve => { finish = resolve; });
  const opponents = { createIndex: jest.fn(() => held) };
  const logger = { info: jest.fn(), warn: jest.fn() };
  const build = startPrivateSearchIndex({ opponents }, logger);
  expect(build.status(PRIVATE_SEARCH_OPPONENT_INDEX)).toBe("building");
  expect(build.status("unrelated")).toBeNull();
  await Promise.resolve();
  expect(opponents.createIndex).toHaveBeenCalledTimes(1);
  expect(opponents.createIndex).toHaveBeenCalledWith({ userId: 1, _id: 1 }, {
    name: PRIVATE_SEARCH_OPPONENT_INDEX, unique: false, collation: { locale: "simple" }, timeoutMS: 0,
  });
  expect(Object.entries(opponents.createIndex.mock.calls[0][0])).toEqual([["userId", 1], ["_id", 1]]);
  expect(query.opponents("owner", "St").options.hint).toBe(PRIVATE_SEARCH_OPPONENT_INDEX);
  finish(PRIVATE_SEARCH_OPPONENT_INDEX); await build.settled;
  expect(build.status(PRIVATE_SEARCH_OPPONENT_INDEX)).toBe("ready");
  expect(logger.warn).not.toHaveBeenCalled();
});

test("an optional build failure settles once with a fixed diagnostic and no retry or raw error", async () => {
  const opponents = { createIndex: jest.fn(async () => { throw new Error("private database detail"); }) };
  const logger = { info: jest.fn(), warn: jest.fn() };
  const build = startPrivateSearchIndex({ opponents }, logger);
  await expect(build.settled).resolves.toBeUndefined();
  expect(build.status(PRIVATE_SEARCH_OPPONENT_INDEX)).toBe("failed");
  expect(opponents.createIndex).toHaveBeenCalledTimes(1);
  expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ code: "private_search_index_failed" }), "background_index_failed");
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private database detail");
});
