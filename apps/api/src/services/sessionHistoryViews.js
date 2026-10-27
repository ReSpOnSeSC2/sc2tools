"use strict";

const { ordered, sessionize } = require("./sessions");
const { historySummaryCandidates } = require("./sessionHistorySummary");
const { digest, encode } = require("./sessionHistoryDescriptor");
const { publicWindow, DAY } = require("./sessionHistoryWindow");

/** @param {import('./sessionHistoryTypes').HistoryContext} context @param {number} start @param {number} end @param {number} index @param {number} length
 * @returns {import('./sessionHistoryTypes').HistoryCoverage|null} */
function certify(context, start, end, index, length) {
  const { span, floor, ceiling, gapMinutes } = context, gap = gapMinutes * 60_000;
  const left = index > 0 || span.scanFrom <= start - gap ? "gap"
    : (floor !== null && span.scanFrom === floor) ? "scope" : null;
  const right = index < length - 1 || span.scanTo >= end + gap ? "gap"
    : ceiling < span.asOf && span.scanTo === ceiling ? "scope"
      : span.scanTo === span.asOf ? "as_of" : null;
  return left && right ? { left, right } : null;
}
/** @param {Record<string,unknown>[]} rows @param {import('./sessionHistoryTypes').HistoryContext} context
 * @returns {import('./sessionHistoryTypes').CompleteCandidate[]} */
function completeCandidates(rows, context) {
  const groups = sessionize(rows, { gapMinutes: context.gapMinutes });
  const summaries = historySummaryCandidates(rows, { gapMinutes: context.gapMinutes });
  return groups.map((group, index) => {
    const candidate = summaries[index];
    const games = ordered(group.games).map(({ game }, position) => {
      const table = /** @type {ReturnType<import('./sessionHistoryQuery').tableMetadata>} */ (game.table);
      const member = candidate.members[position];
      return { ...member, ...table, id: member.gameId };
    });
    const h = digest({ order: candidate.memberDigest, summary: candidate.summary, games });
    const descriptor = { v: /** @type {const} */ (1), k: context.mode, s: context.scopeHash, g: context.gapMinutes,
      a: context.mode === "current" ? context.anchor : null, f: candidate.summary.start, e: candidate.summary.end, h };
    return { candidate, games, descriptor, start: group.start, end: group.end,
      coverage: certify(context, group.start, group.end, index, groups.length) };
  });
}
/** @param {import('./sessionHistoryTypes').CompleteCandidate} value @param {import('./sessionHistoryTypes').HistoryContext} context
 * @returns {import('./sessionHistoryTypes').HistorySummary} */
function publicSummary(value, context) {
  if (!value.coverage) throw new Error("session_history_unproved_boundary");
  return { ...value.candidate.summary, id: encode(value.descriptor), active: value.coverage.right === "as_of" && context.span.asOf - value.end <= context.gapMinutes * 60_000,
    coverage: value.coverage, mmr: value.candidate.summary.mmr.map(track => ({ myToonHandle: track.myToonHandle,
      ladderRace: track.ladderRace, ratingScope: track.ratingScope, comparable: track.comparable, games: track.games, samples: track.samples, missingGames: track.missingGames,
      legacySamples: track.legacySamples, start: track.start, end: track.end, delta: track.delta, peak: track.peak })) };
}
/** @param {import('./sessionHistoryTypes').CompleteCandidate} value @param {import('./sessionHistoryTypes').HistoryContext} context */
function inOutput(value, context) {
  return value.candidate.members.some(member => { const time = Date.parse(member.date); return time >= context.span.from && time < context.span.to; });
}
/** @param {import('./sessionHistoryTypes').HistoryContext} context @param {boolean} overflow @param {import('./sessionHistoryTypes').CompleteCandidate[]} candidates
 * @returns {import('./sessionHistoryTypes').HistoryLoad} */
function shapeLoad(context, overflow, candidates) {
  const selected = candidates.filter(value => inOutput(value, context));
  const unproved = selected.some(value => !value.coverage);
  const status = overflow ? "narrow_window" : unproved ? "context_required" : "ready";
  const issue = overflow ? { code: "session_history_limit", message: "This window exceeds the bounded history limit. Choose a narrower window; a single oversized session cannot be shown completely.", suggestedContextDays: null }
    : unproved ? { code: "session_history_context_required", message: "More boundary context is required before a complete session can be shown.",
      suggestedContextDays: context.span.contextDays < 30 ? Math.min(30, Math.max(1, context.span.contextDays * 2)) : null } : null;
  return { context, status, issue, candidates,
    digest: digest({ version: 1, context, candidates: candidates.map(value => ({ descriptor: value.descriptor, coverage: value.coverage })) }) };
}
/** @param {import('./sessionHistoryTypes').HistoryLoad} load @returns {import('./sessionHistoryTypes').HistoryBase} */
function base(load) {
  const { mode, gapMinutes, scopeHash } = load.context;
  return { status: load.status, definition: { mode, gapMinutes, scopeHash }, window: publicWindow(load.context.span), issue: load.issue };
}
/** @param {import('./sessionHistoryTypes').HistoryContext} context */
function olderWindow(context) {
  const to = context.span.from;
  if (context.floor !== null && to <= context.floor) return null;
  return { from: new Date(Math.max(context.floor ?? -8_640_000_000_000_000, to - 30 * DAY)).toISOString(), to: new Date(to).toISOString() };
}
module.exports = { certify, completeCandidates, publicSummary, inOutput, shapeLoad, base, olderWindow };
