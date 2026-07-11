"use strict";

/**
 * Minimal content hygiene for user-supplied community text (build
 * titles/descriptions, author display names, report notes).
 *
 * Deliberately conservative: this is NOT a full profanity system —
 * it strips control characters and zero-width tricks, collapses
 * whitespace, removes links from display names (link spam +
 * impersonation vector), and blocks a short list of unambiguous slurs.
 * False positives are worse than the occasional miss for a community
 * this size; anything nuanced goes through the report → admin
 * moderation queue instead.
 */

// Compact blocklist of unambiguous terms, matched case-insensitively
// with common leetspeak substitutions folded first. Kept deliberately
// short: every entry must be unambiguous in ANY context.
const BLOCKED_TERMS = [
  "nigger",
  "nigga",
  "faggot",
  "kike",
  "chink",
  "spic",
  "tranny",
];

/** @type {Record<string, string>} */
const LEET_MAP = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
  "$": "s",
  "!": "i",
};

const URL_RE = /(?:https?:\/\/|www\.)\S+/gi;
// Control chars (keep \n for descriptions), zero-width + bidi
// override characters used to disguise text.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = new RegExp(
  "[\u0000-\u0009\u000b-\u001f\u007f"
  + "\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]",
  "g",
);

/**
 * Normalise for blocklist matching: lowercase, fold leet
 * substitutions, drop separators so "n.i.g" style spacing doesn't
 * evade the match.
 *
 * @param {string} value
 */
function foldForMatch(value) {
  const lowered = value.toLowerCase();
  let folded = "";
  for (const ch of lowered) {
    folded += Object.prototype.hasOwnProperty.call(LEET_MAP, ch)
      ? LEET_MAP[ch]
      : ch;
  }
  return folded.replace(/[^a-z]/g, "");
}

/**
 * @param {string} value
 * @returns {boolean} true when the text contains a blocked term.
 */
function containsBlockedTerm(value) {
  if (!value) return false;
  const folded = foldForMatch(String(value));
  return BLOCKED_TERMS.some((term) => folded.includes(term));
}

/**
 * Clean a free-text field: strip control/zero-width characters and
 * collapse runs of whitespace. Newlines survive only when
 * ``multiline`` is set (descriptions).
 *
 * @param {string} value
 * @param {{ multiline?: boolean }} [opts]
 */
function cleanText(value, opts = {}) {
  let out = String(value || "").replace(CONTROL_RE, "");
  if (opts.multiline) {
    out = out
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");
  } else {
    out = out.replace(/\s+/g, " ");
  }
  return out.trim();
}

/**
 * Clean a display name (author names): everything cleanText does,
 * plus URL removal — a display name is rendered on public pages and
 * aggregated onto author profiles, so it must never carry link spam.
 *
 * @param {string} value
 */
function cleanDisplayName(value) {
  return cleanText(String(value || "").replace(URL_RE, ""), {});
}

module.exports = {
  cleanText,
  cleanDisplayName,
  containsBlockedTerm,
};
