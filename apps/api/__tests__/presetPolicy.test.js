"use strict";
const { spawnSync } = require("child_process");
const path = require("path");
const fixture = require("../../replay-engine/tests/fixtures/preset_policy.json");
const { validatePolicy, policyHash, applyPolicy, BUNDLED_POLICY } = require("../src/services/presetPolicy");

describe("active preset policy shared runtime contract", () => {
  test.each(fixture.cases)("$name", (row) => {
    const policy = validatePolicy(row.policy, false);
    const actual = applyPolicy(policy, row.baseline, row.race, row.opponentRace, row.events, row.eightWorker ? { gameVersion: "5.0.16.97425" } : null);
    expect(actual).toBe(row.expected);
  });

  test("same real Python evaluator and hashes for every shared case", () => {
    const run = spawnSync(process.env.PYTHON || "python", ["-c", `
import json,sys
sys.path.insert(0,sys.argv[1])
from core.preset_policy import validate_policy,apply_policy
from core.strategy_detector import UserBuildDetector
rows=json.load(sys.stdin)
print(json.dumps([dict(hash=(p:=validate_policy(r['policy'],verify_hash=False))['hash'],result=apply_policy(p,r['baseline'],r['race'],r['opponentRace'],r['events'],UserBuildDetector([]),r.get('eightWorker',False))) for r in rows]))
`, path.resolve(__dirname, "../../replay-engine")], { input: JSON.stringify(fixture.cases), encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" }, timeout: 15000 });
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toEqual(fixture.cases.map((row) => ({
      hash: validatePolicy(row.policy, false).hash,
      result: applyPolicy(validatePolicy(row.policy, false), row.baseline, row.race, row.opponentRace, row.events, row.eightWorker ? { gameVersion: "5.0.16.97425" } : null),
    })));
  });

  test("published content hash rejects mutation and is key-order independent", () => {
    const policy = validatePolicy(fixture.cases[0].policy, false);
    expect(policy.hash).toBe(fixture.hash);
    expect(validatePolicy(policy)).toEqual(policy);
    policy.entries[0].anyOf[0][0].beforeSeconds = 100;
    expect(() => validatePolicy(policy)).toThrow("policy_hash_mismatch");
    expect(policyHash(Object.fromEntries(Object.entries(policy).reverse()))).toBe(policyHash(policy));
    expect(BUNDLED_POLICY.entries).toEqual([]);
  });

  test.each([
    (/** @type {any} */ p) => { p.evaluatorVersion = 2; },
    (/** @type {any} */ p) => { p.schemaVersion = true; },
    (/** @type {any} */ p) => { p.entries.push(structuredClone(p.entries[0])); },
    (/** @type {any} */ p) => { p.entries[0].name = "Arbitrary new label"; },
    (/** @type {any} */ p) => { p.entries[0].anyOf = [[]]; },
    (/** @type {any} */ p) => { p.entries[0].anyOf[0][0].category = "building"; },
    (/** @type {any} */ p) => { p.entries[0].anyOf[0][0].execute = "process.exit()"; },
    (/** @type {any} */ p) => { p.entries[0].description = "\ud800"; },
  ])("rejects invalid policy %#", (mutate) => {
    const policy = structuredClone(fixture.cases[0].policy); mutate(policy);
    expect(() => validatePolicy(policy, false)).toThrow();
  });

  test("Unicode scalar prose has identical Python/JS hash", () => {
    const policy = /** @type {any} */ (structuredClone(fixture.cases[0].policy));
    policy.entries[0].description = "6:00 — caméra 🛠";
    const run = spawnSync(process.env.PYTHON || "python", ["-c", "import json,sys;sys.path.insert(0,sys.argv[1]);from core.preset_policy import policy_hash;print(policy_hash(json.load(sys.stdin)))", path.resolve(__dirname, "../../replay-engine")], { input: JSON.stringify(policy), encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" }, timeout: 15000 });
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(policyHash(policy));
  });
});
