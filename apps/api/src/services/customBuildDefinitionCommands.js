"use strict";

const { ObjectId } = require("mongodb");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const { publicBuildMongoExpression } = require("./communityBuildSnapshot");
const ROOT_PUBLIC_BUILD_EXPRESSION = publicBuildMongoExpression("$$ROOT");

/** @param {any} build @returns {"you"|"opponent"} */
function buildPerspective(build) {
  return build && build.perspective === "opponent" ? "opponent" : "you";
}

/** @param {any} previous @param {Record<string,unknown>} next
 * @param {"you"|"opponent"} [perspective] @returns {string|null} */
function checkinRenameTarget(previous, next, perspective = "you") {
  if (!previous || buildPerspective(next) !== perspective) return null;
  const name = typeof next.name === "string" && next.name ? next.name : null;
  if (name === null) return null;
  return previous.name === name && buildPerspective(previous) === perspective
    ? null
    : name;
}

/** Preserve the two original read forms, including their different predicates.
 * @param {import('../db/connect').DbContext} db @param {string} userId
 * @param {Readonly<import('./gameStatsCustomBuildDefinitionSave').DefinitionSaveMutation>} mutation
 * @param {import('mongodb').ClientSession|undefined} session */
function readDefinition(db, userId, mutation, session) {
  const slug = mutation.definition.slug;
  if (mutation.recordHistory) return db.customBuilds.aggregate([
    { $match: { userId, slug, deletedAt: { $exists: false }, ...(mutation.expectedId ? { _id: new ObjectId(mutation.expectedId) } : {}) } },
    { $limit: 1 },
    { $project: { _id: 0, ...ROOT_PUBLIC_BUILD_EXPRESSION, definitionRevision: { $ifNull: ["$definitionRevision", 0] }, updatedAt: 1 } },
  ], session ? { session } : {}).next();
  return typeof db.customBuilds.findOne === "function" ? db.customBuilds.findOne(
    { userId, slug },
    { projection: { _id: 0, name: 1, perspective: 1, definitionRevision: 1 }, ...(session ? { session } : {}) },
  ) : Promise.resolve(null);
}

/** @param {string} userId @param {Readonly<import('./gameStatsCustomBuildDefinitionSave').DefinitionSaveMutation>} mutation */
function definitionFilter(userId, mutation) {
  return { userId, slug: mutation.definition.slug,
    ...(mutation.expectedRevision === undefined ? {} : { deletedAt: { $exists: false } }),
    ...(mutation.expectedId ? { _id: new ObjectId(mutation.expectedId) } : {}),
    ...(mutation.expectedRevision === undefined ? {} : mutation.expectedRevision === 0
      ? { $or: [{ definitionRevision: 0 }, { definitionRevision: { $exists: false } }] }
      : { definitionRevision: mutation.expectedRevision }) };
}

/** Private save data is distinct from the bounded public history projection.
 * @param {string} userId @param {Readonly<import('./gameStatsCustomBuildDefinitionSave').DefinitionSaveMutation>} mutation
 * @param {any} previous @param {Date} now */
function definitionWriteCommand(userId, mutation, previous, now) {
  /** @type {Record<string,any>} */ const doc = { ...mutation.definition, userId, updatedAt: now };
  for (const field of ["_id", "deletedAt", "_schemaVersion", "reclassifyJob", "definitionRevision", "_definitionHistory"]) delete doc[field];
  stampVersion(doc, COLLECTIONS.CUSTOM_BUILDS);
  return { filter: definitionFilter(userId, mutation), update: {
    $setOnInsert: { createdAt: now }, $set: doc, $unset: { deletedAt: "" }, $inc: { definitionRevision: 1 },
    ...(mutation.recordHistory && previous ? { $push: { _definitionHistory: { $each: [{
      revision: previous.definitionRevision || 0, savedAt: now,
      build: Object.fromEntries(Object.entries(previous).filter(([key]) => key !== "definitionRevision" && key !== "updatedAt")),
    }], $slice: -10 } } } : {}),
  }, upsert: mutation.expectedRevision === undefined };
}

module.exports = { buildPerspective, checkinRenameTarget, readDefinition, definitionWriteCommand };
