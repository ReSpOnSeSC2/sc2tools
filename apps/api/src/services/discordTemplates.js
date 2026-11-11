"use strict";

/**
 * Discord webhook message bodies (embeds). Pure functions of already
 * owner-scoped data plus the hook's options:
 *
 *   opponentNames  false by default: no opponent name unless turned on
 *   mmr            true by default: MMR and its change
 *   replayLink     false by default, and only with public replay sharing
 *
 * ``allowed_mentions: {parse: []}`` stops any text (custom build names,
 * labels) from pinging a server. User text is markdown-escaped and cut to
 * Discord's field limits.
 */

const SITE = "https://sc2tools.com";
const COLORS = { win: 0x2fbf71, loss: 0xe5484d, neutral: 0x7c8a9a, brand: 0x3aa7ff };
const DEFAULT_OPTIONS = Object.freeze({ opponentNames: false, mmr: true, replayLink: false });

/** Markdown-escaped, single-line, bounded. @param {unknown} value @param {number} [max] */
function md(value, max = 100) {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
  return text.replace(/([\\*_~`|>[\]()#@])/g, "\\$1");
}

/** @param {unknown} race */
function letter(race) {
  const value = typeof race === "string" ? race.trim().charAt(0).toUpperCase() : "";
  return ["P", "T", "Z", "R"].includes(value) ? value : "?";
}

/** @param {number|null|undefined} seconds */
function clock(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** @param {number} value */
const num = (value) => Math.round(value).toLocaleString("en-US");
/** @param {number} delta */
const signed = (delta) => `${delta >= 0 ? "+" : "−"}${num(Math.abs(delta))}`;

/** @param {{wins: number, losses: number}} r */
const wl = (r) => `${r.wins}–${r.losses}`;

/** @param {Record<string, unknown>[]} embeds */
function message(embeds) {
  return { username: "SC2 Tools", allowed_mentions: { parse: [] }, embeds };
}

/** @param {unknown} options */
function hookOptions(options) {
  const value = /** @type {Record<string, unknown>} */ (options && typeof options === "object" ? options : {});
  return {
    opponentNames: value.opponentNames === true,
    mmr: value.mmr !== false,
    replayLink: value.replayLink === true,
  };
}

/**
 * One ranked result.
 * @param {any} game slim games row
 * @param {{options?: unknown, mmrDelta?: number|null, replaySlug?: string|null}} ctx
 */
function resultMessage(game, ctx) {
  const options = hookOptions(ctx.options);
  const outcome = game.result === "Victory" ? "win" : game.result === "Defeat" ? "loss" : "neutral";
  const matchup = `${letter(game.myRace)}v${letter(game.opponent?.race)}`;
  const fields = [];
  if (game.myBuild) fields.push({ name: "Build", value: md(game.myBuild, 80) || "—", inline: true });
  const opponent = [options.opponentNames && game.opponent?.displayName ? md(game.opponent.displayName, 40) : null,
    md(game.opponent?.race, 12) || null, typeof game.opponent?.mmr === "number" && options.mmr ? `${num(game.opponent.mmr)} MMR` : null].filter(Boolean);
  if (opponent.length) fields.push({ name: "Opponent", value: opponent.join(" · "), inline: true });
  if (options.mmr && typeof game.myMmr === "number") {
    const delta = typeof ctx.mmrDelta === "number" && ctx.mmrDelta !== 0 ? ` (${signed(ctx.mmrDelta)})` : "";
    fields.push({ name: "MMR", value: `${num(game.myMmr)}${delta}`, inline: true });
  }
  const length = clock(game.durationSec);
  if (length) fields.push({ name: "Length", value: length, inline: true });
  const url = options.replayLink && ctx.replaySlug && typeof game.gameId === "string"
    ? `${SITE}/p/${encodeURIComponent(ctx.replaySlug)}/replays/${encodeURIComponent(game.gameId)}` : undefined;
  const label = outcome === "win" ? "Victory" : outcome === "loss" ? "Defeat" : "Tie";
  return message([{ title: `${label} · ${matchup} on ${md(game.map, 60) || "Unknown map"}`, color: COLORS[outcome], fields,
    ...(url ? { url } : {}), ...(game.date ? { timestamp: new Date(game.date).toISOString() } : {}), footer: { text: "SC2 Tools" } }]);
}

/**
 * A play session that just ended (sessions gap).
 * @param {{games: number, wins: number, losses: number, hours: number, matchups: {name: string, wins: number, losses: number}[],
 *   mmr: {start: number, end: number, delta: number, games: number}|null, endAt: Date}} session
 * @param {{options?: unknown}} ctx
 */
function sessionMessage(session, ctx) {
  const options = hookOptions(ctx.options);
  const fields = [{ name: "Record", value: `${wl(session)} in ${session.games} game${session.games === 1 ? "" : "s"}`, inline: true },
    { name: "Time played", value: `${session.hours} h`, inline: true }];
  if (options.mmr && session.mmr && session.mmr.games >= 2) fields.push({ name: "MMR", value: `${num(session.mmr.start)} → ${num(session.mmr.end)} (${signed(session.mmr.delta)})`, inline: true });
  const matchups = session.matchups.slice(0, 6).map((row) => `${row.name} ${wl(row)}`).join(" · ");
  if (matchups) fields.push({ name: "Matchups", value: matchups, inline: false });
  return message([{ title: "Session summary", color: COLORS.brand, fields, timestamp: new Date(session.endAt).toISOString(), footer: { text: "SC2 Tools" } }]);
}

/** Weekly recap from a services/weeklyReport.js report. @param {any} report @param {{options?: unknown}} ctx */
function weeklyMessage(report, ctx) {
  const options = hookOptions(ctx.options);
  const t = report.totals;
  const fields = [{ name: "Record", value: `${wl(t)} in ${t.games} games`, inline: true },
    { name: "Time played", value: `${t.hours} h · ${t.sessions} session${t.sessions === 1 ? "" : "s"}`, inline: true }];
  const mmr = report.mmr?.[0];
  if (options.mmr && mmr && mmr.games >= 2) fields.push({ name: "MMR", value: `${num(mmr.start)} → ${num(mmr.end)} (${signed(mmr.delta)})`, inline: true });
  if (report.maps?.best) fields.push({ name: "Best map", value: `${md(report.maps.best.name, 60)} ${wl(report.maps.best)}`, inline: true });
  if (report.builds?.best) fields.push({ name: "Best build", value: `${md(report.builds.best.name, 60)} ${wl(report.builds.best)}`, inline: true });
  const matchups = (report.matchups || []).slice(0, 6).map((/** @type {any} */ row) => `${row.matchup} ${wl(row)}`).join(" · ");
  if (matchups) fields.push({ name: "Matchups", value: matchups, inline: false });
  return message([{ title: `Week ${Number(String(report.week).slice(6))} recap`, color: COLORS.brand, fields, footer: { text: "SC2 Tools" } }]);
}

/** New MMR peak for one account and race. @param {{mmr: number, previousPeak: number, race: string}} milestone @param {{options?: unknown}} ctx */
function milestoneMessage(milestone, ctx) {
  const options = hookOptions(ctx.options);
  const value = options.mmr ? `${num(milestone.mmr)} MMR (previous best ${num(milestone.previousPeak)})` : "A new personal best rating.";
  return message([{ title: `New ${md(milestone.race, 12) || ""} MMR peak`.replace(/\s+/g, " "), color: COLORS.win, description: value, footer: { text: "SC2 Tools" } }]);
}

/** @param {{previous:string,current:string,race:string,mmr?:number}} milestone @param {{options?:unknown}} ctx */
function promotionMessage(milestone, ctx) {
  const options = hookOptions(ctx.options);
  const fields = options.mmr && Number.isFinite(milestone.mmr) && Number(milestone.mmr) > 0
    ? [{ name: "MMR", value: num(Number(milestone.mmr)), inline: true }] : [];
  return message([{ title: `Promotion · ${md(milestone.current, 24)}`, color: COLORS.win,
    description: `${md(milestone.previous, 24)} → ${md(milestone.current, 24)} · ${md(milestone.race, 12)}`, fields, footer: { text: "SC2 Tools" } }]);
}

function testMessage() {
  return message([{ title: "SC2 Tools is connected", color: COLORS.brand,
    description: "This channel will receive the posts you turned on in SC2 Tools. Opponent names stay hidden unless you allow them.", footer: { text: "SC2 Tools" } }]);
}

/**
 * Redacted result excerpt from the owner's shared battle report.
 * @param {{headline: string, paragraph: string, token: string, result: unknown}} report
 */
function battleReportMessage(report) {
  const color = report.result === "Victory" ? COLORS.win : report.result === "Defeat" ? COLORS.loss : COLORS.neutral;
  return message([{ title: md(report.headline, 120), description: md(report.paragraph, 750), color,
    url: `${SITE}/g/${encodeURIComponent(report.token)}#battle-report`, footer: { text: "SC2 Tools · Battle report" } }]);
}

module.exports = { resultMessage, sessionMessage, weeklyMessage, milestoneMessage, promotionMessage, testMessage, battleReportMessage, hookOptions, md, DEFAULT_OPTIONS };
