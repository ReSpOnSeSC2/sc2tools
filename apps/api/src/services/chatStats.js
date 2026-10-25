"use strict";

const { STATS_GAME_MATCH, OwnerRevisions } = require("../util/gameVisibility");
const { ladderRegionFromToonHandle, regionFromToonHandle, isLadderRegion } = require("../util/regionFromToonHandle");
const { plainText } = require("./chatCommands");
const DAY_MS = 86_400_000;
const MAX_ROWS = 10000;
const CACHE_TTL_MS = 30000;

/** @param {unknown} raw */
function result(raw) {
  const value = String(raw || "").toLowerCase();
  return value === "win" || value === "victory" ? "W" : value === "loss" || value === "defeat" ? "L" : null;
}
/** @param {unknown} raw */
function race(raw) { const value = String(raw || "").toUpperCase(); return /^[PTZR]/.test(value) ? value[0] : "?"; }
/** @param {any[]} rows */
function record(rows) { return { wins: rows.filter(row => result(row.result) === "W").length, losses: rows.filter(row => result(row.result) === "L").length }; }
/** @param {{wins:number,losses:number}} value */
function rate(value) { const n = value.wins + value.losses; return n ? `${Math.round(100 * value.wins / n)}% (${value.wins}W-${value.losses}L; n=${n})` : "no decided games (n=0)"; }
/** @param {any} row */
function rowRegion(row) {
  const own = regionFromToonHandle(row.myToonHandle);
  return own ? isLadderRegion(own) ? own : null : ladderRegionFromToonHandle(row.opponent?.toonHandle);
}

/** Native profiles carry a nested numeric character id, not replay-row fields.
 * Only exact toons, confidently resolved profiles or matched history identify
 * a current opponent. Never turn a barcode/display-name guess into a record.
 * @param {any} envelope */
function liveOpponentIdentity(envelope) {
  const opponent = envelope?.opponent;
  if (!opponent || typeof opponent !== "object") return null;
  const displayName = plainText(opponent.name).slice(0, 120);
  const toon = typeof opponent.toonHandle === "string" && /^\d+-S2-\d+-\d+$/.test(opponent.toonHandle) ? opponent.toonHandle : null;
  if (toon) return { displayName, pulseId: toon };
  const profile = opponent.profile;
  if (profile && profile.confidence !== undefined && profile.confidence !== 1) return null;
  const id = profile?.pulse_character_id;
  if ((typeof id === "number" && Number.isSafeInteger(id) && id > 0) || (typeof id === "string" && /^\d{1,32}$/.test(id))) {
    return { displayName, pulseCharacterId: String(id) };
  }
  const history = envelope.streamerHistory;
  if (history?.opponentIdentityMatched === true && typeof history.oppName === "string" && history.oppName.trim().toLowerCase() === String(opponent.name || "").trim().toLowerCase()
    && typeof history.opponentPulseId === "string" && /^\d+-S2-\d+-\d+$/.test(history.opponentPulseId)) return { displayName, pulseId: history.opponentPulseId };
  return null;
}

/** One bounded slim read supplies all new history commands. Only formatted
 * summaries are cached; no replay blobs, new collection or upstream requests. */
class ChatStatsService {
  /** @param {{games:import('mongodb').Collection,opponents:import('mongodb').Collection}} db
   * @param {{seasons?:Pick<import('./seasons').SeasonsService,'cachedCurrent'>,now?:()=>number}} [deps] */
  constructor(db, deps = {}) {
    this.db = db; this.seasons = deps.seasons; this.now = deps.now || Date.now;
    this.revisions = new OwnerRevisions();
    /** @type {Map<string,{at:number,summary:ReturnType<ChatStatsService['_summarize']>}>} */ this.cache = new Map();
    /** @type {Map<string,Promise<ReturnType<ChatStatsService['_summarize']>>>} */ this.inflight = new Map();
  }
  /** @param {string} userId */
  invalidateForUser(userId) { this.revisions.invalidate(userId); this.cache.delete(userId); this.inflight.delete(userId); }
  /** @param {string} userId */
  async snapshot(userId) {
    const cached = this.cache.get(userId);
    if (cached && this.now() - cached.at < CACHE_TTL_MS) return cached.summary;
    const pending = this.inflight.get(userId); if (pending) return pending;
    if (this.inflight.size >= 32) throw new Error("chat_stats_busy");
    const revision = this.revisions.get(userId);
    const work = this._read(userId).then(summary => {
      if (this.revisions.current(userId, revision)) {
        this.cache.delete(userId); this.cache.set(userId, { at: this.now(), summary });
        if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value || "");
      }
      return summary;
    }).finally(() => { if (this.inflight.get(userId) === work) this.inflight.delete(userId); });
    this.inflight.set(userId, work); return work;
  }
  /** @param {string} userId */
  async _read(userId) {
    const rows = await this.db.games.find({ userId, ...STATS_GAME_MATCH,
      isResumedFromReplay: { $ne: true }, date: { $lte: new Date(this.now()) },
      $or: [{ playerCount: 2 }, { playerCount: { $exists: false } }],
    }, { projection: { _id: 0, date: 1, result: 1, myRace: 1, myMmr: 1, myToonHandle: 1, map: 1, durationSec: 1,
      "opponent.displayName": 1, "opponent.race": 1, "opponent.toonHandle": 1, "opponent.pulseId": 1, "opponent.pulseCharacterId": 1 }, maxTimeMS: 1500 })
      .sort({ date: -1, _id: -1 }).limit(MAX_ROWS + 1).toArray();
    return this._summarize(rows.slice(0, MAX_ROWS), rows.length > MAX_ROWS);
  }
  /** @param {any[]} rows @param {boolean} partial */
  _summarize(rows, partial) {
    const now = this.now(), startToday = Math.floor(now / DAY_MS) * DAY_MS;
    const oldest = rows.length ? new Date(rows[rows.length - 1].date).getTime() : Infinity;
    const completeSince = (/** @type {number} */ start) => !partial || oldest <= start;
    const today = rows.filter(row => new Date(row.date).getTime() >= startToday);
    const buckets = [...new Set(today.map(row => `${race(row.myRace)}v${race(row.opponent?.race)}`))].sort();
    const recordLine = !completeSince(startToday) ? "Today's record unavailable: history exceeds safety limit." :
      `Today (UTC): ${record(today).wins}W-${record(today).losses}L${buckets.length ? ` | ${buckets.map(key => { const counts = record(today.filter(row => `${race(row.myRace)}v${race(row.opponent?.race)}` === key)); return `${key} ${counts.wins}W-${counts.losses}L`; }).join(" · ")}` : " (no decided games)"}`;
    const latest = rows[0] || null;
    const currentRegion = rows.map(rowRegion).find(Boolean) || null;
    const season = currentRegion ? this.seasons?.cachedCurrent(currentRegion) : null;
    const seasonStart = season?.start ? Date.parse(season.start) : NaN;
    const seasonRows = Number.isFinite(seasonStart) ? rows.filter(row => new Date(row.date).getTime() >= seasonStart && rowRegion(row) === currentRegion) : [];
    const last30 = rows.filter(row => new Date(row.date).getTime() >= now - 30 * DAY_MS);
    /** @type {Record<string,string>} */ const winrates = {};
    for (const key of ["all", "P", "T", "Z", "R", ...["P", "T", "Z", "R"].flatMap(own => ["P", "T", "Z", "R"].map(opp => `${own}v${opp}`))]) {
      const matches = (/** @type {any} */ row) => key === "all" || (key.length === 1 ? race(row.opponent?.race) === key : `${race(row.myRace)}v${race(row.opponent?.race)}` === key);
      const recentText = completeSince(now - 30 * DAY_MS) ? rate(record(last30.filter(matches))) : "unavailable: history exceeds safety limit";
      const seasonText = !season ? "season unavailable: no cached regional boundary" : !completeSince(seasonStart) ? "season unavailable: history exceeds safety limit" : `Season ${season.battlenetId} ${currentRegion}: ${rate(record(seasonRows.filter(matches)))}`;
      winrates[key.toLowerCase()] = `${key === "all" ? "All matchups" : key.length === 1 ? `vs ${key}` : key}: 30 days ${recentText} | ${seasonText}`;
    }
    const decided = rows.map(row => result(row.result)).filter(Boolean);
    const streak = decided[0]; let count = 0; for (const value of decided) { if (value !== streak) break; count += 1; }
    const streakLine = streak ? `Recorded streak: ${count}${streak}${partial && count === decided.length ? "+ (history safety limit)" : ""}.` : "No recorded streak yet.";
    const ranked = seasonRows.filter(row => typeof row.myMmr === "number" && row.myMmr > 0 && Number.isFinite(row.myMmr));
    const peakLine = !season ? "Season peak unavailable: no cached regional boundary." : !completeSince(seasonStart) ? "Season peak unavailable: history exceeds safety limit." : ranked.length ? `Recorded season ${season.battlenetId} peak on ${currentRegion}: ${Math.max(...ranked.map(row => row.myMmr))} MMR (n=${ranked.length} rated games).` : `No recorded rated games in season ${season.battlenetId} on ${currentRegion}.`;
    const duration = latest && Number.isFinite(latest.durationSec) ? ` (${Math.floor(latest.durationSec / 60)}:${String(Math.floor(latest.durationSec % 60)).padStart(2, "0")})` : "";
    const lastgame = latest ? `Last game: ${result(latest.result) === "W" ? "Win" : result(latest.result) === "L" ? "Loss" : "Undecided"} vs ${plainText(latest.opponent?.displayName) || "unknown opponent"} (${race(latest.myRace)}v${race(latest.opponent?.race)}) on ${plainText(latest.map) || "unknown map"}${duration}, ${new Date(latest.date).toISOString().slice(0, 10)} UTC.` : "No recorded games yet.";
    return { record: recordLine, winrates, streak: streakLine, peak: peakLine, lastgame, latestOpponent: latest?.opponent || null };
  }

  /** Exact cached identity only; names never merge different opponents.
   * @param {string} userId @param {any} opponent */
  async h2h(userId, opponent) {
    const field = ["pulseCharacterId", "pulseId", "toonHandle"].find(key => ["string", "number"].includes(typeof opponent?.[key]) && String(opponent[key]).length > 0);
    if (!field) return "Opponent history unavailable: no recorded opponent identity.";
    const value = field === "pulseCharacterId" ? String(opponent[field]) : opponent[field];
    const numberId = field === "pulseCharacterId" && /^\d+$/.test(value) ? Number(value) : NaN;
    const storedValue = Number.isSafeInteger(numberId) ? { $in: [value, numberId] } : value;
    const identity = { userId, [`opponent.${field}`]: storedValue, ...STATS_GAME_MATCH, isResumedFromReplay: { $ne: true },
      date: { $lte: new Date(this.now()) }, $or: [{ playerCount: 2 }, { playerCount: { $exists: false } }] };
    const rows = await this.db.games.find(identity, { projection: { _id: 0, result: 1, date: 1 }, maxTimeMS: 1500 }).sort({ date: -1, _id: -1 }).limit(3).toArray();
    const cached = await this.db.opponents.findOne({ userId, [field]: value }, { projection: { _id: 0, wins: 1, losses: 1 }, maxTimeMS: 1000 });
    const totals = cached ? `${Number(cached.wins) || 0}W-${Number(cached.losses) || 0}L recorded` : "total record unavailable";
    return `${plainText(opponent.displayName || opponent.name) || "Opponent"}: ${totals} | Last ${rows.length} meetings: ${rows.map(row => `${result(row.result) || "?"} ${new Date(row.date).toISOString().slice(0, 10)}`).join(", ") || "none"}.`;
  }
}

module.exports = { ChatStatsService, result, liveOpponentIdentity, MAX_ROWS, CACHE_TTL_MS };
