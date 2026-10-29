"use strict";

const { DeviceAuthLease } = require("./deviceAuthLease");
const { DeviceAuthReuse } = require("./deviceAuthReuse");

/** @type {WeakMap<object,DeviceAuthReuse>} */
const instances = new WeakMap();

/** Optional REST-only adapter. No serving app injects it until the separate
 * prepared-incarnation/cutover/activation gates are satisfied. No reader boot,
 * authority creation, active write or uncertainty repair is performed here.
 * @param {any} db @param {(hash:string,options:any)=>Promise<any>} readSnapshot
 * @param {()=>number} wallNow */
function deviceRestAuthFor(db, readSnapshot, wallNow) {
  // Standalone compatibility is writer-only. An omitted/unknown capability
  // cannot silently create a retained reader, even with a forged active row.
  if (db.deviceCredentialReadiness !== "causal") return null;
  let adapter = instances.get(db);
  if (!adapter) {
    const lease = new DeviceAuthLease(db.db.collection("jobLocks"), db.client);
    adapter = new DeviceAuthReuse(lease, readSnapshot, { wallNow });
    instances.set(db, adapter);
  }
  return adapter;
}

module.exports = { deviceRestAuthFor };
