"use strict";

const { ObjectId } = require("mongodb");
const { checkinRenameTarget, readDefinition, definitionWriteCommand } = require("./customBuildDefinitionCommands");
const { renameCustomOverrides, renameCustomOpponentOverrides } = require("./buildIntentAttribution");

/** @typedef {{kind:"customBuildDefinitionSave",definition:{slug:string}&Record<string,unknown>,
 * expectedRevision?:number,expectedId?:string,recordHistory?:boolean}} DefinitionSaveMutation */

/** Descriptors issued below, with their private data deep-frozen. The
 * in-transaction re-check returns them as-is: structuredClone may build the
 * private copy in a host realm (as under Jest), so re-validating it against
 * this realm's prototypes would reject valid data. */
const issuedDefinitionSaves = new WeakSet();

/** Closed root data only; never a query, callback, session or neutrality flag.
 * The private definition keeps the established save fields and their bounds.
 * @param {DefinitionSaveMutation} input @returns {Readonly<DefinitionSaveMutation>} */
function immutableCustomBuildDefinitionSave(input) {
  if (issuedDefinitionSaves.has(input)) return input;
  if (!definitionFields(input)) throw definitionInvalid();
  const privateData = definitionSaveData(input.definition);
  if (typeof privateData.slug !== "string" || !privateData.slug) throw new Error("slug required");
  if (!definitionData(privateData, new Set())) throw definitionInvalid();
  const definition = frozenDefinitionData(structuredClone(privateData));
  const issued = Object.freeze(definitionOptions(input, definition));
  issuedDefinitionSaves.add(issued);
  return issued;
}

/** Validate and snapshot only the existing CAS/history options. The original
 * ID validation precedes private freezing and option copying for valid data.
 * @param {DefinitionSaveMutation} input @param {{slug:string}&Record<string,unknown>} definition
 * @returns {DefinitionSaveMutation} */
function definitionOptions(input, definition) {
  if (input.expectedRevision !== undefined && typeof input.expectedRevision !== "number") throw definitionInvalid();
  if (input.expectedId && typeof input.expectedId !== "string") throw definitionInvalid();
  if (input.expectedId) new ObjectId(input.expectedId);
  return { kind: "customBuildDefinitionSave", definition: Object.freeze(definition),
    ...(input.expectedRevision === undefined ? {} : { expectedRevision: structuredClone(input.expectedRevision) }),
    ...(input.expectedId === undefined ? {} : { expectedId: input.expectedId }), recordHistory: !!input.recordHistory };
}

/** @param {DefinitionSaveMutation} input */
function definitionFields(input) {
  return plainDataObject(input) && Object.hasOwn(input, "kind") && Object.hasOwn(input, "definition")
    && input.kind === "customBuildDefinitionSave"
    && Reflect.ownKeys(input).every(key => typeof key === "string" && ["kind", "definition", "expectedRevision", "expectedId", "recordHistory"].includes(key))
    && plainDataObject(input.definition);
}

/** Omitted server-owned fields are never part of the private save command.
 * @param {{slug:string}&Record<string,unknown>} definition */
function definitionSaveData(definition) {
  /** @type {{slug:string}&Record<string,unknown>} */ const data = { ...definition };
  for (const field of ["_id", "deletedAt", "_schemaVersion", "reclassifyJob", "definitionRevision", "_definitionHistory"]) delete data[field];
  return data;
}

/** Validate descriptors without invoking a private-field getter.
 * @param {any} input */
function plainDataObject(input) {
  return !!input && Object.getPrototypeOf(input) === Object.prototype
    && Reflect.ownKeys(input).every(key => typeof key === "string")
    && Object.values(Object.getOwnPropertyDescriptors(input)).every(field => Object.hasOwn(field, "value"));
}

/** JSON/Date definition data retains explicit undefined; it is not a public
 * projection or a BSON byte-budget gate. @param {any} input @param {Set<object>} seen @returns {boolean} */
function definitionData(input, seen) {
  if (input === null || typeof input !== "object") return !["function", "symbol"].includes(typeof input);
  if (input instanceof Date) return true;
  if (seen.has(input)) return false;
  if (!Array.isArray(input) && !plainDataObject(input)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (!Object.values(descriptors).every(field => Object.hasOwn(field, "value"))) return false;
  seen.add(input);
  const valid = Object.values(descriptors).every(field => definitionData(field.value, seen));
  seen.delete(input);
  return valid;
}

/** Freeze the validated private copy throughout, so an issued descriptor's
 * structure cannot change after validation (a Date keeps its own time value).
 * @param {any} value @returns {any} */
function frozenDefinitionData(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const field of Object.values(value)) frozenDefinitionData(field);
  }
  return value;
}

/** Fixed body shares the owner's transaction; compatibility alone owns the
 * legacy first-read code20 boundary. No notification runs in a retry callback.
 * @param {import('../db/connect').DbContext} db @param {import('./gameStatsWrites').GameStatsOwner} owner
 * @param {Readonly<DefinitionSaveMutation>} mutation @param {import('mongodb').ClientSession|undefined} session
 * @param {any} [logger] @returns {Promise<number>} */
function applyCustomBuildDefinitionSave(db, owner, mutation, session, logger) {
  return session ? saveDefinition(db, owner.userId, mutation, session)
    : legacyDefinitionSave(db, owner.userId, mutation, logger);
}

/** @param {import('../db/connect').DbContext} db @param {string} userId
 * @param {Readonly<DefinitionSaveMutation>} mutation @param {import('mongodb').ClientSession|undefined} session
 * @param {()=>void} [onInitialRead] @returns {Promise<number>} */
async function saveDefinition(db, userId, mutation, session, onInitialRead) {
  const previous = await readDefinition(db, userId, mutation, session);
  onInitialRead?.();
  if (mutation.expectedRevision !== undefined && (!previous || (previous.definitionRevision || 0) !== mutation.expectedRevision)) throw definitionChanged();
  const renamed = await renameDefinitionGames(db, userId, mutation.definition, previous, session);
  const command = definitionWriteCommand(userId, mutation, previous, new Date());
  const saved = await db.customBuilds.updateOne(command.filter, /** @type {import('mongodb').Document} */ (command.update),
    { upsert: command.upsert, ...(session ? { session } : {}) });
  if (mutation.expectedRevision !== undefined && !saved.matchedCount) throw definitionChanged();
  return renamed;
}

/** @param {import('../db/connect').DbContext} db @param {string} userId
 * @param {{slug:string}&Record<string,unknown>} definition @param {any} previous @param {import('mongodb').ClientSession|undefined} session */
async function renameDefinitionGames(db, userId, definition, previous, session) {
  const games = session && db.games ? /** @type {import('mongodb').Collection} */ (/** @type {unknown} */ ({
    updateMany: (/** @type {any} */ filter, /** @type {any} */ update) => db.games.updateMany(filter, update, { session }),
  })) : db.games;
  let renamed = 0;
  const you = checkinRenameTarget(previous, definition, "you"), opponent = checkinRenameTarget(previous, definition, "opponent");
  if (games && you !== null) renamed += await renameCustomOverrides(games, userId, definition.slug, you);
  if (games && opponent !== null) renamed += await renameCustomOpponentOverrides(games, userId, definition.slug, opponent);
  return renamed;
}

/** @param {import('../db/connect').DbContext} db @param {string} userId
 * @param {Readonly<DefinitionSaveMutation>} mutation @param {any} logger */
async function legacyDefinitionSave(db, userId, mutation, logger) {
  if (!db.client) throw definitionTransactionsRequired();
  const session = db.client.startSession();
  let initialReadCompleted = false;
  try {
    return await session.withTransaction(() => saveDefinition(db, userId, mutation, session, () => { initialReadCompleted = true; }));
  } catch (error) {
    const failure = /** @type {any} */ (error);
    if (!initialReadCompleted && failure?.code === 20 && /Transaction numbers are only allowed/.test(String(failure.message))) {
      if (mutation.expectedRevision !== undefined) throw definitionTransactionsRequired();
      return await saveDefinition(db, userId, mutation, undefined);
    }
    throw error;
  } finally {
    await disposeDefinitionSession(session, logger);
  }
}

/** Disposal cannot replace known success or the original transaction failure.
 * @param {import('mongodb').ClientSession} session @param {any} logger */
async function disposeDefinitionSession(session, logger) {
  try { await session.endSession(); }
  catch (error) { try { logger?.warn?.({ err: error }, "game_stats_session_cleanup_failed"); } catch { /* Diagnostic only. */ } }
}

function definitionChanged() { return Object.assign(new Error("build_definition_changed"), { status: 409, code: "build_definition_changed" }); }
function definitionTransactionsRequired() { return Object.assign(new Error("build_definition_transactions_required"), { status: 503, code: "build_definition_transactions_required" }); }
function definitionInvalid() { return Object.assign(new Error("game_stats_neutral_operation_invalid"), { status: 503, code: "game_stats_neutral_operation_invalid" }); }

module.exports = { immutableCustomBuildDefinitionSave, applyCustomBuildDefinitionSave, definitionTransactionsRequired };
