"use strict";
const ENDED_CONTROL_MS = 30 * 60_000;
/** Cloud-only metadata, separate from the active opponent projection. Menu
 * heartbeats cannot extend its lifetime; a new active game clears it.
 * @param {Record<string,any>} envelope @param {Record<string,any>|undefined} previous @param {number} now
 */
function withEndedGameControl(envelope, previous, now) {
  const next = { ...envelope }; delete next.lastEndedGame;
  if (envelope.isReplay) return next;
  const key = typeof envelope.gameKey === "string" && envelope.gameKey.trim().length > 0 && envelope.gameKey.length <= 120 ? envelope.gameKey : null;
  const before = previous?.lastEndedGame;
  if (envelope.phase === "match_ended" && key) {
    const same = before?.gameKey === key;
    const endedAt = same && typeof before?.endedAt === "number" && Number.isFinite(before.endedAt) ? before.endedAt : now;
    // Keep one receipt, including its expired timestamp, through menu/idle.
    // A delayed same-key end cannot restart eligibility after expiry.
    next.lastEndedGame = { gameKey: key, endedAt };
  } else if (["menu", "idle"].includes(envelope.phase) && typeof before?.gameKey === "string"
    && typeof before.endedAt === "number" && Number.isFinite(before.endedAt)) {
    next.lastEndedGame = { gameKey: before.gameKey, endedAt: before.endedAt };
  }
  return next;
}
module.exports = { withEndedGameControl, ENDED_CONTROL_MS };
