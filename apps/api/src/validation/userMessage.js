"use strict";

/**
 * Request validation for the optional fields of ``POST /v1/messages``
 * (routes/messages.js). Subject and message keep their own checks in the
 * route, whose error copy the report form shows as-is.
 *
 *   - ``type``: "problem", "idea" or "question".
 *   - ``context``: the diagnostics the web app attaches. Strict: only the
 *     whitelisted fields, each length-capped, at most five failed
 *     requests, and at most 2 KB of JSON overall.
 *
 * Either may be omitted (older clients, reports sent by email). Paths
 * are re-sanitised when the event is stored (services/reportContext.js).
 */

const AjvModule = require("ajv");
const {
  REPORT_TYPES,
  AGENT_STATUSES,
  REPORT_CONTEXT_MAX_BYTES,
  FAILED_REQUESTS_MAX,
  REPORT_CONTEXT_LIMITS: LIMITS,
  contextBytes,
} = require("../services/reportContext");

const Ajv = /** @type {any} */ (AjvModule).default || AjvModule;
const ajv = new Ajv({ allErrors: false });

const CONTEXT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    page: { type: "string", maxLength: LIMITS.page },
    build: { type: "string", maxLength: LIMITS.build },
    browser: { type: "string", maxLength: LIMITS.browser },
    viewport: { type: "string", maxLength: LIMITS.viewport },
    agentVersion: { type: "string", maxLength: LIMITS.agentVersion },
    agentStatus: { type: "string", enum: [...AGENT_STATUSES] },
    failedRequests: {
      type: "array",
      maxItems: FAILED_REQUESTS_MAX,
      items: {
        type: "object",
        required: ["path", "status"],
        additionalProperties: false,
        properties: {
          path: { type: "string", minLength: 1, maxLength: LIMITS.requestPath },
          status: { type: "integer", minimum: 0, maximum: 599 },
          code: { type: "string", maxLength: LIMITS.requestCode },
          requestId: { type: "string", maxLength: LIMITS.requestId },
        },
      },
    },
  },
};

const validateContextShape = ajv.compile(CONTEXT_SCHEMA);

/**
 * @typedef {{ valid: true, type: string | null, context: Record<string, unknown> | null }
 *   | { valid: false, message: string }} ReportExtrasResult
 */

/**
 * Validate a report body's ``type`` and ``context``.
 *
 * Example: ``validateReportExtras({ type: "idea" })``
 * → ``{ valid: true, type: "idea", context: null }``.
 *
 * @param {Record<string, unknown>} body
 * @returns {ReportExtrasResult}
 */
function validateReportExtras(body) {
  const rawType = body.type;
  if (rawType !== undefined && rawType !== null
    && (typeof rawType !== "string" || !REPORT_TYPES.includes(rawType))) {
    return { valid: false, message: "Choose a problem, an idea or a question." };
  }
  const rawContext = body.context;
  if (rawContext === undefined || rawContext === null) {
    return { valid: true, type: typeof rawType === "string" ? rawType : null, context: null };
  }
  if (!validateContextShape(rawContext)) {
    return { valid: false, message: "The details attached to this report are invalid." };
  }
  if (contextBytes(rawContext) > REPORT_CONTEXT_MAX_BYTES) {
    return { valid: false, message: "The details attached to this report are too large." };
  }
  return {
    valid: true,
    type: typeof rawType === "string" ? rawType : null,
    context: /** @type {Record<string, unknown>} */ (rawContext),
  };
}

module.exports = { validateReportExtras };
