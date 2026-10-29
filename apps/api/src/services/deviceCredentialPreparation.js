"use strict";

const { randomUUID } = require("crypto");
const { AUTHORITY_KEY, OWNER_NAMESPACE, PROTOCOL_VERSION, validAuthority } = require("./deviceCredentialWrites");
const { copyDeviceAuthOperationTime } = require("./deviceAuthAuthority");

/** @param {number} deadline @param {()=>number|null} now */
function remaining(deadline, now) {
  const current = now();
  if (current === null || current >= deadline) throw new Error("device_credential_readiness_expired");
  return Math.max(1, Math.floor(deadline - current));
}

/** Literal command concern avoids the installed driver's collection CSOT
 * write-concern conversion. No existing row field is reset or repaired.
 * @param {any} collection @param {number} deadline @param {()=>number|null} now
 * @param {'causal'|'writer-only-standalone'|'unavailable'} capability */
async function prepareCredentialAuthority(collection, deadline, now, capability) {
  if (capability !== "causal" && capability !== "writer-only-standalone") throw new Error("device_credential_topology_unavailable");
  const client = collection?.client;
  if (!client) throw new Error("device_credential_authority_unavailable");
  const session = client.startSession({ causalConsistency: true });
  try {
    const database = client.db(collection.dbName);
    const row = await prepareRow(database, collection.collectionName, session, remaining(deadline, now));
    const floor = copyDeviceAuthOperationTime(session.operationTime);
    if (capability === "causal" && !floor) throw new Error("device_credential_authority_unavailable");
    if (floor) session.advanceOperationTime(floor);
    const current = await readPreparedRow(database, collection.collectionName, session,
      remaining(deadline, now), capability, floor, row.incarnation);
    remaining(deadline, now);
    return current;
  } finally { await session.endSession(); }
}

/** @param {any} database @param {string} name @param {any} session @param {number} timeout */
async function prepareRow(database, name, session, timeout) {
  const reply = await database.command({ findAndModify: name,
    query: { _id: AUTHORITY_KEY }, update: { $setOnInsert: {
      key: AUTHORITY_KEY, protocolVersion: PROTOCOL_VERSION, ownerHashNamespace: OWNER_NAMESPACE,
      incarnation: randomUUID(), generation: randomUUID(), mode: "prepared",
      grantsEverEnabled: true, denyAll: false, pending: [],
    } }, new: true, upsert: true, maxTimeMS: timeout,
    writeConcern: { w: "majority", j: true, wtimeout: timeout },
  }, { session, readPreference: "primary", timeoutMS: timeout });
  const row = acknowledgedRow(reply);
  if (!validAuthority(row)) throw new Error("device_credential_authority_unavailable");
  return row;
}

/** @param {any} database @param {string} name @param {any} session
 * @param {number} timeout @param {string} capability @param {any} floor @param {string} incarnation */
async function readPreparedRow(database, name, session, timeout, capability, floor, incarnation) {
  const reply = await database.command({ find: name,
    filter: { _id: AUTHORITY_KEY }, limit: 1, batchSize: 1, singleBatch: true,
    ...(capability === "causal" ? { readConcern: { level: "majority", afterClusterTime: floor } } : {}), maxTimeMS: timeout,
  }, { session, readPreference: "primary", timeoutMS: timeout });
  return validatedRead(reply, incarnation);
}

/** @param {any} reply @param {string} incarnation */
function validatedRead(reply, incarnation) {
  if (reply?.ok !== 1 || Object.hasOwn(reply, "writeConcernError")) throw new Error("device_credential_authority_unavailable");
  const batch = reply.cursor?.firstBatch;
  if (!Array.isArray(batch) || batch.length !== 1) throw new Error("device_credential_authority_unavailable");
  const row = batch[0];
  if (!validAuthority(row) || row.incarnation !== incarnation) throw new Error("device_credential_authority_unavailable");
  return row;
}

/** @param {any} reply */
function acknowledgedRow(reply) {
  if (!reply || reply.ok !== 1 || Object.hasOwn(reply, "writeConcernError") || reply.lastErrorObject?.n !== 1) return null;
  return reply.value;
}

module.exports = { prepareCredentialAuthority };
