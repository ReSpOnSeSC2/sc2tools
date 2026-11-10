/**
 * Weekly and stream report shapes (API: /v1/reports/*) and the small,
 * factual formatters the report pages and the "Copy Discord summary"
 * button share. No text here explains a result; it states counts.
 */

export type WinLoss = { games: number; wins: number; losses: number };
export type NamedRecord = WinLoss & { name: string };
export type MacroFacts = { average: number | null; games: number; topLeak: { name: string; games: number } | null };
export type MmrRow = { account: string; race: string; games: number; start: number; end: number; peak: number; delta: number };

export type WeeklyReport = {
  week: string; previousWeek: string; timeZone: string; start: string; end: string;
  totals: WinLoss & { hours: number; sessions: number; previous: WinLoss & { hours: number; sessions: number } };
  matchups: Array<WinLoss & { matchup: string; previous: WinLoss }>;
  mmr: MmrRow[];
  maps: { best: NamedRecord | null; worst: NamedRecord | null; minDecided: number };
  builds: { best: NamedRecord | null; worst: NamedRecord | null; minDecided: number };
  opponentStrategies: NamedRecord[];
  macro: MacroFacts & { previous: MacroFacts; minGames: number };
  truncated: boolean;
  navigation: { previous: string | null; next: string | null; current: string };
};

export type StreamSummary = { id: string; startAt: string; endAt: string; games: number; wins: number; losses: number; hours: number; mmrDelta: number | null; endedBy: string };
export type StreamReport = WinLoss & {
  streamId: string; startAt: string; endAt: string; endedBy: "manual" | "idle" | "restart"; hours: number;
  matchups: NamedRecord[]; maps: NamedRecord[]; builds: NamedRecord[];
  mmr: (MmrRow & { points: number[] }) | null;
  bestWin: { gameId: string; map: string | null; matchup: string; opponentMmr: number; durationSec: number | null } | null;
  randomizer: WinLoss | null;
  crystalBall: { rounds: number; picks: number; correct: number; viewers: number; accuracy: number | null } | null;
  supporters: { events: number; viewers: number } | null;
  clips: Array<{ minute: number; kind: "chat-spike" | "game-event"; reason: string }>;
};

const WEEK_RE = /^(\d{4})-W(\d{2})$/;

/** "Week 46, 2026"; anything unexpected is shown as-is. */
export function weekLabel(week: string): string {
  const match = WEEK_RE.exec(week);
  return match ? `Week ${Number(match[2])}, ${match[1]}` : week;
}

/** Wins over decided games, or null with nothing decided. */
export function winRate(record: WinLoss): number | null {
  const decided = record.wins + record.losses;
  return decided > 0 ? record.wins / decided : null;
}

export function record(record: WinLoss): string {
  return `${record.wins}–${record.losses}`;
}

export function signed(delta: number): string {
  return `${delta >= 0 ? "+" : "−"}${Math.abs(Math.round(delta))}`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The API's time zone parameter, from this browser. */
export function browserTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/**
 * Plain text for pasting into Discord. Counts and the streamer's own
 * builds and maps only: no opponent names, no viewer names, no clip
 * notes (those can quote chat).
 */
export function streamDiscordSummary(report: StreamReport, dateLabel: string): string {
  const lines = [`**Stream recap — ${dateLabel}**`, `${plural(report.games, "game")} · ${record(report)} · ${report.hours} h`];
  if (report.mmr && report.mmr.games >= 2) lines.push(`MMR ${report.mmr.start} → ${report.mmr.end} (${signed(report.mmr.delta)}), peak ${report.mmr.peak}`);
  if (report.matchups.length) lines.push(`Matchups: ${report.matchups.map((row) => `${row.name} ${record(row)}`).join(" · ")}`);
  if (report.bestWin) lines.push(`Best win: ${report.bestWin.matchup}${report.bestWin.map ? ` on ${report.bestWin.map}` : ""} vs ${report.bestWin.opponentMmr} MMR`);
  if (report.builds.length) lines.push(`Builds: ${report.builds.slice(0, 3).map((row) => `${row.name} ${record(row)}`).join(" · ")}`);
  if (report.crystalBall && report.crystalBall.accuracy !== null) lines.push(`Crystal Ball: chat called ${report.crystalBall.accuracy}% of ${plural(report.crystalBall.picks, "pick")} right`);
  return lines.join("\n").replace(/@/g, "@\u200b");
}
