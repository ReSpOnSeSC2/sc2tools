"use strict";

const { INGEST_PROVENANCE } = require("../config/constants");

/**
 * Legacy/restored documents bypass current write validation. Bound each
 * reported version inside Mongo before it enters a result page. Nested
 * conditions are deliberate: Mongo $and does not promise short-circuiting.
 * @param {string} field
 * @param {readonly string[]} sources
 * @param {number} maxLength
 * @param {string} pattern
 */
function reportedVersion(field, sources, maxLength, pattern) {
  const value = `$${field}`;
  return { $cond: [
    { $in: ["$ingestSource", sources] },
    { $cond: [
      { $eq: [{ $type: value }, "string"] },
      { $cond: [
        { $lte: [{ $strLenCP: value }, maxLength] },
        { $cond: [{ $regexMatch: { input: value, regex: pattern } }, value, "$$REMOVE"] },
        "$$REMOVE",
      ] },
      "$$REMOVE",
    ] },
    "$$REMOVE",
  ] };
}

const ANALYSIS_PROVENANCE_PROJECTION = Object.freeze({
  ingestSource: { $cond: [
    { $in: ["$ingestSource", INGEST_PROVENANCE.SOURCES] }, "$ingestSource", "$$REMOVE",
  ] },
  engineVersion: reportedVersion("engineVersion", INGEST_PROVENANCE.SOURCES,
    INGEST_PROVENANCE.ENGINE_VERSION_MAX_LENGTH, INGEST_PROVENANCE.ENGINE_VERSION_PATTERN),
  agentVersion: reportedVersion("agentVersion", [INGEST_PROVENANCE.SOURCE_AGENT],
    INGEST_PROVENANCE.AGENT_VERSION_MAX_LENGTH, INGEST_PROVENANCE.AGENT_VERSION_PATTERN),
});

module.exports = { ANALYSIS_PROVENANCE_PROJECTION };
