"use strict";
const AjvModule = require("ajv");
const { SECTION_KEYS } = require("../util/publicPlayerConfig");
const Ajv = /** @type {any} */ (AjvModule).default || AjvModule;
/** @type {Record<string,any>} */
const properties = { enabled: { type: "boolean" }, slug: { type: ["string", "null"], maxLength: 64 }, revision: { type: "integer", minimum: 0 } };
for (const key of SECTION_KEYS) properties[key] = { type: "boolean" };
const validate = new Ajv({ allErrors: true }).compile({ type: "object", additionalProperties: false,
  required: ["enabled", "slug", "revision", ...SECTION_KEYS], properties });

/** @param {unknown} input @returns {{valid:true,value:any}|{valid:false,errors:string[]}} */
function validatePublicPlayer(input) {
  if (!validate(input)) return { valid: false, errors: (validate.errors || []).map((/** @type {any} */ error) => `${error.instancePath || "/"} ${error.message}`) };
  return { valid: true, value: /** @type {any} */ (input) };
}
module.exports = { validatePublicPlayer };
