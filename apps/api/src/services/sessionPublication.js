"use strict";

/** Capture before resolving a session; never bless a completed old DTO with a
 * newly acquired generation. The closure adds no payload field or cache lane.
 * Legacy test/standalone producers without policy metadata stay compatible;
 * a policy-bearing result must have a real captured publication guard.
 * @param {((owner:string)=>(()=>void)|null)|undefined} factory
 * @param {string} owner
 * @returns {(session:unknown)=>void} */
function captureSessionPublication(factory, owner) {
  const guard = factory?.(owner);
  return (session) => {
    if (typeof guard === "function") { guard(); return; }
    if (session && typeof session === "object" && ["sessionGapMinutes", "sessionPolicySource", "storedSessionGapMinutes"].some(key => Object.hasOwn(session, key))) {
      throw Object.assign(new Error("session_policy_publication_unavailable"), { status: 503, code: "session_policy_publication_unavailable" });
    }
  };
}

module.exports = { captureSessionPublication };
