"use strict";

const AjvModule = require("ajv");
const addFormatsModule = require("ajv-formats");
const {
  BUILD_BODY_SCHEMA,
  VOTE_BODY_SCHEMA,
  FLAG_BODY_SCHEMA,
} = require("./schemas");

// ajv & ajv-formats ship CJS + ESM; under TS checkJs the default export is
// what we actually want as the constructor / function.
const Ajv = /** @type {any} */ (AjvModule).default || AjvModule;
const addFormats = /** @type {any} */ (addFormatsModule).default || addFormatsModule;

const ajv = new Ajv({ allErrors: true, removeAdditional: false, strict: false });
addFormats(ajv);

const validators = {
  build: ajv.compile(BUILD_BODY_SCHEMA),
  vote: ajv.compile(VOTE_BODY_SCHEMA),
  flag: ajv.compile(FLAG_BODY_SCHEMA),
};

/**
 * Run a named validator and return either the validated payload or a
 * structured error.
 *
 * @param {"build"|"vote"|"flag"} name
 * @param {unknown} payload
 * @returns {{ ok: true, value: any } | { ok: false, errors: object[] }}
 *
 * Example:
 *   const r = validate("vote", { vote: 1 });
 *   if (!r.ok) return res.status(400).json({ errors: r.errors });
 */
function validate(name, payload) {
  const fn = validators[name];
  if (!fn) {
    throw new Error(`Unknown validator: ${name}`);
  }
  const ok = fn(payload);
  if (ok) return { ok: true, value: payload };
  const errors = /** @type {Array<{instancePath?: string, message?: string, keyword: string, params: object}>} */
    (fn.errors || []);
  return { ok: false, errors: errors.map(formatError) };
}

/**
 * @param {{ instancePath?: string, message?: string, keyword: string, params: object }} err
 * @returns {{ path: string, message: string, keyword: string, params: object }}
 */
function formatError(err) {
  return {
    path: err.instancePath || "/",
    message: err.message || "invalid",
    keyword: err.keyword,
    params: err.params,
  };
}

module.exports = { validate };
