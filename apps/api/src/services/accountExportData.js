"use strict";

const { USER_SCOPED_COLLECTIONS, publicCoachingParty, publicCoachedStudent,
  exportedCoachingAssignment, exportedCoachingCalendar } = require("./accountExportPolicy");

/** @typedef {{type:'collection', name:string}|{type:'record', collection:string, row:any}|{type:'user', row:any}} ExportRecord */
/** @param {AbortSignal|undefined} signal */
function checkExportSignal(signal) { signal?.throwIfAborted(); }

/** One Mongo document at a time. Driver cancellation interrupts held next/getMore.
 * @param {any} collection @param {object} filter @param {object|undefined} projection
 * @param {AbortSignal|undefined} signal
 */
async function* exportRows(collection, filter, projection, signal) {
  checkExportSignal(signal);
  const cursor = collection.find(filter, { projection, batchSize: 1, signal });
  try {
    for await (const row of cursor) {
      checkExportSignal(signal);
      yield row;
      checkExportSignal(signal);
    }
  } finally { await cursor.close(); }
  checkExportSignal(signal);
}

/** @param {any} db @param {string} name @param {object} filter
 * @param {object|undefined} projection @param {AbortSignal|undefined} signal
 * @param {(row:any)=>any} [redact]
 * @returns {AsyncGenerator<ExportRecord>}
 */
async function* collectionRecords(db, name, filter, projection, signal, redact = row => row) {
  if (!db[name]) return;
  checkExportSignal(signal);
  yield { type: "collection", name };
  for await (const row of exportRows(db[name], filter, projection, signal)) {
    yield { type: "record", collection: name, row: redact(row) };
  }
}

/** The same five projections serve the existing reviews API and the full archive.
 * @param {any} db @param {string} userId @param {AbortSignal} [signal]
 * @returns {AsyncGenerator<ExportRecord>}
 */
async function* reviewExportRecords(db, userId, signal) {
  yield* collectionRecords(db, "reviewRequests", { userId }, { activeKey: 0 }, signal);
  yield* collectionRecords(db, "reviewComments", { authorId: userId }, { removedBy: 0 }, signal);
  yield* collectionRecords(db, "reviewKarmaEvents", { userId }, { _id: 0, actorId: 0 }, signal);
  yield* collectionRecords(db, "reviewBlocks", { blockerId: userId }, { _id: 0, blockedId: 0 }, signal);
  yield* collectionRecords(db, "notifications", { userId }, undefined, signal);
}

/** Locker is one existing Mongo document; do not build another relationship array.
 * @param {any} db @param {string} userId @param {AbortSignal|undefined} signal
 * @returns {AsyncGenerator<ExportRecord>}
 */
async function* coachingRelationships(db, userId, signal) {
  yield { type: "collection", name: "coachingRelationships" };
  /** @type {any} */ let locker = null;
  for await (const row of exportRows(db.coaching, { _id: "locker" },
    { _id: 0, "state.coaches": 1, "state.students": 1 }, signal)) locker = row;
  const coaches = Array.isArray(locker?.state?.coaches) ? locker.state.coaches : [];
  const students = Array.isArray(locker?.state?.students) ? locker.state.students : [];
  const coachedIds = new Set();
  for (const coach of coaches) {
    checkExportSignal(signal);
    if (coach?.userId !== userId) continue;
    if (coach.id) coachedIds.add(coach.id);
    yield { type: "record", collection: "coachingRelationships", row: { role: "coach", coach } };
  }
  for (const student of students) {
    checkExportSignal(signal);
    if (student?.userId !== userId) continue;
    const coach = publicCoachingParty(coaches.find((/** @type {any} */ row) => row?.id === student.coachId));
    yield { type: "record", collection: "coachingRelationships", row: { role: "student", student, coach } };
  }
  for (const student of students) {
    checkExportSignal(signal);
    if (student && student.userId !== userId && coachedIds.has(student.coachId)) {
      yield { type: "record", collection: "coachingRelationships", row: { role: "coach_of_student", student: publicCoachedStudent(student) } };
    }
  }
}

/** @param {any} db @param {string} userId @param {AbortSignal|undefined} signal
 * @returns {AsyncGenerator<ExportRecord>}
 */
async function* coachingRecords(db, userId, signal) {
  const assignments = { kind: "game_requirement", $or: [
    { studentUserId: userId }, { coachUserId: userId }, { createdByUserId: userId },
  ] };
  // These three export names share one physical collection.
  yield { type: "collection", name: "coachingAssignments" };
  for await (const row of exportRows(db.coaching, assignments, { _id: 0 }, signal)) {
    yield { type: "record", collection: "coachingAssignments", row: exportedCoachingAssignment(row, userId) };
  }
  yield* coachingRelationships(db, userId, signal);
  const calendars = { _id: { $regex: "^calendar:" }, $or: [
    { coachUserId: userId }, { "bookings.studentUserId": userId },
  ] };
  yield { type: "collection", name: "coachingCalendars" };
  for await (const row of exportRows(db.coaching, calendars, { _id: 0 }, signal)) {
    yield { type: "record", collection: "coachingCalendars", row: exportedCoachingCalendar(row, userId) };
  }
}

/** Shared source for legacy JSON and NDJSON: one privacy policy, no archive-sized arrays.
 * @param {any} db @param {string} userId
 * @param {{includeSharedCoaching?:boolean,reviews?:boolean,signal?:AbortSignal}} [options]
 * @returns {AsyncGenerator<ExportRecord>}
 */
async function* accountExportRecords(db, userId, options = {}) {
  const { signal } = options;
  for (const [name] of USER_SCOPED_COLLECTIONS) {
    yield* collectionRecords(db, name, { userId }, { _id: 0 }, signal);
  }
  yield* collectionRecords(db, "playerIdentitySubmissions", { userId }, { _id: 0, reviewedBy: 0, evidenceMaxId: 0 }, signal);
  yield* collectionRecords(db, "multichatSounds", { userId }, { _id: 0, data: 0 }, signal);
  yield* collectionRecords(db, "playerGoals", { userId }, { _id: 0, slot: 0, criteriaRevision: 0 }, signal);
  yield* collectionRecords(db, "supporters", { userId }, { _id: 0, editId: 0, reviewedBy: 0 }, signal);
  // Delivery channels: a Discord webhook URL is a credential for someone
  // else's server, so only its last four characters leave; push endpoints
  // and their keys are the caller's own device registrations.
  yield* collectionRecords(db, "streamSessions", { userId }, { _id: 0 }, signal);
  yield* collectionRecords(db, "discordHooks", { userId }, { _id: 0, enc: 0 }, signal);
  yield* collectionRecords(db, "pushSubscriptions", { userId }, { _id: 0, endpointHash: 0 }, signal);
  // The link token is a bearer credential for the public page: the archive
  // lists each share (game, dates, views) but never the token itself.
  yield* collectionRecords(db, "gameShares", { userId }, { _id: 0, activeKey: 0 }, signal);
  if (db.coaching && options.includeSharedCoaching !== false) yield* coachingRecords(db, userId, signal);
  let user = null;
  const userProjection = { _id: 0, gameStats: 0, gameStatsRevision: 0, gameStatsProtocolVersion: 0,
    gameStatsWriterStatus: 0, gameStatsMutationEpoch: 0, gameStatsMaintenance: 0 };
  for await (const row of exportRows(db.users, { userId }, userProjection, signal)) { user = row; break; }
  yield { type: "user", row: user };
  yield* collectionRecords(db, "playerChannels", { ownerUserId: userId }, { _id: 0, updatedBy: 0 }, signal);
  if (options.reviews) yield* reviewExportRecords(db, userId, signal);
  yield* collectionRecords(db, "adminAudit", { $or: [{ actorUserId: userId }, { target: userId }] }, { _id: 0 }, signal,
    row => ({ ...row, actorUserId: row.actorUserId === userId ? userId : null, target: row.target === userId ? userId : null }));
}

/** @param {AsyncIterable<ExportRecord>} records */
async function collectRecords(records) {
  /** @type {Record<string,any[]>} */ const data = {};
  let user = null;
  for await (const record of records) {
    if (record.type === "collection") data[record.name] = [];
    else if (record.type === "record") data[record.collection].push(record.row);
    else user = record.row;
  }
  return { user, data };
}

/** @param {any} db @param {string} userId @param {Parameters<typeof accountExportRecords>[2]} [options] */
async function collectAccountExport(db, userId, options) {
  const { user, data } = await collectRecords(accountExportRecords(db, userId, options));
  return { userId, exportedAt: new Date().toISOString(), user, data };
}
/** @param {any} db @param {string} userId */
async function collectReviewExport(db, userId) {
  return (await collectRecords(reviewExportRecords(db, userId))).data;
}

module.exports = { accountExportRecords, collectAccountExport, collectReviewExport, checkExportSignal };
