"use strict";
const { parseAccounts, accountMatchHandles } = require("../src/util/accountFilter");
const { gamesMatchStage } = require("../src/util/parseQuery");
test("account matching expands only the SC2 separator letter, within forty literal index values", () => {
  const raw = Array.from({ length: 20 }, (_, i) => `1-s2-1-${i + 1}`).join(",");
  const accounts = parseAccounts(raw) || [], variants = accountMatchHandles(accounts) || [];
  expect(accounts).toHaveLength(20); expect(variants).toHaveLength(40); expect(new Set(variants).size).toBe(40);
  expect(variants.every(value => typeof value === "string" && /^1-[Ss]2-1-\d+$/.test(value))).toBe(true);
  expect(gamesMatchStage("owner", { accounts }).myToonHandle).toEqual({ $in: variants });
  expect(accountMatchHandles("1-s2-1-1,1-S2-1-1")).toEqual(["1-S2-1-1", "1-s2-1-1"]);
  expect(() => accountMatchHandles("1-S2-1-1,.*")).toThrow("valid account handles");
  expect(() => accountMatchHandles([...accounts, "1-S2-1-999"])).toThrow("at most 20");
});
