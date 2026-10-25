"use strict";

const { validateReferenceBuildOrder, limits } = require("../validation/referenceBuildOrder");

/** Only reference-step notes are public; source replay IDs always stay private.
 * @param {unknown} raw */
function publicReferenceBuildOrder(raw) {
  const result = validateReferenceBuildOrder(raw);
  if (!result.valid) return undefined;
  const order = /** @type {Record<string, unknown>} */ (result.value);
  return { v: order.v, source: order.source, steps: order.steps };
}

/** Mongo bounds every retained leaf and array before it reaches Node. An absent
 * optional field stays absent, including on documents saved before this feature.
 * @param {string} path @param {boolean} [privateSource] */
function referenceBuildOrderMongoExpression(path, privateSource = false) {
  const text = (/** @type {string} */ leaf, /** @type {number} */ cap) => ({ $cond: [
    { $eq: [{ $type: leaf }, "string"] }, { $substrCP: [leaf, 0, cap] }, null,
  ] });
  const number = (/** @type {string} */ leaf) => ({ $cond: [
    { $in: [{ $type: leaf }, ["int", "long", "double", "decimal"]] }, leaf, null,
  ] });
  return { $cond: [{ $eq: [{ $type: path }, "object"] }, {
    v: number(`${path}.v`), source: text(`${path}.source`, 16),
    ...(privateSource ? { sourceGameId: { $cond: [
      { $eq: [{ $type: `${path}.sourceGameId` }, "string"] },
      text(`${path}.sourceGameId`, limits.gameIdChars), "$$REMOVE",
    ] } } : {}),
    steps: { $map: { input: { $slice: [{ $cond: [{ $isArray: `${path}.steps` }, `${path}.steps`, []] }, limits.steps] }, as: "step", in: {
      t: number("$$step.t"), supply: number("$$step.supply"), action: text("$$step.action", limits.actionChars),
      note: { $cond: [{ $eq: [{ $type: "$$step.note" }, "string"] }, text("$$step.note", limits.noteChars), "$$REMOVE"] },
      supplyApprox: { $cond: [{ $eq: [{ $type: "$$step.supplyApprox" }, "bool"] }, "$$step.supplyApprox", "$$REMOVE"] },
    } } },
  }, "$$REMOVE"] };
}

module.exports = { publicReferenceBuildOrder, referenceBuildOrderMongoExpression };
