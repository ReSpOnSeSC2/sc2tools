"use strict";

/**
 * Win / loss / tie / unknown classification of a stored game ``result``: the
 * API twin of the admin web's ``resultOf`` (app/admin/components/adminResult.ts).
 * Victory/Win is a win, Defeat/Loss a loss, Tie/Draw a tie, compared without
 * case or surrounding whitespace. Anything else, including "Undecided" and a
 * missing result, is unknown and never counts as a decided game.
 *
 * Example: `resultFilterQuery("tie")` → `{ result: /^\s*(?:tie|draw)\s*$/i }`.
 */

/** @typedef {"win"|"loss"|"tie"} ResultFilter */
/** @typedef {ResultFilter|"unknown"} ResultClass */

/** @type {ReadonlyArray<ResultFilter>} */
const RESULT_FILTERS = Object.freeze(["win", "loss", "tie"]);

/** @type {Readonly<Record<ResultFilter, readonly string[]>>} */
const RESULT_ALIASES = Object.freeze({
  win: Object.freeze(["victory", "win"]),
  loss: Object.freeze(["defeat", "loss"]),
  tie: Object.freeze(["tie", "draw"]),
});

/** @type {Readonly<Record<ResultFilter, RegExp>>} */
const RESULT_PATTERNS = Object.freeze({
  win: /^\s*(?:victory|win)\s*$/i,
  loss: /^\s*(?:defeat|loss)\s*$/i,
  tie: /^\s*(?:tie|draw)\s*$/i,
});

/** Aggregation expression: the row's result class, ``"unknown"`` for non-strings. */
const RESULT_CLASS_EXPR = Object.freeze({
  $let: {
    vars: {
      normalized: {
        $toLower: {
          $trim: { input: { $cond: [{ $eq: [{ $type: "$result" }, "string"] }, "$result", ""] } },
        },
      },
    },
    in: {
      $switch: {
        branches: RESULT_FILTERS.map((cls) => ({
          case: { $in: ["$$normalized", [...RESULT_ALIASES[cls]]] },
          then: cls,
        })),
        default: "unknown",
      },
    },
  },
});

/**
 * @param {unknown} raw
 * @returns {ResultClass}
 */
function resultClassOf(raw) {
  if (typeof raw !== "string") return "unknown";
  return RESULT_FILTERS.find((cls) => RESULT_PATTERNS[cls].test(raw)) || "unknown";
}

/**
 * Query-string ``result`` filter: absent → undefined; win|loss|tie → that
 * class; anything else is a 400 (an unknown filter must never silently list
 * every game).
 *
 * @param {unknown} raw
 * @returns {ResultFilter|undefined}
 */
function parseResultFilter(raw) {
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw === "string" && /** @type {readonly string[]} */ (RESULT_FILTERS).includes(raw)) {
    return /** @type {ResultFilter} */ (raw);
  }
  throw Object.assign(new Error("invalid_result_filter"), { status: 400, code: "invalid_result_filter" });
}

/**
 * Exact text filter (a map name or a user id): absent → undefined; a
 * bounded string without control characters or surrounding whitespace →
 * itself; anything else (arrays from repeated params, objects) is a 400.
 *
 * @param {unknown} raw
 * @param {string} code
 * @param {number} max
 * @returns {string|undefined}
 */
function parseExactText(raw, code, max) {
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw !== "string" || raw.length > max || raw.trim() !== raw
    || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw Object.assign(new Error(code), { status: 400, code });
  }
  return raw;
}

/**
 * @param {ResultFilter} result
 * @returns {{ result: RegExp }}
 */
function resultFilterQuery(result) {
  return { result: RESULT_PATTERNS[result] };
}

module.exports = {
  RESULT_FILTERS,
  RESULT_CLASS_EXPR,
  resultClassOf,
  parseResultFilter,
  parseExactText,
  resultFilterQuery,
};
