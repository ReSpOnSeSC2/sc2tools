"use strict";

/** Credential readiness capability from the existing acknowledged hello.
 * This is a topology fact, never cache activation or a missing-floor fallback.
 * @param {any} hello @returns {'causal'|'writer-only-standalone'|'unavailable'} */
function credentialReadinessCapability(hello) {
  if (!supportedHello(hello)) return "unavailable";
  const sessions = Number.isSafeInteger(hello.logicalSessionTimeoutMinutes) && hello.logicalSessionTimeoutMinutes > 0;
  if ((typeof hello.setName === "string" && hello.setName.length > 0) || hello.msg === "isdbgrid") {
    return sessions ? "causal" : "unavailable";
  }
  if (standaloneHello(hello)) return "writer-only-standalone";
  return "unavailable";
}

/** @param {any} hello */
function supportedHello(hello) {
  return !!hello && hello.ok === 1 && Number.isSafeInteger(hello.maxWireVersion) && hello.maxWireVersion >= 7;
}

/** Absence alone never qualifies: require an acknowledged writable mongod
 * shape and reject every replica/router/unknown-membership marker.
 * @param {any} hello */
function standaloneHello(hello) {
  return hello.isWritablePrimary === true && !["setName", "msg", "isreplicaset", "hosts"].some(key => Object.hasOwn(hello, key));
}

module.exports = { credentialReadinessCapability };
