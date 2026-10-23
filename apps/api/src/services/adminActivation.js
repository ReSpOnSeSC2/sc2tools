"use strict";
const WEEK = 7 * 86400000;
/** Bounded first-party cohorts; no consent-gated analytics or anonymous matching. */
class AdminActivationService {
  /** @param {{db:any,now?:()=>number}} deps */
  constructor(deps) { this.db = deps.db; this.now = deps.now || Date.now; /** @type {Map<number,any>} */ this.cache = new Map(); }
  /** @param {number} [rawWeeks] */
  snapshot(rawWeeks = 8) {
    const weeks = Math.max(1, Math.min(26, Math.floor(Number(rawWeeks) || 8)));
    const cached = this.cache.get(weeks);
    if (cached && this.now() - cached.at < 3600000) return cached.value;
    const value = this.calculate(weeks).catch((error) => { this.cache.delete(weeks); throw error; });
    this.cache.set(weeks, { at: this.now(), value }); return value;
  }
  /** @param {number} weeks */
  async calculate(weeks) {
    const since = weekStart(this.now() - (weeks - 1) * WEEK);
    const users = await this.db.users.find({ createdAt: { $gte: since } }, { projection: { _id: 0, userId: 1, email: 1, createdAt: 1, activation: 1 } }).sort({ createdAt: -1, userId: 1 }).limit(2001).toArray();
    const sampled = users.slice(0,2000), ids = sampled.map((/** @type {any} */ u) => u.userId);
    const signups = sampled.map((/** @type {any} */ u) => u.createdAt);
    const [games, devices] = await Promise.all([
      this.db.games.aggregate([{ $match: { userId: { $in: ids } } }, { $set: { signup: { $arrayElemAt: [signups, { $indexOfArray: [ids, "$userId"] }] } } }, { $group: { _id: "$userId", week2Return: { $max: { $and: [{ $gte: ["$createdAt", { $add: ["$signup", WEEK] }] }, { $lt: ["$createdAt", { $add: ["$signup", 2 * WEEK] }] }] } }, games: { $sum: 1 }, firstGame: { $min: "$createdAt" }, lastGame: { $max: "$createdAt" } } }]).toArray(),
      this.db.deviceTokens.aggregate([{ $match: { userId: { $in: ids } } }, { $group: { _id: "$userId", pairedAt: { $min: "$createdAt" }, lastSeenAt: { $max: "$lastSeenAt" } } }]).toArray(),
    ]);
    return buildCohorts(sampled, games, devices, { since, weeks, now: this.now(), truncated: users.length > 2000 });
  }
}
/** @param {number} time */
function weekStart(time) { const date = new Date(time); date.setUTCHours(0,0,0,0); date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7); return date; }
/** @param {number[]} values */
function median(values) { if (!values.length) return null; values.sort((a,b)=>a-b); const mid = Math.floor(values.length / 2); return values.length % 2 ? values[mid] : (values[mid-1]+values[mid])/2; }
/** @param {any[]} users @param {any[]} games @param {any[]} devices @param {{since:Date,weeks:number,now:number,truncated:boolean}} options */
function buildCohorts(users, games, devices, options) {
  const byGames = new Map(games.map((g)=>[g._id,g])), byDevice = new Map(devices.map((d)=>[d._id,d]));
  /** @type {Array<any>} */
  const rows = Array.from({length:options.weeks},(_,i)=>({ week: new Date(+options.since+i*WEEK).toISOString().slice(0,10), signups:0, downloaded:0, paired:0, firstGame:0, tenGames:0, week2Return:0, week2Eligible:0, pairHours:[], gameHours:[] }));
  const stalled = [];
  for (const user of users) {
    const signup = +new Date(user.createdAt), index = Math.floor((+weekStart(signup) - +options.since) / WEEK), row = rows[index];
    if (!row) continue;
    const game = byGames.get(user.userId), device = byDevice.get(user.userId), paired = device?.pairedAt ? +new Date(device.pairedAt) : null;
    const first = game?.firstGame ? +new Date(game.firstGame) : null, latest = Math.max(+new Date(game?.lastGame || 0),+new Date(device?.lastSeenAt || 0));
    row.signups++; if (user.activation?.downloadedAt) row.downloaded++;
    if (paired !== null) { row.paired++; if(paired>=signup) row.pairHours.push((paired-signup)/3600000); }
    if (game?.games > 0) { row.firstGame++; if(first!==null&&first>=signup) row.gameHours.push((first-signup)/3600000); }
    if (game?.games>=10) row.tenGames++;
    if (options.now>=signup+2*WEEK) { row.week2Eligible++; if(user.activation?.week2ReturnAt || game?.week2Return || latest>=signup+WEEK&&latest<signup+2*WEEK) row.week2Return++; }
    if (options.now-signup>=86400000 && (!device || !game?.games)) stalled.push({userId:user.userId,email:user.email||null,createdAt:user.createdAt,stage:!device?"not_paired":"no_games"});
  }
  return { cohorts: rows.map(({pairHours,gameHours,...row})=>({...row,medianHoursToPair:median(pairHours),medianHoursToFirstGame:median(gameHours)})), stalled:stalled.slice(0,50), cohortCap:2000,truncated:options.truncated,
    downloadAttribution:"Authenticated installer hand-offs only; historical anonymous downloads cannot be assigned to a signup.", generatedAt:new Date(options.now) };
}
module.exports = { AdminActivationService, buildCohorts, weekStart };
