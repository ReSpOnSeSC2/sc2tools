// @ts-nocheck
"use strict";
// Exact-command tests compare against the stamped form of an update (util/corpusUpdatedAt.js), matching only the
// stamp's clock value loosely.
const { withUpdatedAt } = require("../../src/util/corpusUpdatedAt");

/** @param {Record<string, any>|Array<Record<string, any>>} update */
function stamped(update) {
  const result = withUpdatedAt(update);
  if (!Array.isArray(result)) return { ...result, $set: { ...result.$set, updatedAt: expect.any(Date) } };
  const [same] = result.at(-2).$set.updatedAt.$cond;
  return [...result.slice(0, -2), { $set: { updatedAt: { $cond: [same, "$updatedAt", expect.any(Date)] } } }, result.at(-1)];
}

/** The caller's own stages of an issued stamped pipeline: the snapshot stage leads, the stamp and cleanup trail.
 * @param {Array<Record<string, any>>} pipeline */
const original = pipeline => (pipeline[0]?.$set && "_corpusBefore" in pipeline[0].$set ? pipeline.slice(1, -2) : pipeline);

module.exports = { stamped, original };
