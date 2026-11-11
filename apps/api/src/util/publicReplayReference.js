"use strict";

const { ObjectId } = require("mongodb");

const REFERENCE = /^r-[0-9a-f]{24}$/;

/** @param {unknown} value @returns {value is string} */
function isPublicReplayReference(value) {
  return typeof value === "string" && REFERENCE.test(value);
}

/** @param {unknown} id */
function publicReplayReference(id) {
  return id instanceof ObjectId ? "r-" + id.toHexString() : null;
}

/** @param {string} reference */
function publicReplayObjectId(reference) {
  return isPublicReplayReference(reference) ? new ObjectId(reference.slice(2)) : null;
}

module.exports = { isPublicReplayReference, publicReplayReference, publicReplayObjectId };
