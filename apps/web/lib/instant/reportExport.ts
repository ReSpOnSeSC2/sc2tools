/**
 * Keep the /try report without an account: the games as a CSV file and a
 * plain-text summary for Discord or Reddit. Both run in the browser on
 * the report already on screen (the filtered games when filters are on).
 *
 * - gamesToCsv: RFC 4180 quoting, CRLF rows, a UTF-8 byte-order mark so
 *   Excel reads accents, and a leading `'` on any cell that starts with
 *   = + - @ (or a tab / CR) so a spreadsheet never runs it as a formula.
 *   It is the visitor's own private export, so opponent names stay in it.
 * - reportSummaryText: totals, W-L per matchup, top openers and the active
 *   filters. It never contains an opponent name: it is meant for posting.
 *   The share dialog passes its selected-row model, so the dialog's
 *   "Copy text" and "Copy summary" come from this one builder.
 *
 * Light on purpose (types only from reportSharing): /try loads it with
 * the report, while the build catalog stays behind the share dialog.
 *
 * Example:
 *   downloadGamesCsv(report.games, new Date());
 *   reportSummaryText(report, filters); // -> "SC2 Tools /try report: 23 games, 14-9 (61%)\n…"
 */
import type { InstantReport } from "./report";
import type { ReportGame } from "./reportGames";
import { DEFAULT_REPORT_FILTERS, reportFilterLabel, type ReportFilters } from "./reportFilters";
import type { ReportCardModel } from "./reportSharing";

export const REPORT_SHARE_URL = "https://sc2tools.com/try?utm_source=report&utm_medium=share&utm_campaign=instant";

export const CSV_COLUMNS = [
  "date", "map", "matchup", "result", "opponent", "opponent_race",
  "my_mmr_pre", "opp_mmr_pre", "duration_sec", "duration", "my_opener", "opp_opener",
] as const;

/** U+FEFF, written as a code point so no editor can drop or mangle it. */
export const CSV_BOM = String.fromCharCode(0xfeff);
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;
/** Top openers listed in the text summary. */
export const SUMMARY_TOP_OPENERS = 3;

type CsvValue = string | number | null | undefined;

/**
 * One CSV cell: formula-safe, then quoted when it holds a comma, quote or
 * line break (inner quotes doubled).
 *
 * Example:
 *   csvCell('=HYPERLINK("x")'); // -> "\"'=HYPERLINK(\"\"x\"\")\""
 */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** "7:05" for 425 s; "" when unknown. */
export function clockLabel(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "";
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function isoDate(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

function resultWord(game: ReportGame): string {
  if (game.outcome === "W") return "Win";
  if (game.outcome === "L") return "Loss";
  return game.payload.result?.trim() || "";
}

function gameRow(game: ReportGame): CsvValue[] {
  const { payload } = game;
  return [
    isoDate(game.date), game.map, game.matchup, resultWord(game), game.opponentName,
    payload.opponent?.race ?? null, game.mmr?.my ?? null, game.mmr?.opp ?? null,
    game.durationSec === null ? null : Math.round(game.durationSec), clockLabel(game.durationSec),
    payload.myBuild, payload.opponent?.strategy ?? null,
  ];
}

/**
 * The games as a CSV document (BOM + header + one CRLF-terminated row each).
 *
 * Example:
 *   gamesToCsv([]).split("\r\n")[0]; // -> "<BOM>date,map,matchup,…"
 */
export function gamesToCsv(games: ReadonlyArray<ReportGame>): string {
  const lines = [CSV_COLUMNS.join(","), ...games.map((game) => gameRow(game).map(csvCell).join(","))];
  return `${CSV_BOM}${lines.join("\r\n")}\r\n`;
}

/** sc2tools-try-games-YYYY-MM-DD.csv, by the visitor's local date. */
export function csvFilename(now: Date): string {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return `sc2tools-try-games-${day}.csv`;
}

/** Save the CSV through a temporary object URL (revoked right after). */
export function downloadGamesCsv(games: ReadonlyArray<ReportGame>, now: Date = new Date()): void {
  const url = URL.createObjectURL(new Blob([gamesToCsv(games)], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = csvFilename(now);
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function record(wins: number, losses: number): string {
  const decided = wins + losses;
  return decided > 0 ? `${wins}-${losses} (${Math.round((wins / decided) * 100)}%)` : `${wins}-${losses}`;
}

/** Lower-cased opponent names in the report, so no listed label can carry one. */
function opponentNames(report: InstantReport): string[] {
  return [...new Set(report.games.map((game) => game.opponentName?.trim().toLowerCase() ?? "").filter((name) => name.length > 1))];
}

function topOpeners(report: InstantReport): string | null {
  const names = opponentNames(report);
  const rows = (report.openers ?? [])
    .filter((row) => !names.some((name) => row.name.toLowerCase().includes(name)))
    .slice(0, SUMMARY_TOP_OPENERS);
  return rows.length > 0 ? `Top openers: ${rows.map((row) => `${row.name} ${record(row.wins, row.losses)}`).join(", ")}` : null;
}

function summaryFromReport(report: InstantReport): string[] {
  const { games, wins, losses } = report.totals;
  return [
    `SC2 Tools /try report: ${games} ${games === 1 ? "game" : "games"}, ${record(wins, losses)}`,
    ...(report.recordByMatchup ?? []).map((row) => `vs ${row.oppRace}: ${record(row.wins, row.losses)}`),
    topOpeners(report),
  ].filter((line): line is string => line !== null);
}

function summaryFromModel(model: ReportCardModel): string[] {
  const totals = model.totals;
  return [
    totals ? `SC2 Tools /try report: ${totals.games} ${totals.games === 1 ? "game" : "games"}, ${record(totals.wins, totals.losses)}` : "SC2 Tools /try report",
    ...model.matchups.map((row) => `${row.label}: ${record(row.wins, row.losses)}`),
    model.opener ? `Best opener: ${model.opener.name} ${record(model.opener.wins, model.opener.losses)} over ${model.opener.games} games` : null,
    model.macro ? `Macro score: ${model.macro.score}/100 over ${model.macro.games} measured games` : null,
  ].filter((line): line is string => line !== null);
}

/**
 * Plain-text summary of the report (opponent-free). With `model` (the
 * share dialog's selected rows) it prints exactly those rows.
 *
 * Example:
 *   reportSummaryText(report, { matchup: "Z", result: "all", recency: "25" });
 *   // -> "SC2 Tools /try report: 8 games, 5-3 (63%)\nvs Z: 5-3 (63%)\n…\nFiltered: vs Z · last 25 games\nhttps://sc2tools.com/try?…"
 */
export function reportSummaryText(
  report: InstantReport,
  filters: ReportFilters = DEFAULT_REPORT_FILTERS,
  model?: ReportCardModel,
): string {
  const note = reportFilterLabel(filters);
  return [...(model ? summaryFromModel(model) : summaryFromReport(report)), note ? `Filtered: ${note}` : null, REPORT_SHARE_URL]
    .filter((line): line is string => line !== null)
    .join("\n");
}
