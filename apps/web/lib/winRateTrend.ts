/** Counts from one complete API period. `games` may include unknown outcomes. */
export type WinRatePeriod = {
  date: string;
  wins: number;
  losses: number;
  games: number;
};

export type WinRateTrendPoint = WinRatePeriod & {
  sampleWins: number;
  sampleLosses: number;
  sampleGames: number;
  sampleStart: string | null;
  /** Percentage, withheld until the sample is ready and this period has games. */
  rate: number | null;
  ready: boolean;
};

export type WinRateTrend = {
  targetGames: number;
  points: WinRateTrendPoint[];
  overall: { wins: number; losses: number; games: number; rate: number | null };
  /** The last period with games, including when its sample is still too small. */
  latest: WinRateTrendPoint | null;
  readyPoints: number;
};

function wholeCount(value: number): number {
  return Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER)
    : 0;
}

/** Date keys already describe calendar days in the API's requested timezone. */
function calendarDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    ? date
    : null;
}

/**
 * Game-weighted form over a minimum number of games, ending at each period.
 * Include the smallest trailing set of WHOLE played periods meeting the target:
 * aggregate data cannot reveal which games were played first inside a period.
 * Consequently samples can exceed the target. Empty days never extend the trace.
 *
 * Invalid dates are omitted. Counts are made non-negative whole numbers and
 * impossible outcome counts are capped to the period's declared total. Unknown
 * outcomes remain in the API denominator; losses are never inferred from wins.
 */
export function buildWinRateTrend(
  periods: readonly WinRatePeriod[],
  targetGames: number,
): WinRateTrend {
  const target = Number.isFinite(targetGames) && targetGames > 0
    ? Math.min(Math.ceil(targetGames), Number.MAX_SAFE_INTEGER)
    : 20;
  const byDate = new Map<string, WinRatePeriod>();
  for (const period of periods) {
    if (!calendarDate(period.date)) continue;
    const games = wholeCount(period.games);
    const wins = Math.min(wholeCount(period.wins), games);
    const losses = Math.min(wholeCount(period.losses), games - wins);
    const existing = byDate.get(period.date);
    if (existing) {
      existing.games += games;
      existing.wins += wins;
      existing.losses += losses;
    } else {
      byDate.set(period.date, { date: period.date, wins, losses, games });
    }
  }
  const ordered = [...byDate.values()].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const played: WinRatePeriod[] = [];
  const points: WinRateTrendPoint[] = [];
  const overall: WinRateTrend["overall"] = { wins: 0, losses: 0, games: 0, rate: null };
  let sampleWins = 0;
  let sampleLosses = 0;
  let sampleGames = 0;
  let start = 0;
  let latest: WinRateTrendPoint | null = null;
  let readyPoints = 0;

  for (const period of ordered) {
    overall.games += period.games;
    overall.wins += period.wins;
    overall.losses += period.losses;
    if (period.games > 0) {
      played.push(period);
      sampleWins += period.wins;
      sampleLosses += period.losses;
      sampleGames += period.games;
      while (start < played.length && sampleGames - played[start].games >= target) {
        const oldest = played[start++];
        sampleWins -= oldest.wins;
        sampleLosses -= oldest.losses;
        sampleGames -= oldest.games;
      }
    }

    const ready = period.games > 0 && sampleGames >= target;
    const point: WinRateTrendPoint = {
      ...period,
      sampleWins,
      sampleLosses,
      sampleGames,
      sampleStart: played[start]?.date ?? null,
      rate: ready ? (sampleWins / sampleGames) * 100 : null,
      ready,
    };
    points.push(point);
    if (period.games > 0) latest = point;
    if (ready) readyPoints += 1;
  }

  overall.rate = overall.games > 0 ? (overall.wins / overall.games) * 100 : null;
  return { targetGames: target, points, overall, latest, readyPoints };
}

const compactDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const compactDateWithYear = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Compact calendar-date label, without shifting date-only values across zones. */
export function formatTrendDate(value: string, includeYear = false): string {
  const date = calendarDate(value);
  return date ? (includeYear ? compactDateWithYear : compactDate).format(date) : "—";
}
