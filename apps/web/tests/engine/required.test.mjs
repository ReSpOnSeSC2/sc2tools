/**
 * isEngineRequired — the prebuild must treat the rollout flag exactly like
 * the app (`lib/instant/flag.ts`: trimmed, case-insensitive), so a deploy
 * with the feature on never ships without an engine. Fast; no bundle needed.
 *
 * Usage:
 *   node --test tests/engine/required.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { isEngineRequired, normalizeFlag } from "../../scripts/browser-engine/required.mjs";

test("the rollout flag requires the engine in any case or spacing", () => {
  assert.equal(isEngineRequired([], { NEXT_PUBLIC_INSTANT_IMPORT: "All" }), true);
  assert.equal(isEngineRequired([], { NEXT_PUBLIC_INSTANT_IMPORT: " Admins " }), true);
  assert.equal(isEngineRequired([], { NEXT_PUBLIC_INSTANT_IMPORT: "all" }), true);
});

test("off, empty or unknown flag values keep the build optional", () => {
  assert.equal(isEngineRequired([], { NEXT_PUBLIC_INSTANT_IMPORT: "off" }), false);
  assert.equal(isEngineRequired([], {}), false);
  assert.equal(isEngineRequired([], { NEXT_PUBLIC_INSTANT_IMPORT: "everyone" }), false);
});

test("--require and INSTANT_ENGINE_REQUIRED=1 always require it", () => {
  assert.equal(isEngineRequired(["--require"], {}), true);
  assert.equal(isEngineRequired([], { INSTANT_ENGINE_REQUIRED: "1" }), true);
});

test("normalizeFlag matches the app's parsing", () => {
  assert.equal(normalizeFlag(" ALL "), "all");
  assert.equal(normalizeFlag(undefined), "");
});
