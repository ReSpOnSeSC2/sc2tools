"use strict";
const rules = require("../config/accountFilter.json");
const HANDLE = new RegExp(rules.handlePattern, "i");

/** Explicit malformed cohorts fail closed, never broaden to every account.
 * @param {unknown} raw @returns {string[]|undefined} */
function parseAccounts(raw) {
  if (raw === undefined || raw === "") return undefined;
  const values = typeof raw === "string" ? raw.split(",") : raw;
  if (!Array.isArray(values) || values.length === 0 || values.length > rules.maximumAccounts
    || values.some(value => typeof value !== "string" || value.length > rules.maximumHandleLength || !HANDLE.test(value.trim()))) {
    throw Object.assign(new Error("accounts must contain at most 20 valid account handles"), { status: 400, code: "invalid_accounts" });
  }
  return [...new Set(values.map(value => value.trim().toUpperCase()))].sort();
}
/** One SC2 identity has two accepted separator spellings, S2 and s2.
 * Keep legacy matches as bounded literal index keys, never fuzzy regexes.
 * @param {unknown} raw @returns {string[]|undefined} */
function accountMatchHandles(raw) {
  return parseAccounts(raw)?.flatMap(value => [value, value.replace("-S2-", "-s2-")]);
}
module.exports = { parseAccounts, accountMatchHandles };
